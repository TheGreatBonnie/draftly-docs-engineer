# Draftly Agent Steering Architecture

**Date:** 2026-09-10  
**Status:** Design approved for specification; implementation not started  
**Scope:** Every AI agent executed by `draftly-agent-backend`

## Summary

Draftly will add a centralized, policy-driven steering layer to every application-created Strands `Agent`. Steering will observe tool calls and model turns, then return one of three tool-call outcomes—`Proceed`, `Guide`, or `Interrupt`—and one of two model-turn outcomes—`Proceed` or `Guide`.

The layer will be installed at agent construction time, not attached opportunistically to individual workflows. Each runtime agent receives a fresh steering handler, a role-specific policy, and a per-run runtime containing durable attempt accounting and redaction rules. Existing graph-level `ReviewGate` behavior remains the authoritative final-document approval mechanism; steering is an earlier, generalized reliability and intervention boundary.

The first implementation will use the existing `agent_steps` audit path for steering decisions and add a durable `workflow_interventions` record for human responses to steering interrupts. Steering events will be emitted through the existing durable SSE/replay pipeline. The feature will ship behind configuration flags with staged rollout and a kill switch.

## Context and current architecture

The backend currently builds agents through factories registered by `src/draftly/app/composition/agents.py`. The factories construct direct Strands `Agent` instances for classifiers, context and research agents, analyzers, writers, delivery, support, changelog, notification, evaluation, and related subagents.

Per-run graphs are assembled in `src/draftly/integrations/strands/graph.py` and the graph builders under `src/draftly/orchestration/graphs/`. They receive a `WorkflowContext`, session manager, audit repository, hooks, publisher, and graph-level providers. Each graph commonly installs `ReviewGate` and `RunAuditLogger` through `GraphBuilder`; documentation delivery currently disables its local human-in-the-loop intervention because `ReviewGate` owns final approval.

`WorkflowRunner` in `src/draftly/workflows/runner.py` owns run lifecycle, streaming, graph invocation, resume, interruption storage, and recovery. `StreamEnvelope` and the Redis/database event publishers already provide ordered, durable per-run event replay. `agent_steps` in the existing migrations provide an audit trail for node and tool activity.

This design is based on the Strands documentation retrieved through the Strands MCP server and verified against the installed SDK (`strands-agents` 1.52.0). The relevant Strands concepts are:

- `SteeringHandler(Plugin)` registers context providers and implements `steer_before_tool` and `steer_after_model`.
- Tool steering supports `Proceed`, `Guide`, and `Interrupt`.
- Model steering supports `Proceed` and `Guide`; model `Interrupt` is not part of the current public handler contract.
- `Guide` cancels a tool call or retries a model turn with feedback.
- `Interrupt` pauses a tool call and requires an external resume response.
- `LLMSteeringHandler` uses a separate judge agent and should not inherit application tools or recursively install steering.
- `LedgerProvider` exposes tool and conversation context to steering, but handler memory alone is not sufficient for durable retry accounting when a graph is rebuilt.

The source documentation reviewed includes:

