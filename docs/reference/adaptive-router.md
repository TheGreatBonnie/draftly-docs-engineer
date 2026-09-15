Yes. Based on the README and `factory.py`, Draftly already has the **foundation of a model-routing layer**, but what you currently have is primarily a **capability-aware fallback router**, not yet a genuinely adaptive router.

The production-ready design I would use is:

```text
                         Draftly Agent
                              │
                              ▼
                    ┌──────────────────┐
                    │ Routing Request  │
                    │                  │
                    │ role             │
                    │ task             │
                    │ complexity       │
                    │ capabilities     │
                    │ latency budget   │
                    │ cost budget      │
                    │ context size     │
                    │ quality target   │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ Adaptive Router  │
                    │                  │
                    │ 1. Constraints   │
                    │ 2. Candidates    │
                    │ 3. Health        │
                    │ 4. Scoring       │
                    │ 5. Policy        │
                    │ 6. Selection     │
                    └────────┬─────────┘
                             │
                  ┌──────────┼──────────┐
                  ▼          ▼          ▼
               Model A    Model B    Model C
                  │          │          │
                  └──────────┼──────────┘
                             ▼
                    ┌──────────────────┐
                    │ Execution        │
                    │ + telemetry      │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ Evaluation       │
                    │ / outcome        │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ Routing feedback │
                    │ + model scores   │
                    └──────────────────┘
```

This fits your existing architecture because the README already places the **model router as a platform service underneath the agent layer**, with agents calling the router and the router spanning Bedrock, Mantle, OpenRouter, NVIDIA, etc.

---

# 1. First: what Draftly already has

Your `factory.py` is actually a good starting point.

It already creates:

```text
ModelRegistry
      │
      ├── Providers
      │
      ├── Models
      │
      └── ModelRouter

ProviderHealthRegistry
      │
      └── health state

CapabilityMatcher
      │
      └── capability matching

AgentModelPolicy
      │
      └── role → routing policy
```

The factory explicitly constructs a `ModelRegistry`, `ProviderHealthRegistry`, registers providers/models, and then creates `ModelRouter`.

You also already have six providers:

- Mantle
- Bedrock
- NVIDIA
- Requesty
- OpenRouter
- OrcaRouter

These are registered independently with priorities.

And your models already have capability metadata such as:

```text
reasoning
tool_calling
structured_output
research
verification
evaluation
```

For example, your NVIDIA reasoning model declares reasoning, tool calling and structured output capabilities.

That's exactly the metadata an adaptive router needs.

---

# 2. Your current router isn't truly adaptive

This is the most important distinction.

Your current architecture has:

```python
ROLE_POLICIES
```

which maps roles to routing chains:

```text
documentation_engineer → reasoning
documentation_reviewer → verification
github_intelligence    → research
support_engineer       → fast
support_reviewer       → verification
research               → research
deepeval               → evaluation
github_delivery        → fast
memory_curator         → fast
```

That's sensible, and it gives Draftly deterministic routing.

But it means:

```text
documentation_engineer
        ↓
reasoning chain
        ↓
first suitable healthy model
```

rather than:

```text
documentation_engineer
        ↓
analyze actual task
        ↓
estimate complexity
        ↓
inspect historical performance
        ↓
inspect latency/cost
        ↓
inspect provider health
        ↓
score candidate models
        ↓
select best model
```

That's the difference between **policy-based routing** and **adaptive routing**.

I would keep your existing policies.

Don't replace them.

Instead:

> **Use the policies as hard constraints and build adaptive selection inside the allowed candidate set.**

---

# 3. The production architecture

I recommend splitting `src/draftly/models/` into these responsibilities:

```text
src/draftly/models/
│
├── providers/
│   ├── bedrock.py
│   ├── mantle.py
│   ├── openrouter.py
│   ├── nvidia.py
│   ├── requesty.py
│   └── orcarouter.py
│
├── registry.py
├── factory.py
│
├── router.py                    # public routing API
├── adaptive_router.py           # adaptive selection engine
│
├── capabilities.py
├── policies.py
│
├── scoring.py                   # candidate scoring
├── constraints.py               # hard constraints
├── candidates.py                # candidate generation
├── selection.py                 # final selection
│
├── health.py
├── performance.py               # historical performance
├── pricing.py
├── latency.py
│
├── config.py
└── schemas.py
```

