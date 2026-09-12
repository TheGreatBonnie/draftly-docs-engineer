# PR Workflow Error Hardening — Design

## Goal

Fix the failure cascade observed in the 2026-09-12 `github_pr.enqueue` run for
`TheGreatBonnie/authly` PR #10 (`run_id=3df78320-ae94-11f1-8d6a-378ba09d2555`)
so the workflow degrades gracefully instead of aborting delivery. Root causes:

1. **Single-provider capability SPOF** — `verification` and `evaluation`
   capabilities exist only on requesty models; a requesty 402 disables the
   provider and leaves *no* candidate model, so the rubric grader /
   documentation reviewer traceback (`rubric_grader_failed`,
   `changelog_rubric_grader_failed`, `role_routing_offline`).
2. **Slack search uses the wrong token** — `search_messages` sends the
   env `SLACK_BOT_TOKEN` (bot token without `search:read`), so the Slack
   researcher gets `not_allowed_token_type` on every query.
3. **Grounding-blind writer tools** — git/file tools are composed for writers
   even under GITHUB grounding, where there is no checkout, producing
   `git_call_error: fatal: not a git repository`.
4. **Missing idempotency metadata** — DELIVERY-role side-effecting tools
   require an `idempotency_key` that tool schemas never supply, tripping a
   durable `pending_intervention` at the `deliver` node; `review.resume`
   then fails expecting status `delivered`.

The ~13-minute silent gap (10:30:24–10:43:31) is **out of scope** for this
spec (deferred by user decision).

## Decisions

1. **Requesty keep "specific", fix the degrade path.** Enable Requesty
   auto-top-up/budget alerting (ops). Register additional non-requesty
   `verification`/`evaluation`-capable models so `_failover` has a real
   candidate — but make the guarantee that **"no candidate ⇒ deterministic
   no-op grader, not a traceback"** hold regardless. The rubric grader is
   enrichment-only; the deterministic gate stays the pass/fail signal.
2. **Slack search resolves the per-team installation bot token**, mirroring
   `send_message`; the workspace's install is the source of truth, and
   failure keeps the researcher's proven graceful-degradation behavior.
3. **Tool composition is grounding-aware**: local → git/fs tools;
   github → GitHub API tools; docs → search/doc tools. No composed tool is
   guaranteed usable for an unavailable grounding, so per-surface filtering
   is the contract; agents are still steered when they try an out-of-scope
   tool.
4. **Idempotency is injected, not requested.** The steering handler stamps a
   deterministic `metadata.idempotency_key` before policy evaluation so
   side-effecting calls pass `delivery:idempotency` and any resume/retry of
   the same tool call is durably idempotent. Tool schemas stay unchanged.

Scope is the single PR workflow; the changes touch shared components
(routing, grading, Slack client, tool composition, steering) so they heal the
issue (`issue_graph.py`) and support (`support_graph.py`) surfaces too.

## How other agents handle the requesty error (evidence)

| Level | Mechanism | 2026-09-12 outcome |
|-------|-----------|--------------------|
| Router failover | `PaymentAwareModel._failover` (`integrations/strands/models.py:172`): disable provider health, `router.route()`, swap inner model, retry once | Worked for `context`, `research`, `github_intelligence` (`model_failover_resolved provider=orcarouter`) |
| Build-time degrade | `RoleAwareModelResolver.for_role_with_decision` returns `(None, None)` on `NoCandidateError` | Worked — `role_routing_offline` is a warning, graph still builds |
| Judgment degrade | Steering judge → deterministic policy on model failure | Worked as designed (`steering_judge_fallback`) |
| Agent behave degrade | Slack researcher retried 8 queries, reported the blockage, continued | Worked — swarm survived |

**Where it breaks.** `verification`/`evaluation` requests route to requesty
models only (`factory.py:174-261`). A 402 disables requesty for the rest of
the worker process; every later resolve for those roles returns `(None, None)`
(seen again at `review.resume`, `role_routing_offline`). The rubric grader
builders (`rubric_grader.py:82-117`) then construct `OutputEvaluator(model=None)`
and explode at grade time; `EvaluatorNode.__init__` also hard-requires a grader
(`evaluate.py:212-217`). The reviewers behaved exactly like every other agent —
they just have no spare candidate.

## Architecture

### Fix A — Reviewer/grader degrade on no candidate

- `rubric_grader.py`: add a deterministic no-op grader (returns
  `RubricGrade()` immediately). `build_docs_rubric_grader(model, rubric)` and
  `build_changelog_rubric_grader(model)` return it when `model is None`.
- `evaluate.py:212`: `EvaluatorNode` accepts the no-op grader (drop the
  "mandatory concrete grader" TypeError; keep requiring *a* grader).
