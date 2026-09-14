# Worker Performance and Cost Optimization Design

**Date:** 2026-09-13

**Status:** Approved design

## Purpose

Reduce the latency, provider cost, and stdout volume of Draftly's documentation worker without weakening deterministic authorization, evidence grounding, idempotency, human review, or delivery safeguards.

The design keeps the existing documentation graph and optimizes its expensive boundaries. It targets the behavior observed in GitHub PR run `ed42b4f0-af37-11f1-9b9f-1f0c968485fe`: dozens of optional steering-judge calls, unconditional multi-source research, 68 writer tool calls, a false-negative evaluation followed by a complete rewrite, raw Strands output in Docker logs, and a provider payment failure discovered only after invocation.

## Success Criteria

A representative GitHub PR workflow must meet all of the following:

- Use at least 60 percent fewer model requests than the captured PR #17 baseline.
- Reach `pending_review` within eight minutes under healthy provider conditions.
- Complete the writer stage within five minutes and the full automated pipeline — through `pending_review` and, after approval, delivery — within fifteen minutes under healthy provider conditions. Wait time contributed by the human review gate is excluded: it is human latency, not processing latency. The 15-minute full-pipeline target is a secondary, longer-horizon gate; it never relaxes the 8-minute `pending_review` criterion above.
- Complete a normal run with one writer generation.
- Use at most one optional LLM steering judgment per agent stage.
- Add no more than one failed attempt when a connector or provider is unavailable.
- Emit no raw model reasoning or `Tool #N` output to worker stdout.
- Record model calls, input and output tokens, estimated cost, latency, provider fallbacks, tool calls, steering activity, and revisions by stage and run.
- Preserve existing authorization, idempotency, review, resume, and delivery behavior.

The first production week establishes calibrated baselines. The percentage and latency targets remain fixed for acceptance, while alerts may be tuned after observing production distributions.

## Scope

This design changes six internal areas:

1. Agent callback and operational logging behavior.
2. Optional LLM steering-judge selection and caching.
3. Documentation research-agent selection.
4. Impact-to-evaluation requirement contracts.
5. File-specific revision and batch draft operations.
6. Provider health filtering and per-run cost telemetry.
7. Writer model-tier selection (middle chain for the drafting tool loop; `reasoning` retained for the plan step and sealed generation).
8. A best-effort provider warm-up probe issued after the impact stage so the writer's first call does not pay cold first-byte latency.

All new graph payload fields are additive. Existing stored sessions and test fixtures that omit them remain readable.

## Non-goals

- Replacing the Strands graph framework.
- Removing deterministic steering checks from any tool call.
- Removing the human review gate.
- Automatically delivering documentation without approval.
- Replacing all research, classification, impact, or writing agents with deterministic code.
- Changing public HTTP API contracts.
- Changing the underlying per-file draft persistence model.

## Architecture

The documentation workflow remains:

```text
PR event
  -> classify
  -> context
  -> capability-aware research
  -> impact + structured requirements
  -> writer + batched draft operations
  -> deterministic requirements evaluator
       |-- pass -> human review
       `-- concrete gaps -> targeted revision -> human review
  -> approved delivery
```

The `impact -> notify -> notify_post` branch continues in parallel. Notification failure remains isolated from documentation generation.

Deterministic code owns authorization, connector eligibility, provider eligibility, structural evaluation, revision scope, and lifecycle transitions. LLMs own evidence synthesis, prose generation, optional policy refinement for eligible risky stages, and rubric feedback.

## 1. Silent Agents and Structured Logging

Every production agent built through `build_draftly_agent` will default to `callback_handler=None`. Explicitly injected callback handlers remain supported for tests or specialized callers. Strands graph streaming remains the only source for user-facing incremental events.

Worker stdout will contain structured operational records, not model token streams. Successful per-tool steering decisions move from individual `INFO` events to per-stage summaries. Interrupts, guides, policy failures, provider failures, evaluation verdicts, review pauses, and delivery results remain individual events.

Large values such as complete evaluation evidence and missing-topic prose will be stored in the audit repository. Stdout will carry compact fields: counts, stable requirement IDs, affected paths, score, and an audit record identifier.

Production containers use JSON rendering without ANSI escape sequences. Development console rendering remains available locally.

## 2. Selective Steering Judgment

Deterministic steering continues to execute before every tool call and after every model response. The optional LLM judge becomes a bounded refinement mechanism rather than a universal second opinion.

The selector interface is:

```python
def should_invoke_llm_judge(
    decision: SteeringDecision,
    *,
    tool_name: str | None,
    stage: str,
) -> bool:
    """Return whether this deterministic decision needs LLM refinement."""