- [Strands steering reliability guide](https://strandsagents.com/docs/learning/improve-agent-reliability-with-strands-steering/index.md)
- [SteeringHandler API](https://strandsagents.com/docs/api/python/strands.vended_plugins.steering.core.handler/index.md)
- [Steering actions API](https://strandsagents.com/docs/api/python/strands.vended_plugins.steering.core.action/index.md)
- [LLMSteeringHandler API](https://strandsagents.com/docs/api/python/strands.vended_plugins.steering.handlers.llm.llm_handler/index.md)
- [LedgerProvider API](https://strandsagents.com/docs/api/python/strands.vended_plugins.steering.context_providers.ledger_provider/index.md)

## Goals

1. Apply consistent steering coverage to every Draftly application agent, including dynamically created subagents and evaluator agents.
2. Prevent unsafe, invalid, or low-confidence tool usage before side effects occur.
3. Give agents bounded corrective guidance without allowing unbounded retry loops.
4. Support durable human intervention and process restart/resume.
5. Preserve existing review, delivery, streaming, audit, and authorization behavior.
6. Make decisions observable, redacted, testable, and reversible through configuration.
7. Roll out progressively without requiring a second model call for every agent action.

## Non-goals

- Replacing `ReviewGate` or changing the meaning of final-document review.
- Allowing an LLM judge to approve side effects without deterministic policy checks.
- Adding a second agent orchestration framework.
- Persisting full prompts, secrets, repository contents, or unrestricted tool payloads in steering records.
- Applying steering recursively to the internal LLM judge agent.
- Making model steering interruptible in the current SDK version.

## Architecture decision

### Centralized construction

Introduce a single construction boundary in the Strands integration layer, exposed conceptually as:

```python
build_draftly_agent(
    *,
    role: AgentRole,
    system_prompt: str,
    model: Model,
    tools: Sequence[Tool] = (),
    plugins: Sequence[Plugin] = (),
    structured_output_model: type[BaseModel] | None = None,
    runtime: SteeringRuntime,
    interventions: Sequence[Intervention] = (),
    **agent_options,
) -> Agent
```

The helper is the only approved construction path for application `Agent` instances. It combines caller plugins with exactly one role-configured steering handler, preserves structured output and existing agent options, and attaches the per-run session manager and other supported options unchanged.

All existing factories must migrate to this boundary, including factories for:

- routing/classification and context gathering;
- documentation research, impact analysis, answer writing, document writing, changelog, and delivery;
- issue, support, content, and notification workflows;
- evaluation and evaluator agents;
- dynamically created swarm/subagent agents.

The helper must reject or flag accidental direct `Agent(...)` construction in application code. A repository test will enumerate the source tree and allow direct construction only in the centralized helper and the explicitly isolated internal LLM steering judge.

Each application agent gets a fresh handler instance. This prevents steering context and retry state from leaking across agents or runs. A handler may use `LedgerProvider` for current-turn context, while durable limits come from `SteeringRuntime`.

### Runtime context

Add a `SteeringRuntime` owned by the per-run `WorkflowContext`. It contains:

- `run_id`, organization/project identity, workflow surface, workflow key, node ID, and agent ID;
- selected policy version and agent role;
- repository/session references needed by deterministic checks;
- an intervention and audit sink;
- event publisher/broadcaster;
- redaction configuration;
- durable attempt counter access;
- cancellation/deadline state;
- feature flags and rollout cohort.

The runtime is passed to factories through the existing `WorkflowContext`/agent registry path. It must not contain raw credentials. Tool input and output access is limited to the handler callback and is redacted before persistence or publication.

### Steering package

Create `src/draftly/steering/` with focused modules:

- `policy.py`: roles, policy versions, deterministic rules, limits, and fail-open/fail-closed behavior;
- `handler.py`: Draftly `SteeringHandler` integration and callback orchestration;
- `context.py`: `SteeringRuntime` and context-provider adapters;
- `decisions.py`: typed `Proceed`, `Guide`, and `Interrupt` decisions plus decision metadata;
- `redaction.py`: bounded, structured redaction of inputs, outputs, reasons, and user messages;
- `persistence.py`: audit/intervention repositories and idempotent state transitions.

The package must depend on stable Strands public APIs. SDK-specific imports and compatibility checks stay inside `handler.py`; if a future Strands release changes the handler contract, the rest of Draftly remains insulated.

## Policy model

Every agent gets a policy, but policies differ by role. Policy selection is explicit and versioned rather than inferred from prompt text.

| Agent role                | Deterministic before-tool checks                                             | Model guidance                   | Human interrupt default                                    |
| ------------------------- | ---------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------- |
| Classifier/router         | Validate tool existence, arguments, scope, and read-only access              | Disabled by default              | Never                                                      |
| Context/research          | Enforce repository/project scope, bounded queries, and source requirements   | Optional canary                  | Never for read-only failures; interrupt on scope violation |
| Analyzer/impact/evaluator | Validate evidence references, limits, and output contract                    | Optional, bounded                | Interrupt on missing required evidence or unsafe access    |
| Writers/changelog/content | Validate evidence linkage, output schema, and mutation intent                | Optional, bounded                | Interrupt before non-draft mutation                        |
| Support/answer writer     | Validate tenant scope, sensitive-data rules, and output schema               | Optional, bounded                | Interrupt on sensitive-data or permission uncertainty      |
| Delivery/notification     | Validate destination, authorization, idempotency key, and draft/posted state | Disabled initially               | Interrupt before external side effect when checks fail     |
| Internal steering judge   | No application tools                                                         | Its own structured response only | Not applicable                                             |

The baseline behavior is:

- invalid or out-of-scope tool arguments: `Guide` with a bounded correction message;
- repeated invalid arguments after the configured limit: `Interrupt` for tools that may mutate state, otherwise fail the agent with a typed policy error;
- read-only provider/transient failure: `Proceed` only when the tool itself reports a recoverable result and the role policy allows it; otherwise `Guide` or fail according to the tool contract;
- missing required evidence: `Guide` once to request a narrower or better-supported action, then `Interrupt` or fail according to role;
- authorization, tenant boundary, secret exposure, destination mismatch, or irreversible side-effect uncertainty: `Interrupt` before the tool executes;
- successful, policy-compliant action: `Proceed`;
- low-confidence model response: `Guide`, subject to model-turn limits;
- model steering never returns `Interrupt` under the current Strands contract.

### Limits

Defaults are configuration, recorded with each run, and can be overridden only by a validated role policy:

- maximum tool guides per tool call: `2`;
- maximum model guides per model turn: `2`;
- maximum total guides per agent invocation: `5`;
- maximum steering judge latency: `10` seconds;
- maximum steering reason length: `1,000` characters before redaction/truncation;
- maximum persisted tool input/output summary: `4 KiB` each.

When a limit is reached, no further automatic guidance is attempted. The runtime applies the role’s terminal action: fail closed for unsafe or side-effecting work, and fail with a typed recoverable error for safe read-only work. Limits are keyed by `(run_id, agent_id, node_id, phase, tool_name, model_turn)` and persisted or transactionally reserved so graph reconstruction cannot reset them.

### Optional LLM steering

LLM steering is a separate, opt-in judge call. It is not the default for all agents. The judge receives only the minimum redacted ledger/context required for the role decision and has no application tools, plugins, side effects, or recursive steering handler. The judge must return a schema-validated decision and reason. Invalid, timed-out, or unavailable judge results follow the policy’s deterministic fallback; they never silently authorize a risky side effect.

## Lifecycle and data flow

1. `WorkflowRunner` creates a per-run `WorkflowContext` and `SteeringRuntime` with the run’s policy snapshot, limits, repositories, and publishers.
2. `build_graph_for_run` passes the runtime into graph builders and agent factories.
3. The centralized helper constructs each application agent with a fresh role-aware handler and the caller’s existing plugins/tools/options.
4. A context provider, including `LedgerProvider` where enabled, supplies current conversation/tool state to the handler.
5. Before a tool call, deterministic policy checks execute first. If enabled for the role, the judge may provide a bounded secondary opinion. The handler returns `Proceed`, `Guide`, or `Interrupt`.
6. A `Proceed` tool call executes normally. A `Guide` cancels the call and sends bounded feedback through Strands. An `Interrupt` pauses the call and creates a durable intervention.
7. After a model call, the handler may return `Proceed` or `Guide`. `Guide` discards the candidate response and retries with feedback within the persisted model-guide limit.
8. Every decision is redacted, audited as an `agent_steps` row with `kind = 'steering'`, and published as a typed `steering` stream envelope.
9. An interrupt transitions the workflow to `pending_intervention`, persists the exact interrupt ID and resume metadata, emits the terminal lifecycle event for the current attempt, and returns control to the worker/API boundary.
10. A human response is authorized and atomically recorded. The runner rebuilds the same per-run graph/session and resumes using the exact interrupt ID and decision payload.
11. The intervention is marked resolved only after the resumed run reaches the expected state. Duplicate responses return the previously recorded outcome and do not resume a second time.
12. Existing `ReviewGate` interrupts continue through the review endpoint and remain `pending_review`; they are not converted into steering interventions.

The internal LLM judge is the only agent exempt from the application construction boundary. It is created by the Strands `LLMSteeringHandler` with no tools or application plugins, and the helper must provide a recursion guard if the SDK ever routes judge construction through application factories.

## Persistence and state

### Steering audit

Reuse `agent_steps` for the append-only decision audit. Add `kind = 'steering'` and store a redacted detail object containing:

- schema version and policy version;
- action (`proceed`, `guide`, or `interrupt`);
- phase (`before_tool` or `after_model`);
- agent/node/tool identifiers;
- bounded reason and rule/judge source;
- attempt number and limit snapshot;
- latency and outcome;
- correlation IDs for the stream event and intervention, when present.

Do not store raw prompts, authorization headers, tokens, cookies, full repository files, or unbounded tool payloads.

### Human interventions

Add a `workflow_interventions` table with an organization-scoped ownership key and these logical fields:

- `id`, `run_id`, `interrupt_id`, `surface`, `workflow_key`, `agent_id`, `node_id`, `tool_name`;
- `status` (`pending`, `approved`, `denied`, `guided`, `expired`, `cancelled`);
- redacted `reason`, redacted `response_message`, and structured metadata;
- `created_at`, `updated_at`, `resolved_at`, `expires_at`;
- resolver identity and an idempotency key;
- unique constraint on `(run_id, interrupt_id)` and a unique response idempotency key.

The existing review repository/table remains responsible for `ReviewGate` approval. The new table is for generalized steering interruptions and must not weaken review authorization.

### Workflow status

Add `pending_intervention` to the backend run-status type and the `workflow_runs` check constraint. Update API schemas, lifecycle transitions, event replay behavior, and worker recovery code. Existing statuses—especially `pending_review`, `completed`, `failed`, `cancelled`, and `skipped`—retain their current meanings.

On process restart, a run in `pending_intervention` is recoverable only when its intervention is pending and its session/checkpoint is resumable. Otherwise it transitions to a typed failed/recovery-required state with an operator-visible reason. A stale worker must not claim or resume an intervention after it has been resolved by another worker.

## API and streaming contract

### Intervention response

Add an authenticated endpoint:

`POST /api/workflow-runs/{run_id}/interventions/{interrupt_id}/respond`

Request body:

```json
{
  "action": "approve",
  "message": "Proceed with the validated destination."
}
```

`action` is one of `approve`, `deny`, or `guide`. `message` is optional, bounded, and redacted before audit. `approve` resumes the paused tool with approval, `deny` resumes with denial/cancellation, and `guide` resumes with human guidance where the Strands interrupt contract permits it. The API rejects unsupported action/phase combinations, mismatched organization/project ownership, unknown or resolved interrupt IDs, expired interventions, and oversized messages.

The endpoint must:

- require the same organization/project authorization as the run;
- use an idempotency key supplied by the caller or a server-derived request identity;
- atomically claim the pending intervention before enqueueing resume;
- never expose raw tool inputs or secrets in the response;
- return the current intervention status and run status on duplicate requests;
- record the resolver identity and audit correlation ID.

The existing review endpoint remains the only endpoint for `ReviewGate` decisions. It may share internal resume primitives but must preserve its current request/changes semantics.

### SSE events

Extend `StreamEnvelope` with a typed `steering` event payload. The payload includes only:

- event schema version;
- phase and action;
- safe role/agent/node/tool labels;
- redacted reason and rule source;
- attempt/limit summary;
- `interrupt_id` and response state when applicable.

Steering events use the existing per-run sequence, database replay, Redis stream, and authorization filters. They must be delivered before the corresponding lifecycle status transition. Replay ends only at the existing workflow terminal result or the new intervention-pending lifecycle event as appropriate; reconnecting clients must not lose a steering decision.

## Failure, recovery, and safety rules

The following matrix is normative:

| Failure                               | Read-only agent                                              | Side-effecting agent                                                          |
| ------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Deterministic policy violation        | `Guide` within limit, then typed failure                     | `Guide` within limit, then `Interrupt`                                        |
| Missing/invalid judge result          | Deterministic fallback; fail if required evidence is missing | Fail closed; do not authorize the call                                        |
| Steering persistence failure          | Fail the run; do not claim a decision was recorded           | Fail closed before tool execution                                             |
| Event publication failure after audit | Continue if durable audit succeeded; mark publish lag        | Continue only if no side effect is pending; otherwise fail/reconcile          |
| Resume conflict or stale worker       | Return current state; never duplicate resume                 | Return current state; require reconciliation if side effect status is unknown |
| Limit exhausted                       | Typed recoverable failure                                    | Interrupt or typed failure according to policy                                |
| Cancellation/deadline during steering | Stop and persist cancellation                                | Stop before side effect and persist cancellation                              |

All tool calls that can mutate an external system must use existing or added idempotency keys and post-action reconciliation where the provider supports it. An interrupt must happen before the side effect, not after it. If a provider can report an unknown outcome after a timeout, the run enters a reconciliation-required failure state rather than automatically retrying.

Steering must not swallow exceptions from persistence, authorization, or safety checks. The Strands handler’s fail-open behavior for provider exceptions is wrapped by Draftly policy: only explicitly classified, safe, read-only context-provider failures may fall back to `Proceed`; all other failures become a typed steering error or interrupt.

## Security and privacy

- Enforce organization, project, repository, and destination scope before every tool with access to external state.
- Keep steering judges tool-less and credential-less.
- Validate structured tool arguments before evaluation and before execution.
- Redact credentials, tokens, personal data, repository content, and provider-specific secrets from audit, SSE, logs, and judge context.
- Apply output sanitization and schema validation to guided/retried model responses.
- Bound reason, message, payload, retry, latency, and event sizes.
- Authorize intervention reads and writes by organization/project ownership and role permissions.
- Treat human guidance as untrusted input: it is bounded, recorded, and passed only to the paused agent/tool context.
- Include policy version, rollout cohort, and configuration fingerprint in audit metadata so decisions are explainable without storing sensitive prompt content.

## Observability

Emit structured metrics and traces for:

- steering decisions by action, phase, role, workflow surface, policy version, and rule source;
- guide retry counts and limit exhaustion;
- interrupt creation, response latency, expiry, denial, and resume success/failure;
- judge calls, latency, token/cost estimate, invalid responses, and fallback;
- persistence/publication failures;
- runs entering `pending_intervention` or recovery-required states;
- side-effect reconciliation outcomes.

Logs must contain correlation IDs and safe identifiers but no raw prompts or secrets. Dashboards must make it possible to compare shadow decisions with production decisions before enabling enforcement.

## Testing strategy

### Unit tests

- decision types serialize and deserialize safely;
- each role policy returns the expected action for valid, invalid, unsafe, and boundary inputs;
- limits persist across handler recreation and graph resume;
- redaction removes known secret and sensitive-data patterns and enforces byte limits;
- deterministic checks run before optional judge calls;
- model steering accepts only `Proceed`/`Guide`;
- judge construction has no tools/plugins and cannot recurse into steering;
- fail-open/fail-closed matrix is enforced.

### Integration tests

- every application factory creates an agent with a steering handler;
- graph builders cover every workflow surface and dynamically created subagents;
- tool `Guide` cancels the tool and retries within limits;
- tool `Interrupt` persists an intervention and resumes with the exact ID;
- model `Guide` retries with bounded feedback;
- `ReviewGate` still produces `pending_review` and uses the review endpoint;
- steering produces durable `agent_steps` and replayable SSE events;
- restart between interrupt and response resumes once;
- duplicate and concurrent responses are idempotent;
- side-effect checks fail closed and provider unknown outcomes require reconciliation;
- no live API key is required for policy/handler tests.

### API and contract tests

Test authorization, organization isolation, validation, expiry, idempotency, status transitions, response redaction, SSE ordering, replay, and compatibility with existing review clients. Add migration tests for `pending_intervention` and `workflow_interventions`.

## Rollout plan

1. **Shadow mode:** construct handlers and record redacted would-have-decisions without changing tool/model behavior. Validate coverage and false-positive rates.
2. **Deterministic read-only enforcement:** enable classifier, context, research, and analyzer policies with no human interrupts for safe failures.
3. **Writer/evaluator enforcement:** enable schema/evidence guidance and bounded retries.
4. **Side-effect protection:** enable fail-closed checks and human interrupts for delivery, notification, publishing, and other mutations.
5. **LLM judge canary:** enable only for selected roles/cohorts with latency/cost/error budgets.
6. **Default-on by surface:** expand after metrics and recovery drills meet release thresholds.

Every stage is controlled by configuration at organization/project/surface scope, with a global kill switch that disables automatic judge calls and enforcement independently. Disabling steering must not bypass existing `ReviewGate` or authorization checks.

## Alternatives considered

### Add steering only to the root graph agent

Rejected because many Draftly capabilities are direct agents or dynamically created subagents. Root-only coverage would leave delivery, notification, evaluator, and swarm actions unprotected.

### Add one shared handler to all agents

Rejected because context, retry state, and role policy could leak across agents and runs. Fresh handler instances with shared durable runtime access provide isolation and consistent accounting.

### Use `HumanInTheLoop` for all steering

Rejected because it pauses every tool call and does not provide deterministic guidance or bounded model retry semantics. It remains useful for explicit tool approval, while the new intervention path handles generalized steering interrupts.

### Use an LLM judge for every decision

Rejected due to cost, latency, availability, and authorization risk. Deterministic checks are always first; LLM steering is role-scoped and staged.

### Store steering state only in handler memory

Rejected because workers rebuild graphs during resume and process restarts. Durable audit, intervention state, and attempt reservations are required for correctness.

## Acceptance criteria

- Every application-created Strands agent across every workflow surface receives exactly one role-configured steering handler.
- Direct application `Agent(...)` construction outside the approved helper is prevented by test and code review convention.
- Tool actions support correct `Proceed`/`Guide`/`Interrupt` behavior; model actions support only `Proceed`/`Guide`.
- Automatic guides and model retries are bounded and remain bounded after graph rebuild or worker restart.
- Unsafe side-effecting calls fail closed or require a durable human intervention before execution.
- Steering audits and SSE events are durable, ordered, replayable, authorized, and redacted.
- Intervention responses are authenticated, idempotent, concurrency-safe, and resume the exact paused run.
- Existing `ReviewGate` review behavior remains unchanged and distinct from steering intervention.
- Failure, cancellation, timeout, and unknown side-effect outcomes have explicit tested behavior.
- Rollout can be enabled per cohort and disabled with a kill switch without bypassing existing safety controls.
- Unit, integration, API, migration, restart, and stream-replay tests pass without requiring production credentials.

## Implementation boundary

This document defines the production design only. It does not add the steering package, migrations, endpoint, policy configuration, or tests. After this specification is reviewed and approved, the next step is to create a dependency-ordered implementation plan before modifying backend code.