- `documentation_graph.py:149`, `issue_graph.py:87`, `support_graph.py:119`:
  unchanged call sites — they already pass a possibly-`None` model from
  `resolve_model_for_role`.
- `models/factory.py`: register additional `verification`/`evaluation`-capable
  models on non-requesty providers, mirroring the requesty stage models:
  - `review-orca` (provider `orcarouter`, `model_id` from `REVIEW_MODEL`
    env, capabilities `("verification", "tool_calling")`, priority ~40)
  - `grader-orca` (provider `orcarouter`, `model_id` from
    `RUBRIC_GRADER_MODEL` env, capabilities `("evaluation", "tool_calling")`,
    priority ~40)
  `FALLBACKS` already lists all providers for `verification`/`evaluation`, so
  this widens the candidate pool without touching chain ordering. Exact model
  IDs default to the orca v4-flash entries already proven in the registry.
- Ops: Requesty auto top-up + budget alert.

### Fix B — Slack search installation token

- `integrations/slack/client.py`: `search_messages(query, *, channel_id, team_id, limit)`
  — resolve the team installation token (`_resolve_installation_token(team_id)`)
  before `search.messages`; fall back to `auth`/env only when `team_id` is
  absent (preserving the single-tenant path).
- `tools/slack/search_messages.py`: accept and forward `team_id`.
- `agents/shared/research.py` `build_slack_researcher`: no signature change —
  the tool simply carries `team_id` from the runtime/org context where
  available. If unavailable, the researcher's existing graceful degradation
  (empty evidence, blocked reason) still applies.

### Fix C — Grounding-aware writer tools

- `app/composition/tools.py`: gate writer-tool assembly on the effective
  grounding mode (from `resolve_grounding`, `grounding.py:52-75`):
  - LOCAL → `git_status`/`git_diff`/`git_log`/`read_file`/`write_file`/
    `list_directory`/`file_exists` + fs tools;
  - GITHUB → GitHub API tools only (`get_file_content`, `create_branch`,
    `create_commit`, `create_pull_request`, ...) — no local git/fs tools;
  - DOCS → search/doc tools.
- `grounding.py`: expose the resolved mode on the composition context (a small
  accessor/dataclass) so `tools.py` can branch without re-resolving.

### Fix D — Deterministic idempotency injector

- `steering/handler.py:264` `steer_before_tool`: before
  `policy.evaluate_tool_async`, if `tool_use` lacks `idempotency_key` in
  `metadata`, stamp:
  `sha256(f"{org_id}|{run_id}|{tool_name}|{json.dumps(input, sort_keys=True)}")`
  (both stable and unique per call). Guarded so tool uses that already carry a
  key are untouched.
- No change to `policy.py:_check_idempotency`, tool schemas, or DELIVERY tool
  definitions.

## Files touched

| File | Change |
|------|--------|
| `src/draftly/orchestration/nodes/rubric_grader.py` | no-op grader; None-model guards in both builders (A) |
| `src/draftly/orchestration/nodes/evaluate.py` | accept no-op grader (A) |
| `src/draftly/models/factory.py` | register non-requesty `verification`/`evaluation` models (A) |
| `src/draftly/integrations/slack/client.py` | install-token resolve in `search_messages` (B) |
| `src/draftly/tools/slack/search_messages.py` | forward `team_id` (B) |
| `src/draftly/grounding.py` | expose resolved grounding mode to composition (C) |
| `src/draftly/app/composition/tools.py` | grounding-aware filter for writer tools (C) |
| `src/draftly/steering/handler.py` | deterministic idempotency injector (D) |
| Plans | implementation plan via writing-plans after this spec approves |

## Error handling

- No-candidate grading never raises: deterministic `RubricGrade()` is the
  contract, matching `evaluate.py`'s existing "exceptions degrade to the
  deterministic verdict".
- Slack search: missing installation keeps the agent's graceful degradation;
  the wrong-token `RuntimeError` is replaced entirely by correct resolution,
  and any real Slack error is still reported, not swallowed.
- Writer tools: composing only usable tools removes the git error; the
  steering scope rules remain in place if an agent tries an out-of-grounding
  tool.
- Idempotency injector is side-effect-free for calls that already carry a key.

## Testing

- A: `build_docs_rubric_grader(None, ...)` returns a grader; its `grade()`
  returns `RubricGrade()` with no model calls. `EvaluatorNode(noop_grader)`
  still returns a `COMPLETED` verdict. Factory test: verification fails over to
  a non-requesty model when requesty is disabled.
- B: Slack client test with a fake installation store asserts
  `search.messages` is called with the installed bot token; without
  `team_id` the old env fallback still works.
- C: composition test asserts no git/fs tool is present under GITHUB
  grounding and git tools are under LOCAL.
- D: steering handler test asserts a deterministic key is stamped for a
  side-effecting DELIVERY tool call and identical calls produce identical keys.