```

The selector returns `False` when:

- The decision is a routine deterministic `PROCEED` for a read-only tool.
- The tool is a local draft-store operation.
- The same normalized eligible decision has already been judged in the stage.
- The stage has consumed its one-judgment budget.

The selector may return `True` when:

- A deterministic result requests guidance but is not a terminal interrupt.
- An external side-effect stage is about to execute its first eligible action.
- Policy configuration marks the action category as requiring refinement.

Deterministic interrupts are never overridden and do not invoke the judge. Every individual side-effect call still receives deterministic scope and idempotency validation even when its stage-level LLM budget is exhausted.

Eligible results are cached per run using a normalized key containing policy version, role, phase, rule, action category, and redacted reason. The cache excludes raw tool arguments and secrets. It lives only for the run and does not alter durable policy state.

Judge failures fall back to the deterministic result. Logs record `timeout`, `provider`, `schema`, or `unknown` rather than only `SteeringFailure`.

`STRANDS_STEERING_LLM_ENABLED=false` remains a supported operational kill switch that disables optional judging without disabling deterministic enforcement.

## 3. Capability-aware Research

Research-agent construction is driven by a deterministic capability snapshot:

```python
@dataclass(frozen=True)
class ResearchCapabilities:
    repository: bool
    documentation: bool
    slack_search: bool
    discord_search: bool
```

Connector health is established by a bounded capability probe and cached for the worker process with a cooldown. Authentication, token-type, payment, and unsupported-operation failures disable the relevant capability immediately for the cooldown. A disabled source produces one diagnostic event and no research agent.

For GitHub PR workflows:

- Repository evidence and documentation evidence are mandatory.
- Slack and Discord are selected only when the event or existing evidence contains relevant support-channel identifiers, the impact policy explicitly requests cross-channel evidence, or repository/documentation evidence is insufficient.
- The context stage owns PR metadata, changed-file summaries, and grounding selection.
- Research agents receive the context bundle and investigate only declared gaps; they do not repeat complete PR inspection.

The swarm's handoff and iteration budgets are reduced to the number of selected researchers plus one coordination pass. Repetitive handoff detection remains enabled. Research outputs use one normalized `EvidenceBundle` with stable IDs so downstream nodes pass references instead of repeating full excerpts.

## 4. Structured Requirements and Evaluation

Impact analysis emits human-readable rationale plus compact requirements:

```python
class DocumentationRequirement(BaseModel):
    id: str
    description: str
    required_files: list[str]
    signals: list[str]
    evidence_ids: list[str]
```

Requirement IDs are stable, lower-kebab-case identifiers such as `oauth-code-exchange`, `oauth-login`, and `pkce-limit`. `signals` contain short symbols or phrases, never complete evidence paragraphs. `required_files` may be empty when any affected document can satisfy the requirement.

The evaluator returns:

```python
class EvaluationResult(BaseModel):
    passed: bool
    score: float
    missing_by_file: dict[str, list[str]]
    revision_files: list[str]
    escalated: bool
    disagreement: bool