The README already reserves `models/` for providers, registry, router, factory, capabilities, policies, health, embeddings and configuration, so this fits the existing project rather than introducing a new subsystem.

---

# 4. Separate hard constraints from adaptive scoring

This is the most important architectural decision.

Don't let the router simply calculate:

```text
best_model = highest_score
```

Instead:

```text
                Routing Request
                      │
                      ▼
              Hard constraints
                      │
             ┌────────┴────────┐
             │                 │
          reject             eligible
          models              models
                               │
                               ▼
                       Adaptive scoring
                               │
                               ▼
                         Best candidate
```

## Hard constraints

These must never be violated.

For example:

```text
Task requires tool calling
        ↓
Model MUST support tool_calling
```

Or:

```text
Task requires structured output
        ↓
Model MUST support structured_output
```

Or:

```text
Maximum latency = 2 seconds
        ↓
Models exceeding latency threshold are excluded
```

Or:

```text
Provider is unhealthy
        ↓
Exclude provider
```

This uses the capability metadata you already have.

---

# 5. Define a RoutingRequest

Every agent should submit a standardized routing request.

Something conceptually like:

```python
@dataclass
class RoutingRequest:
    role: str

    task_type: str

    prompt_tokens: int
    expected_output_tokens: int

    required_capabilities: set[str]

    complexity: float
    reasoning_required: bool

    latency_budget_ms: int | None
    cost_budget_usd: float | None

    quality_requirement: float

    context_tokens: int

    workflow: str

    tenant_id: str
    organization_id: str

    request_id: str
```

For example, Draftly's documentation engineer might generate:

```text
role:
    documentation_engineer

task_type:
    documentation_generation

required_capabilities:
    reasoning
    tool_calling
    structured_output

complexity:
    0.87

context_tokens:
    38,000

quality_requirement:
    0.90

latency_budget:
    30 seconds

workflow:
    github_pr
```

The router now has enough information to make a meaningful decision.

---

# 6. Add task classification

The router should understand what kind of work it is routing.

For Draftly, I'd define:

```text
TaskType
───────────────
classification
extraction
summarization
research
code_analysis
documentation_generation
documentation_review
support_answer
support_review
evaluation
memory_curation
delivery
```

You already implicitly have many of these through your role policies.

For example:

```text
github_intelligence → research
support_engineer    → fast
deepeval            → evaluation
```

Your existing policies can become the **default routing intent**, while the actual request supplies task-specific information.

---

# 7. Generate candidates

Suppose the request is:

```text
documentation_engineer
```

Your policy says:

```text
capability = reasoning
required capabilities =
    reasoning
    tool_calling
    structured_output
```

The router asks the registry:

```text
Which models satisfy these requirements?
```

From your current factory, candidates could include:

```text
reasoning-nvidia
reasoning-openrouter
reasoning-bedrock-nova
reasoning-bedrock-claude
reasoning-mantle-gpt
reasoning-mantle-kimi-k2-thinking
reasoning-mantle-kimi-k2-5
reasoning-mantle-glm-5
reasoning-mantle-glm-4-7
reasoning-mantle-mistral-large-3
reasoning-requesty
reasoning-orca
```

Those models already expose capability metadata in the registry.

---

# 8. Then apply provider health

This is where your existing:

```python
ProviderHealthRegistry
```

becomes important.

You should track:

```text
Provider
   │
   ├── availability
   ├── error rate
   ├── timeout rate
   ├── rate-limit rate
   ├── latency
   └── circuit state
```

For example:

```text
Bedrock
healthy
P95 latency: 2.1s
error rate: 0.4%

Mantle
healthy
P95 latency: 1.2s
error rate: 0.7%

OpenRouter
degraded
P95 latency: 5.4s
error rate: 6.1%
```

The router should automatically reduce or eliminate OpenRouter from candidate selection.

---

# 9. Add model-level performance

Provider health isn't enough.

You need:

```text
provider health
+
model performance
```

For each model maintain rolling statistics:

```text
model
 ├── success_rate
 ├── timeout_rate
 ├── p50_latency
 ├── p95_latency
 ├── p99_latency
 ├── average_input_tokens
 ├── average_output_tokens
 ├── estimated_cost
 ├── evaluation_score
 └── recent_failure_rate
```