```

Deterministic hard checks verify:

- At least one sealed draft exists when a writer ran.
- Every required file has a sealed draft or an explicitly accepted unchanged revision.
- Required source paths or evidence IDs are cited where the requirement demands them.
- Every requirement has at least one configured signal in its required file set.
- Draft metadata and generation state are internally consistent.

Length remains diagnostic and cannot independently pass or fail a draft. Full evidence prose is never used as a literal topic token.

The rubric grader supplies groundedness and prose-quality feedback. It does not override structural hard failures. When the deterministic evaluator fails but the rubric passes, `disagreement=True`. A targeted revision is allowed only when `missing_by_file` names concrete corrections. If no actionable gap exists, the result proceeds to human review with the disagreement attached.

## 5. Targeted Revision

The first writer generation produces the complete proposed change set. Later generations receive:

```python
class RevisionRequest(BaseModel):
    base_generation: int
    revision_files: list[str]
    missing_by_file: dict[str, list[str]]
    accepted_draft_ids: list[str]
```

Accepted files are logically inherited from the base generation. Only paths in `revision_files` may create new revisions. Evaluation assembles the effective generation by overlaying revised paths on accepted base drafts.

One targeted revision is permitted. If the second evaluation still fails, it is marked `escalated=True` and proceeds to human review with unresolved requirement IDs. The system never starts a third writer pass and never replaces accepted files merely because another file failed.

Review and delivery receive the effective assembled generation, not only the most recently written subset.

## 6. Batched Draft Operations

The model-facing tools become:

```python
async def inspect_documents(paths: list[str]) -> list[DocumentSnapshot]: ...

async def write_draft_batch(
    changes: list[DraftChange],
) -> list[DraftReceipt]: ...