For example:

```text
Claude Sonnet
quality:       0.94
success:       0.998
p95 latency:   4.1s
cost:          $0.018
```

versus:

```text
Kimi
quality:       0.91
success:       0.994
p95 latency:   2.2s
cost:          $0.007
```

For a normal documentation task, Kimi might win.

For a particularly difficult documentation task, Claude might win.

That's adaptive routing.

---

# 10. Build a scoring function

I would start with a deterministic scoring function rather than immediately using another LLM to decide the model.

For example:

```text
score =
    quality_weight  × quality
  + reliability_weight × reliability
  + latency_weight × latency_score
  + cost_weight × cost_score
  + capability_weight × capability_match
  + historical_weight × task_performance
```

For Draftly:

```text
                    Documentation
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
        Quality         Cost           Latency
          40%             15%              15%

          + Reliability 20%
          + Historical task performance 10%
```

But don't make those weights global.

Use **routing profiles**.

---

# 11. Routing profiles are better than one global formula

Draftly has very different workloads.

For example:

### Support

```text
quality       25%
latency       35%
cost          25%
reliability   15%
```

### Documentation generation

```text
quality       40%
reliability   25%
cost          10%
latency       10%
task_history  15%
```

### Documentation review

```text
quality       50%
reliability   30%
cost          10%
latency       5%
task_history  5%
```

### Evaluation

```text
quality       50%
reliability   30%
cost          10%
latency       5%
task_history  5%
```

This makes the router understand that:

> A support response and a documentation review do not have the same optimization target.

---

# 12. Make the router adaptive through evaluation

This is where Draftly's architecture gives you a major advantage.

Your README already has an evaluation framework that scores:

- groundedness
- correctness
- completeness
- relevance
- documentation quality

and feeds failure analysis back into the system.

Use that data for routing.

The loop becomes:

```text
Agent
 │
 ▼
Router
 │
 ▼
Model
 │
 ▼
Output
 │
 ▼
Evaluation
 │
 ├── groundedness
 ├── correctness
 ├── completeness
 ├── relevance
 └── quality
 │
 ▼
Routing Performance Store
 │
 ▼
Future routing decisions
```

This is what makes the router **adaptive**.

---

# 13. Store performance by task, not just model

Don't record:

```text
Claude = 92%
```

That's too coarse.

Record:

```text
model
+
task type
+
agent role
+
workflow
+
complexity bucket
+
context size bucket
```

For example:

```text
Model:
Claude Sonnet

Role:
documentation_engineer

Task:
API documentation

Complexity:
high

Context:
large

Score:
0.94
```

Another record:

```text
Model:
Claude Sonnet

Role:
support_engineer

Task:
support question

Complexity:
low

Score:
0.86
```

The router can discover that:

> Claude is excellent for complex documentation generation but unnecessarily expensive for simple support questions.

---

# 14. Use Bayesian/EMA performance rather than raw averages

Don't let one successful request suddenly change routing.

Use an exponentially weighted moving average:

```text
new_score =
    α × latest_score
    +
    (1 - α) × previous_score
```

For example:

```text
α = 0.05
```

This gives recent results more influence without making the router unstable.

Even better, store:

```text
sample_count
mean
variance
confidence
```

Then:

```text
1000 observations
```

should have more influence than:

```text
3 observations
```

---

# 15. Introduce exploration

An adaptive router can get stuck.

Imagine it discovers:

```text
Model A = excellent
```

and always uses A.

Then it never learns whether:

```text
Model B
```

has become better.

So use an exploration mechanism.

For example:

```text
90% exploitation
10% exploration
```

Meaning:

```text
90% → current best model
10% → eligible alternative
```

But exploration should be controlled.

Never explore on:

```text
high-risk production delivery
```

without guardrails.

For example:

```text
support → 10% exploration
research → 10%
documentation generation → 5%
review → 2%
delivery → 0%
```

This is particularly important because Draftly has a human review gate before publication.

---

# 16. Use the human review gate as another signal

This is an extremely useful Draftly-specific signal.

Your architecture already has:

```text
Agent
 ↓
Human Review Gate
 ↓
approved
```

or:

```text
Agent
 ↓
Human Review Gate
 ↓
changes requested
 ↓
Feedback
```

Capture that.

For example:

```text
Model A
    100 generations
    92 approved
    8 revisions

Model B
    100 generations
    74 approved
    26 revisions
```

That becomes a powerful quality signal.

You can create:

```text
human_approval_rate
```

and feed it into model performance.

---

# 17. Don't let the router learn directly from every signal

You need signal quality.

I'd categorize signals:

### Strong

```text
DeepEval score
human approval
human rejection
production failure
tool execution failure
```

### Medium

```text
retry count
latency
timeout
provider error
```

### Weak

```text
token count
raw model confidence
LLM self-rating
```

Then weight them accordingly.

---

# 18. Routing should be two-stage

For production Draftly, I recommend:

```text
                  Request
                     │
                     ▼
             Candidate Filter
                     │
             20 possible models
                     │
                     ▼
             Adaptive Scorer
                     │
              top 3 models
                     │
                     ▼
             Final Selector
                     │
                     ▼
                Model #1
```

This is much safer than allowing a complicated scoring algorithm to consider every model.

---

# 19. Add fallback after selection

Selection and fallback should be separate.

For example:

```text
Selected:
Claude Sonnet
       │
       ▼
Invocation
       │
    timeout
       │
       ▼
Fallback #1:
Kimi
       │
    failure
       │
       ▼
Fallback #2:
Nova
```

Your factory already has the concept of fallback chains through:

```python
FALLBACKS
validate_fallback_chain()
```

and `AgentModelPolicy` currently binds roles to those chains.

Keep that mechanism.

The adaptive router should determine:

```text
primary candidate
```

while the fallback mechanism determines:

```text
what happens if invocation fails
```

---

# 20. Don't use the same adaptive logic for fallback

This is subtle but important.

Primary selection:

```text
Optimize quality + cost + latency + historical performance
```

Fallback:

```text
Optimize availability + capability compatibility
```

If the primary model fails, don't spend another 500 ms running the entire optimization algorithm.

Have a precomputed fallback chain:

```text
Primary
 ↓
Fallback 1
 ↓
Fallback 2
 ↓
Emergency model
```

---

# 21. Add circuit breakers

Production model routing needs circuit breakers.

For example:

```text
OpenRouter
   │
   ├── 20% errors
   └── repeated timeouts
          ↓
       OPEN
```

Once OPEN:

```text
Don't route requests
```

After a cooldown:

```text
OPEN
 ↓
HALF_OPEN
 ↓
test request
 ↓
success → CLOSED
failure → OPEN
```

Your existing `ProviderHealthRegistry` should own this state rather than the adaptive scoring engine. The factory already creates that health registry alongside the model registry.

---

# 22. Add model-level circuit breakers too

Don't only track:

```text
Bedrock = healthy
```

Track:

```text
Bedrock
 ├── Claude = healthy
 ├── Nova = healthy
 └── model-X = degraded
```

A provider can be healthy while a particular model is failing.

---

# 23. Cost-aware routing

Your current `ModelConfig` examples expose model IDs, capabilities, priorities and max tokens, but the shown factory does not expose pricing metadata.

For production adaptive routing, add:

```python
ModelCost:
    input_cost_per_1m_tokens
    output_cost_per_1m_tokens
```

Then estimate:

```text
estimated_cost =
    input_tokens × input_price
    +
    output_tokens × output_price
```

before selection.

This lets the router answer:

> Can I use a cheaper model without violating the quality requirement?

---

# 24. Add latency budgets

For Draftly:

### Interactive Slack support

```text
target: < 5 seconds
```

### GitHub issue response

```text
target: < 15 seconds
```

### Documentation generation

```text
target: < 60 seconds
```

### Evaluation

```text
latency less important
```

The router can therefore choose differently depending on workflow.

---

# 25. Add quality floors

This is critical.

Don't let the router optimize cost until quality collapses.

For example:

```text
support:
    minimum quality = 0.80

documentation:
    minimum quality = 0.90

documentation review:
    minimum quality = 0.93

delivery:
    minimum quality = 0.95
```

Then:

```text
Candidate A
quality = 0.97
cost = high

Candidate B
quality = 0.91
cost = low

minimum = 0.90

→ B wins
```

But:

```text
minimum = 0.95

→ B is eliminated
→ A wins
```

---