async def finalize_draft_batch(
    draft_ids: list[str],
) -> list[FinalizedDraft]: ...
```

Batch size and total byte limits are enforced before persistence. Internally, existing per-file repository operations remain responsible for revision validation and writes.

A batch is visible to evaluation only after every member finalizes successfully. On partial failure, successfully written members remain unsealed and the batch returns a structured failure containing path-specific errors. Retrying with the same idempotency key resumes or safely reuses existing unsealed drafts rather than duplicating revisions.

Single-file tools remain temporarily available for session compatibility but are removed from new writer agents once batch integration is enabled.

## 7. Provider Health and Routing

Provider health gains durable reason and cooldown fields. Payment and authentication errors immediately disable the provider for the configured cooldown; transient rate or transport failures continue to use threshold-based health behavior.

Routing filters disabled providers before constructing stage agents. A provider rejected by the health filter does not count as a model attempt for the new run. Re-enablement happens through cooldown expiry or an explicit successful health probe.

Classifier, optional steering, and notification roles prefer the lowest-cost model satisfying their capabilities. Research synthesis, rubric review, and delivery retain role-specific quality requirements. The writer is the one exception: its drafting tool loop routes through a middle chain (the `research` tier used by `context` and `content_strategist`) while the initial plan step and the sealed generation resolve to the `reasoning` tier via per-call capability routing. Deep reasoning is preserved where output becomes durable prose; the tool-loop chatter does not pay for it. Payment failover remains limited to one replacement attempt.

## 8. Cost and Performance Telemetry

Each run owns an in-memory accumulator that is flushed durably at stage boundaries and terminal completion. It records:

- model calls, input tokens, output tokens, and estimated cost by node, role, provider, and model;
- tool calls by stage and tool name;
- steering deterministic decisions, judge calls, cache hits, and fallbacks;
- connector omissions and probe failures;
- provider retries, disables, and failovers;
- draft generations, files created, files revised, and bytes generated;
- node latency and total workflow latency.

The worker emits one compact `workflow_stage_summary` per completed stage and one `workflow_cost_summary` at termination or review pause. Existing detailed audit records remain available for investigation.

## 9. Latency Addendum: Writer Tier Routing and Cold-Start Warm-Up

Two additive deltas approved against this design. Each is gated by its own default-off flag (`writer_middle_tier`, `provider_warmup`); the composite `DRAFTLY_FASTPATH` toggle enables the whole latency bundle (selective steering, capability-aware research, batch draft tools, writer tier routing, and warm-up) for A/B comparison and live demonstration.

### 9.1 Writer Capability-Aware Tiering

`documentation_engineer` uses the `research` chain for the drafting tool loop; per-call capability routing retains `reasoning` for the initial plan and the sealed generation. Rationale: the tool loop performs bounded, single-purpose operations whose measured latency is dominated by serialized chain and steering overhead, not reasoning depth (captured baseline run `ed42b4f0`: ~25 minutes across writer gap and drafting, ~100 tool calls).

Behavior is reversible with `writer_middle_tier=false`. The primary rollback trigger for a quality regression is evaluate escalation rate or reviewer-observed prose quality.

### 9.2 Provider Warm-Up Probe

Immediately after the impact stage completes, the runner issues a best-effort one-token completion to the same provider and model the writer's first plan call will resolve to. The probe is non-blocking for graph progress, uses a 5-second timeout, and never counts as a model attempt for the health filter or cost telemetry. Its purpose is to pay cold-start/first-byte latency before the writer issues its large first generate, collapsing the measured ~14-minute silent gap.

Provider stabilization (§7) is unchanged: requesty-class `402` and orcarouter fallback churn are answered by cooldown and re-routing, and the probe runs only against providers currently healthy for the target model.

## Failure Handling

- Optional steering failure preserves the deterministic result and records a categorized fallback.
- Unavailable Slack or Discord search omits that source without retrying through an agent.
- Mandatory repository or documentation evidence failure stops impact generation with an actionable failure.
- Provider payment or authentication failure disables that provider and permits one routed replacement.
- Partial draft batches remain unsealed and invisible to evaluation.
- Rubric failure preserves the deterministic verdict.
- Evaluation disagreement without actionable deterministic gaps proceeds to human review.
- One failed targeted revision escalates to human review rather than causing another rewrite.
- Delivery remains gated by approval, scope policy, idempotency, and sealed draft availability.

## Compatibility and Rollout

Independent feature flags control:

- `silent_agent_callbacks`
- `selective_steering_judge`
- `capability_aware_research`
- `structured_evaluation_requirements`
- `targeted_draft_revisions`
- `batch_draft_tools`
- `run_cost_summary`
- `writer_middle_tier`
- `provider_warmup`

The composite `DRAFTLY_FASTPATH` enables `selective_steering_judge`, `capability_aware_research`, `batch_draft_tools`, `writer_middle_tier`, and `provider_warmup` together for A/B and live demonstration while leaving measurement (`run_cost_summary`) and the structural flags independently controllable.

Flags default off until their tests and captured-run comparison pass. Rollout order is:

1. Cost telemetry and silent callbacks.
2. Selective steering judgment.
3. Structured requirements and evaluator correction.
4. Targeted revision.
5. Capability-aware research.
6. Batched draft operations.
7. Writer tier routing and provider warm-up (may land concurrently as a measured pair; warm-up is the first to enable because it only removes latency).
8. Default-on cleanup after compatibility coverage passes.

Rollback disables the affected flag. Readers use defaults when new payload fields are absent, allowing pre-change sessions to resume.

## Testing Strategy

Unit coverage verifies selector eligibility, stage budgets, cache keys, connector planning, compact requirement matching, file-specific evaluation, effective-generation assembly, batch atomicity, provider cooldown filtering, silent callbacks, and log aggregation.

Integration coverage includes:

- A normal PR that passes after one writer generation.
- A single-file omission that revises only that file.
- Deterministic/rubric disagreement without actionable gaps.
- Slack search rejected because of token type.
- Requesty-style HTTP 402 followed by one successful failover.
- Review pause and resume using an additive payload created before the new fields existed.
- SSE streaming with silent agent callbacks.
- A partial batch failure that remains invisible to evaluation.

CI uses deterministic fake models. An opt-in live benchmark runs the captured PR scenario and reports the success criteria without making the ordinary test suite depend on external providers.

## Acceptance

The feature set is ready to become default only when the representative scenario satisfies every success criterion, all compatibility tests pass, and logs confirm that no raw reasoning is emitted. Failure to meet the call-reduction or latency target blocks default enablement but does not block continued flag-protected testing.