# 26. Your existing priorities should become tie-breakers, not the main routing mechanism

You currently have provider/model priorities.

For example:

```text
Mantle priority = 3
Bedrock priority = 5
NVIDIA priority = 10
Requesty priority = 20
...
```

Don't throw these away.

Use them as:

```text
final deterministic tie-breaker
```

rather than:

```text
priority = routing decision
```

Otherwise adaptive routing can't really adapt.

---

# 27. The router API

I'd make the public API extremely simple.

Conceptually:

```python
result = await model_router.route(
    RoutingRequest(
        role="documentation_engineer",
        task_type="documentation_generation",
        required_capabilities={
            "reasoning",
            "tool_calling",
            "structured_output",
        },
        complexity=0.82,
        context_tokens=32000,
        quality_requirement=0.90,
        latency_budget_ms=60000,
    )
)
```

The result should contain:

```python
RoutingDecision(
    model_name="reasoning-mantle-kimi-k2-5",
    provider="mantle",
    model_id="moonshotai.kimi-k2.5",

    score=0.91,

    candidates=[
        ...
    ],

    reason_codes=[
        "required_capabilities_match",
        "high_task_performance",
        "healthy_provider",
        "within_cost_budget",
    ],

    fallback_chain=[
        ...
    ],

    routing_policy="documentation_generation",
)
```

The `reason_codes` are important for debugging.

---

# 28. Never make routing opaque

You should be able to inspect a production decision and see:

```text
Routing decision
────────────────────────────

Request:
documentation_generation

Role:
documentation_engineer

Complexity:
0.87

Required capabilities:
reasoning
tool_calling
structured_output

Candidates:
────────────────────────────
Claude Sonnet     0.91
Kimi K2.5         0.94   ← selected
GPT-5.6           0.92
Nova Pro          0.84

Selection:
Kimi K2.5

Reasons:
✓ capability match
✓ quality floor satisfied
✓ provider healthy
✓ lowest estimated cost among high-quality candidates
✓ strong historical performance for documentation
```

This should go into your observability/audit system.

Your README already has observability covering tracing, metrics, audit and events.

---

# 29. Add routing telemetry

Every model invocation should produce something like:

```text
routing_decision
model_selected
provider
task_type
role
complexity
candidate_count
selection_score
estimated_cost
actual_cost
latency_ms
success
fallback_used
evaluation_score
human_approved
```

This gives you the dataset necessary for adaptive routing.

---

# 30. Connect it to your evaluation worker

This is where your existing architecture becomes powerful.

You already have:

```text
evaluation_worker
```

which runs evaluation loops.

Instead of evaluation ending at:

```text
score output
```

make it:

```text
score output
      │
      ▼
Failure analyzer
      │
      ▼
Routing performance updater
      │
      ▼
Model/task statistics
      │
      ▼
Adaptive router
```

So the complete learning loop becomes:

```text
                ┌──────────────────────┐
                │      Draftly Agent   │
                └──────────┬───────────┘
                           │
                           ▼
                   ┌───────────────┐
                   │ Adaptive      │
                   │ Router        │
                   └───────┬───────┘
                           │
                           ▼
                        Model
                           │
                           ▼
                        Output
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
        Evaluation                 Human review
              │                         │
              └────────────┬────────────┘
                           ▼
                   Outcome aggregation
                           │
                           ▼
                  Routing performance DB
                           │
                           ▼
                   Adaptive Router
```

That is the architecture I'd consider genuinely adaptive.

---

# 31. Where should the routing data live?

Given Draftly's architecture, I would put routing telemetry/performance into PostgreSQL rather than making the model router itself stateful.

Something like:

```text
routing_decisions
────────────────────────
id
request_id
organization_id
workflow
role
task_type
model
provider
complexity
context_tokens
selected_score
created_at


model_performance
────────────────────────
model
task_type
role
sample_count
quality_mean
quality_variance
success_rate
p50_latency
p95_latency
cost_mean
approval_rate
updated_at


provider_health
────────────────────────
provider
status
error_rate
timeout_rate
p95_latency
circuit_state
updated_at
```

This works naturally with the README's PostgreSQL + vector-searchable persistent memory architecture.

I would **not** put routing performance into the vector memory store. Routing statistics are structured operational data, not semantic memory.

---

# 32. Organization-level routing

Because Draftly is a platform, eventually routing should be scoped:

```text
global defaults
      ↓
organization policy
      ↓
workflow policy
      ↓
agent role policy
      ↓
task constraints
      ↓
adaptive selection
```

For example:

```text
Draftly global:
    all providers allowed

Organization A:
    Bedrock only

Organization B:
    cost ceiling = $0.05/request

Organization C:
    latency ceiling = 5 seconds
```

Then:

```text
Hard policy
    ↓
Adaptive routing
```

The router must **never override tenant security or provider restrictions**.

---

# 33. Recommended routing hierarchy

For Draftly, I'd implement this exact precedence:

```text
1. Security / tenant restrictions
             ↓
2. Required capabilities
             ↓
3. Context-window requirements
             ↓
4. Provider/model health
             ↓
5. Quality floor
             ↓
6. Workflow routing policy
             ↓
7. Adaptive performance
             ↓
8. Cost
             ↓
9. Latency
             ↓
10. Static priority
```

This prevents something like:

> "Model X is cheaper, therefore use it."

when Model X cannot perform the task.

---

# 34. How it works for your Draftly agents

Your existing agent roles are already well suited to this.

Your factory defines policies for:

- `documentation_engineer`
- `documentation_reviewer`
- `github_intelligence`
- `support_engineer`
- `support_reviewer`
- `research`
- `deepeval`
- `github_delivery`
- `memory_curator`

I'd turn each into a routing profile.

### Documentation engineer

```text
Quality: HIGH
Reasoning: HIGH
Context: HIGH
Latency: MEDIUM
Cost: MEDIUM
Exploration: LOW
```

### Support engineer

```text
Quality: MEDIUM-HIGH
Reasoning: LOW-MEDIUM
Context: MEDIUM
Latency: VERY HIGH
Cost: HIGH priority
Exploration: MEDIUM
```

### Documentation reviewer

```text
Quality: VERY HIGH
Reasoning: HIGH
Latency: LOW priority
Cost: LOW priority
Exploration: VERY LOW
```

### Memory curator

```text
Quality: MEDIUM
Reasoning: LOW
Latency: HIGH
Cost: VERY HIGH priority
```

---

# 35. Example: documentation generation

Imagine a GitHub PR modifies authentication.

The analyzer detects:

```text
documentation impact = HIGH
```

The documentation engineer requests:

```text
reasoning
tool_calling
structured_output
```

The router sees:

```text
context = 60k tokens
complexity = 0.91
quality floor = 0.92
```

Candidates:

```text
Claude       quality 0.96   cost high
GPT          quality 0.95   cost high
Kimi         quality 0.93   cost medium
Nova         quality 0.87   cost low
```

Nova is eliminated:

```text
0.87 < 0.92
```

Then:

```text
Claude = 0.91
GPT    = 0.89
Kimi   = 0.94
```

Router chooses:

```text
Kimi
```

Later DeepEval reports:

```text
groundedness = 0.97
correctness = 0.95
completeness = 0.94
relevance = 0.96
```

That improves Kimi's historical score for:

```text
documentation_engineer
+
high complexity
+
large context
```

The next similar task becomes more likely to select Kimi.

---

# 36. Example: support question

User asks in Slack:

> How do I rotate an API key?

Router receives:

```text
role = support_engineer
task = support_answer
complexity = 0.21
context = 4k
latency_budget = 5s
quality_floor = 0.85
```

The router might choose:

```text
fast-bedrock-claude
```

rather than:

```text
reasoning-mantle-gpt
```

because the task doesn't justify the additional cost/latency.

That is exactly where adaptive routing produces value.

---

# 37. One issue I would fix in your current factory

There appears to be a duplicated registration of:

```text
fast-openrouter
```

The factory registers it once around lines 353–369 and again around lines 371–387 with effectively the same configuration.

That should be cleaned up before building the adaptive layer because duplicate model registrations can create ambiguous candidate behavior depending on how `ModelRegistry.register_model()` handles duplicate names.

---

# 38. Another important change: separate model identity from model aliases

Right now names like:

```text
reasoning-mantle-gpt
fast-mantle-gpt
```

are useful logical aliases.

Keep them.

But internally distinguish:

```text
model_name
provider
model_id
capability_profile
routing_profile
```

For example:

```text
Logical model:
reasoning-mantle-gpt

Provider:
mantle

Actual model:
gpt-5.6-luna inference profile

Capabilities:
reasoning
tool_calling
structured_output
```

This allows you to change the actual model through environment configuration without rewriting routing policies. Your factory already uses environment variables to override model IDs, which is a good pattern to retain.

---

# 39. Production implementation sequence

I would **not** try to build the entire adaptive system at once.

### Phase 1 — Deterministic router

Implement:

```text
RoutingRequest
RoutingDecision
candidate filtering
capability matching
policy enforcement
health filtering
fallback
```

Your existing registry, capabilities, health and policies become the foundation.

### Phase 2 — Operational routing

Add:

```text
latency
cost
timeouts
circuit breakers
provider health
model health
routing telemetry
```

### Phase 3 — Adaptive routing

Add:

```text
model performance
task performance
workflow performance
human approval
DeepEval results
historical routing scores
```

### Phase 4 — Controlled exploration

Add:

```text
exploration rate
confidence
minimum sample count
canary models
```

### Phase 5 — Optimization

Eventually you can implement:

```text
contextual bandits
```

or another online-learning approach.

But I **wouldn't start there**.

For a hackathon/MVP, deterministic scoring + historical performance is much easier to explain, test, debug and demonstrate.

---

# 40. Final Draftly architecture

Putting everything together, I would evolve your README architecture from:

```text
AGENTS
   │
   ▼
MODEL ROUTER
   │
   ├── Bedrock
   ├── Mantle
   ├── OpenRouter
   ├── NVIDIA
   └── ...
```

into:

```text
                         ┌─────────────────────┐
                         │    Draftly Agents   │
                         │                     │
                         │ analyzer             │
                         │ researcher           │
                         │ writer               │
                         │ reviewer             │
                         │ auditor              │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │   Routing Request   │
                         └──────────┬──────────┘
                                    │
                                    ▼
                  ┌─────────────────────────────────┐
                  │         Adaptive Router          │
                  │                                 │
                  │ Tenant Policy                   │
                  │        ↓                        │
                  │ Capability Filter               │
                  │        ↓                        │
                  │ Context/Token Filter             │
                  │        ↓                        │
                  │ Health Filter                   │
                  │        ↓                        │
                  │ Quality Floor                   │
                  │        ↓                        │
                  │ Adaptive Scoring                │
                  │        ↓                        │
                  │ Exploration                     │
                  └───────────────┬─────────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
                 Bedrock        Mantle       OpenRouter
                    │             │             │
                 Models         Models        Models
                    │             │             │
                    └─────────────┼─────────────┘
                                  ▼
                         ┌─────────────────┐
                         │ Model Execution │
                         └────────┬────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    ▼                           ▼
              Observability                 Output
                    │                           │
                    │                    ┌──────┴──────┐
                    │                    ▼             ▼
                    │                 DeepEval     Human Review
                    │                    │             │
                    └────────────────────┴─────────────┘
                                  │
                                  ▼
                       ┌──────────────────────┐
                       │ Routing Performance  │
                       │      Store           │
                       └──────────┬───────────┘
                                  │
                                  ▼
                         Adaptive Router
```

That fits Draftly's existing event-driven, multi-agent architecture and its evaluation/feedback loop rather than introducing a competing architecture. The README explicitly describes Draftly as routing events through orchestration graphs and specialized agents, with persistent memory, evaluation, human review, and multi-provider model routing.

## The key design principle

The most important thing I'd recommend is:

> **Don't make the adaptive router an LLM that chooses another LLM.**

Instead:

```text
                    Policy
                      +
                Capabilities
                      +
                   Health
                      +
                 Cost/Latency
                      +
              Historical Quality
                      +
              Evaluation Feedback
                      ↓
              Deterministic scorer
                      ↓
                 Model choice
```

This makes Draftly's router **predictable, auditable, testable and adaptive**.

Your existing `factory.py` is already about halfway to this architecture: it has the provider registry, model registry, capabilities, health registry, fallback policies and role policies. The major missing piece is turning `ModelRouter` from a primarily policy/fallback selector into a **constraint → candidate → score → select → observe → learn** system.

And because Draftly already has evaluation, feedback, human review and persistent memory, it has unusually good signals for making that router genuinely adaptive.
