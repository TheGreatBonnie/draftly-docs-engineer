Yes. Your three handwritten workflows can be turned into a much stronger **production-oriented Draftly system** by treating them as three entry points into one documentation-intelligence platform rather than as three isolated automations.

The core product becomes:

> **Draftly continuously observes software changes and developer questions, connects those signals to the source of truth, detects documentation gaps and drift, generates or retrieves grounded answers and documentation changes, evaluates them, obtains human approval where required, and closes the loop by publishing the knowledge back into the project.**

This is also a very natural fit for the Strands **Graph** pattern: Graph supports deterministic agent dependencies, conditional routing, parallel branches, shared state, nested multi-agent systems, and cyclic feedback loops. ([Strands Agents SDK][1])

---

# 1. The production Draftly system

I would organize Draftly around **three documentation-intelligence loops**:

```text
                         ┌─────────────────────────────┐
                         │          DRAFTLY            │
                         │ Documentation Intelligence  │
                         └──────────────┬──────────────┘
                                        │
             ┌──────────────────────────┼──────────────────────────┐
             │                          │                          │
             ▼                          ▼                          ▼
      ┌─────────────┐           ┌─────────────┐           ┌─────────────┐
      │ GitHub PR   │           │ GitHub Issue│           │ Slack/Discord│
      │ Intelligence│           │ Intelligence│           │ Intelligence │
      └──────┬──────┘           └──────┬──────┘           └──────┬──────┘
             │                          │                          │
             └──────────────────────────┼──────────────────────────┘
                                        ▼
                              ┌───────────────────┐
                              │ Context + Memory  │
                              └─────────┬─────────┘
                                        ▼
                              ┌───────────────────┐
                              │ Research / Ground │
                              │ Truth Investigation│
                              └─────────┬─────────┘
                                        ▼
                              ┌───────────────────┐
                              │ Documentation     │
                              │ Intelligence      │
                              └─────────┬─────────┘
                                        ▼
                              ┌───────────────────┐
                              │ Generate / Retrieve│
                              └─────────┬─────────┘
                                        ▼
                              ┌───────────────────┐
                              │ Evaluation +      │
                              │ Quality Gates     │
                              └─────────┬─────────┘
                                        ▼
                              ┌───────────────────┐
                              │ Human Review      │
                              └─────────┬─────────┘
                                        ▼
                              ┌───────────────────┐
                              │ Delivery           │
                              └─────────┬─────────┘
                                        │
                         ┌──────────────┴──────────────┐
                         ▼                             ▼
                  Documentation                  Support response
                    / GitHub PR                 / GitHub / Slack
```

The important architectural change is that **support and GitHub Issues are no longer merely support-answer workflows**.

They become **documentation feedback sensors**.

---

# 2. Workflow A — GitHub PR → Documentation Intelligence

This is the workflow represented by your first notebook page.

## Production version

```text
GitHub PR opened / updated / merged
              │
              ▼
      Event validation
              │
              ▼
       PR understanding
              │
              ▼
       Changed-code analysis
              │
              ▼
     Change classification
              │
       ┌──────┼─────────┐
       │      │         │
       ▼      ▼         ▼
    Feature  API      Breaking
    change   change   change
       │      │         │
       └──────┼─────────┘
              ▼
     Documentation impact
              │
              ▼
       Search existing docs
              │
       ┌──────┴─────────┐
       │                │
       ▼                ▼
   Docs exist        Docs missing
       │                │
       ▼                ▼
 Identify sections   Create docs plan
 needing updates         │
       │                │
       └───────┬────────┘
               ▼
       Documentation draft
               │
               ▼
        Grounding check
               │
               ▼
        Documentation
          evaluation
               │
       ┌───────┴────────┐
       │                │
      FAIL             PASS
       │                │
       ▼                ▼
     Revise          Human review
       │                │
       └──────→─────────┤
                        ▼
                     Approved?
                    /        \
                  NO          YES
                  │            │
                  ▼            ▼
               Revise      Create PR
                                │
                                ▼
                           Human merge
                                │
                                ▼
                          Documentation
                             updated
```

---

## 2.1 Event intake

Draftly receives GitHub webhook events such as:

```text
pull_request.opened
pull_request.synchronize
pull_request.reopened
pull_request.closed
release.published
```

For the MVP, I'd prioritize:

```text
pull_request.opened
pull_request.synchronize
```

and optionally only process PRs whose changes actually affect product behavior.

---

# 3. PR analysis

Draftly shouldn't simply read the PR title.

It should investigate:

```text
PR
├── title
├── description
├── changed files
├── diff
├── commits
├── linked issues
├── labels
└── review comments
```

Then classify the change:

```text
Change classification

├── Documentation-only
├── Internal implementation
├── Bug fix
├── New feature
├── API change
├── Configuration change
├── Breaking change
├── Deprecation
└── Security/authentication change
```

This classification determines how aggressively Draftly responds.

---

# 4. Documentation impact analysis

This is one of Draftly's most important agents.

It asks:

> **"Given what changed in the software, what knowledge might now be wrong, incomplete, or missing?"**

For example:

```text
PR changes:

src/auth/refresh.py
src/api/oauth.py
tests/test_refresh.py

             ↓

Documentation impact

docs/authentication.md       HIGH
docs/oauth/refresh-tokens.md HIGH
docs/api/oauth.md            HIGH
docs/quickstart.md           LOW
docs/webhooks.md             NONE
```

The agent should provide evidence for every affected document.

---

# 5. New-feature documentation

Your handwritten note should become an explicit production rule:

```text
New feature
     ↓
Search documentation
     ↓
Relevant documentation?
     │
 ┌───┴────┐
YES       NO
 │         │
 ▼         ▼
Update   Create
existing new docs
docs
```

For example:

```text
PR:
Added Webhooks API

Search:
No Webhooks documentation found

Draftly creates:

docs/
└── webhooks/
    ├── overview.md
    ├── configuration.md
    └── examples.md
```

The human reviews the resulting PR before it becomes canonical documentation.

---

# 6. Workflow B — Slack/Discord → Documentation Feedback Loop

This is where I'd make your second workflow substantially more powerful.

Your original workflow is:

```text
Question
 ↓
Has it been asked before?
 ├── YES → retrieve solution → reply
 └── NO → find docs → generate solution
                    ↓
                human review
                    ↓
                  reply
```

Production Draftly should become:

```text
                  Support Question
                         │
                         ▼
                  Analyze question
                         │
                         ▼
                Search conversation memory
                         │
                  ┌──────┴──────┐
                  │             │
                MATCH         NO MATCH
                  │             │
                  ▼             ▼
          Retrieve solution   Search docs
                  │             │
                  │       ┌─────┴─────┐
                  │       │           │
                  │     COVERED     GAP
                  │       │           │
                  │       ▼           ▼
                  │   Generate      Research
                  │   grounded     source of
                  │    answer       truth
                  │       │           │
                  └───────┴─────┬─────┘
                                ▼
                         Evaluate answer
                                │
                        ┌───────┴───────┐
                        │               │
                       FAIL            PASS
                        │               │
                        ▼               ▼
                     Research      Human review
                        │               │
                        └───────→───────┤
                                        ▼
                                   Reply to user
                                        │
                                        ▼
                              Record support signal
                                        │
                                        ▼
                              Documentation analysis
                                        │
                              ┌─────────┴─────────┐
                              │                   │
                         No documentation     Documentation
                              gap                  gap
                              │                   │
                              ▼                   ▼
                            Done            Create/update docs
                                                  │
                                                  ▼
                                             Human review
                                                  │
                                                  ▼
                                               Publish
```

This is the version I'd actually build.

---

# 7. Why support questions become documentation intelligence

Suppose 20 developers ask:

> "How do I rotate an API key?"

Draftly shouldn't treat these as 20 independent conversations.

It should create a knowledge signal:

```text
Topic: API key rotation

Occurrences:
Slack      8
Discord    7
GitHub     5

Total: 20

Documentation coverage:
LOW

Documentation gap:
HIGH
```

Now Draftly has discovered:

> **The documentation isn't answering a recurring developer question.**

That's extremely valuable.

---

# 8. Support-question memory

I'd maintain a support knowledge model:

```text
SupportQuestion
├── question_id
├── source
├── source_message_id
├── repository
├── topic
├── normalized_question
├── embedding
├── answer_status
├── related_documents
├── related_code
├── related_issues
├── confidence
└── created_at
```

Then semantically cluster questions.

For example:

```text
                    Support Questions
                           │
                    semantic search
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
           Question A   Question B   Question C
              │            │            │
              └────────────┼────────────┘
                           ▼
                    "API key rotation"
                           │
                           ▼
                  Documentation gap
                           │
                           ▼
                    Documentation
                       workflow
```

This is what turns Draftly into **documentation intelligence**, rather than simply an AI support bot.

---

# 9. Workflow C — GitHub Issues → Documentation Intelligence

Your third workflow should follow the same principle.

Production version:

```text
GitHub Issue
     │
     ▼
Validate / classify
     │
     ▼
Understand issue
     │
     ▼
Search historical issues
     │
     ▼
Search Slack / Discord
     │
     ▼
Search documentation
     │
     ▼
Search code / PRs / releases
     │
     ▼
Build evidence
     │
     ▼
Is there an existing verified solution?
     │
   ┌─┴─────────────┐
   │               │
  YES              NO
   │               │
   ▼               ▼
Retrieve       Investigate
solution       source of truth
   │               │
   └───────┬───────┘
           ▼
      Generate response
           │
           ▼
        Evaluate
           │
      ┌────┴────┐
     FAIL      PASS
      │          │
      ▼          ▼
    Revise    Human review
                 │
                 ▼
             Respond
                 │
                 ▼
       Documentation analysis
                 │
          ┌──────┴──────┐
          │             │
       Covered         Gap
          │             │
          ▼             ▼
         End       Documentation
                    improvement
                         │
                         ▼
                    Human review
                         │
                         ▼
                      Publish
```

---

# 10. Classify GitHub Issues before answering

A production implementation shouldn't treat every GitHub Issue as a support question.

Use:

```text
GitHub Issue
      ↓
Issue classifier
      │
      ├── Bug
      ├── Support question
      ├── Documentation issue
      ├── Feature request
      ├── API problem
      ├── Configuration problem
      └── Unknown
```

Then:

### Support question

→ answer workflow

### Documentation issue

→ documentation workflow

### Bug

→ investigate + provide known workaround / status

### Feature request

→ acknowledge / route to product process

### API problem

→ investigate code + docs + release history

This makes the GitHub integration production-grade.

---

# 11. The crucial feedback loop

The support and issue systems should feed information **back into the documentation system**.

```text
             Developer ecosystem
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
    Slack         Discord       GitHub
       │             │             │
       └─────────────┼─────────────┘
                     ▼
              Developer questions
                     │
                     ▼
               Draftly Memory
                     │
                     ▼
             Question clustering
                     │
                     ▼
          Documentation coverage
                 analysis
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
     Documentation          Documentation
       covered                  gap
          │                     │
          ▼                     ▼
       Answer              Research + Draft
                                │
                                ▼
                           Human Review
                                │
                                ▼
                              Publish
                                │
                                ▼
                       Updated documentation
                                │
                                ▼
                      Future questions answered
                         more accurately
```

This is the **Documentation Feedback Loop**.

---

# 12. The complete Draftly intelligence loop

There is an even bigger loop when PRs are included:

```text
                         ┌───────────────┐
                         │     CODE      │
                         └───────┬───────┘
                                 │
                              PR/change
                                 │
                                 ▼
                       ┌───────────────────┐
                       │ Documentation     │
                       │ Impact Analysis   │
                       └─────────┬─────────┘
                                 │
                                 ▼
                       ┌───────────────────┐
                       │ Documentation     │
                       │ Updated           │
                       └─────────┬─────────┘
                                 │
                                 ▼
                       Developers consume
                           documentation
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
                  Success                 Confusion
                                              │
                                   ┌──────────┴──────────┐
                                   ▼                     ▼
                                Slack                 GitHub
                                Discord                 Issues
                                   │                     │
                                   └──────────┬──────────┘
                                              ▼
                                      Draftly Intelligence
                                              │
                                              ▼
                                    Detect documentation
                                             gaps
                                              │
                                              ▼
                                      Update documentation
                                              │
                                              └──────→ CODE
```

This is the **core product loop I'd present to the judges**.

---

# 13. Production-ready unified Draftly Graph

Now combine everything into one Strands Graph.

```text
                           ┌──────────────────────┐
                           │      EVENT BUS       │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │  EVENT INGESTION     │
                           │  + VALIDATION        │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │   EVENT CLASSIFIER   │
                           └──────────┬───────────┘
                                      │
                ┌─────────────────────┼─────────────────────┐
                │                     │                     │
                ▼                     ▼                     ▼
        ┌───────────────┐     ┌───────────────┐     ┌───────────────┐
        │ GitHub PR     │     │ GitHub Issue  │     │ Slack/Discord │
        │ Workflow      │     │ Workflow      │     │ Workflow      │
        └───────┬───────┘     └───────┬───────┘     └───────┬───────┘
                │                     │                     │
                ▼                     ▼                     ▼
        ┌───────────────┐     ┌───────────────┐     ┌───────────────┐
        │ Code/PR       │     │ Issue         │     │ Question      │
        │ Analysis      │     │ Analysis      │     │ Analysis      │
        └───────┬───────┘     └───────┬───────┘     └───────┬───────┘
                │                     │                     │
                └─────────────────────┼─────────────────────┘
                                      ▼
                           ┌──────────────────────┐
                           │   CONTEXT + MEMORY   │
                           │                      │
                           │ GitHub               │
                           │ Slack               │
                           │ Discord             │
                           │ Documentation       │
                           │ Releases            │
                           │ Historical answers  │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │ RESEARCH / GROUNDING │
                           │                      │
                           │ Code                 │
                           │ PRs                  │
                           │ Issues               │
                           │ Support              │
                           │ Docs                 │
                           │ Releases             │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │ DOCUMENTATION        │
                           │ IMPACT ANALYSIS      │
                           └──────────┬───────────┘
                                      │
                    ┌─────────────────┼──────────────────┐
                    │                 │                  │
                    ▼                 ▼                  ▼
              ┌──────────┐      ┌──────────┐      ┌──────────┐
              │ Answer   │      │ Update   │      │ Create   │
              │ Existing │      │ Docs     │      │ New Docs │
              └────┬─────┘      └────┬─────┘      └────┬─────┘
                   │                 │                  │
                   └─────────────────┼──────────────────┘
                                     ▼
                           ┌──────────────────────┐
                           │ GENERATION /         │
                           │ RETRIEVAL            │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │ EVALUATION /        │
                           │ QUALITY GATES       │
                           └──────────┬───────────┘
                                      │
                          ┌───────────┴───────────┐
                          │                       │
                        FAIL                    PASS
                          │                       │
                          ▼                       ▼
                    ┌───────────┐       ┌──────────────────┐
                    │ RESEARCH /│       │ HUMAN REVIEW     │
                    │ REVISION  │       └────────┬─────────┘
                    └─────┬─────┘                │
                          │                 ┌─────┴─────┐
                          └───────────────→ │           │
                                           ▼           ▼
                                         REJECT      APPROVE
                                           │           │
                                           ▼           ▼
                                        REVISE      DELIVERY
                                                       │
                              ┌────────────────────────┼──────────────────────┐
                              ▼                        ▼                      ▼
                         GitHub PR              GitHub reply          Slack/Discord
                         / commit                                       response
                              │
                              ▼
                      Documentation store
                              │
                              ▼
                       Memory / telemetry
                              │
                              └──────────→ Future runs
```

---

# 14. Complete production-ready Draftly architecture

The workflow is only half of the system. Here's the architecture I'd recommend.

```text
╔══════════════════════════════════════════════════════════════════════════════╗
║                              DRAFTLY PLATFORM                               ║
║                    Autonomous Documentation Engineering                     ║
╚══════════════════════════════════════════════════════════════════════════════╝


 ┌────────────────────────────── EXPERIENCE LAYER ─────────────────────────────┐
 │                                                                             │
 │   Draftly Web App                                                           │
 │   ├── Runs / executions                                                     │
 │   ├── Documentation changes                                                 │
 │   ├── Support intelligence                                                  │
 │   ├── Documentation gaps                                                    │
 │   ├── Human approvals                                                       │
 │   ├── Evaluation results                                                    │
 │   └── Agent activity / traces                                               │
 │                                                                             │
 └──────────────────────────────────┬──────────────────────────────────────────┘
                                    │
                                    ▼
 ┌────────────────────────────── API / CONTROL LAYER ──────────────────────────┐
 │                                                                             │
 │   API Gateway / Backend                                                     │
 │   ├── Authentication / authorization                                        │
 │   ├── Project management                                                    │
 │   ├── Workflow management                                                   │
 │   ├── Human review API                                                      │
 │   ├── Webhook ingestion                                                     │
 │   └── Run status API                                                        │
 │                                                                             │
 └──────────────────────────────────┬──────────────────────────────────────────┘
                                    │
                                    ▼
 ┌──────────────────────────── EVENT INGESTION LAYER ──────────────────────────┐
 │                                                                             │
 │   GitHub Webhooks          Slack Events          Discord Events              │
 │        │                       │                       │                     │
 │        └───────────────────────┼───────────────────────┘                     │
 │                                ▼                                             │
 │                     Event normalization                                      │
 │                                │                                             │
 │                     Idempotency / validation                                │
 │                                │                                             │
 │                     Event → Draftly Task                                    │
 │                                                                             │
 └──────────────────────────────────┬──────────────────────────────────────────┘
                                    │
                                    ▼
 ┌──────────────────────────── STRANDS AGENT LAYER ────────────────────────────┐
 │                                                                             │
 │                          DRAFTLY GRAPH                                      │
 │                                                                             │
 │  ┌──────────────┐    ┌──────────────┐    ┌────────────────┐               │
 │  │ Event        │ →  │ Context      │ →  │ Research       │               │
 │  │ Classifier   │    │ Agent        │    │ Agent/Swarm    │               │
 │  └──────────────┘    └──────────────┘    └───────┬────────┘               │
 │                                                  │                         │
 │                                                  ▼                         │
 │                                      ┌──────────────────────┐              │
 │                                      │ Documentation Impact │              │
 │                                      │ Agent                │              │
 │                                      └──────────┬───────────┘              │
 │                                                 │                          │
 │                           ┌─────────────────────┼─────────────────────┐    │
 │                           ▼                     ▼                     ▼    │
 │                     Answer Agent          Update Agent           Create Agent│
 │                           │                     │                     │    │
 │                           └─────────────────────┼─────────────────────┘    │
 │                                                 ▼                          │
 │                                      ┌──────────────────────┐              │
 │                                      │ Evaluation Agent     │              │
 │                                      └──────────┬───────────┘              │
 │                                                 │                          │
 │                                       ┌─────────┴─────────┐                │
 │                                       ▼                   ▼                │
 │                                    Revise              Review              │
 │                                       │                   │                │
 │                                       └──────────┐        │                │
 │                                                  ▼        ▼                │
 │                                               Delivery                     │
 │                                                                             │
 │   Strands Graph provides:                                                   │
 │   • conditional routing                                                     │
 │   • shared state                                                           │
 │   • parallel branches                                                       │
 │   • feedback cycles                                                         │
 │   • nested agents / Swarms                                                  │
 │   • execution limits / timeouts                                             │
 │   • human interrupt/resume                                                  │
 │                                                                             │
 └──────────────────────────────────┬──────────────────────────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
 ┌─────────────────────┐  ┌─────────────────────┐  ┌────────────────────────┐
 │ TOOL / INTEGRATION  │  │ KNOWLEDGE / MEMORY  │  │ EVALUATION / OBSERVABILITY│
 │ LAYER               │  │ LAYER               │  │ LAYER                   │
 │                     │  │                     │  │                        │
 │ GitHub tools        │  │ CockroachDB         │  │ DeepEval               │
 │ Slack tools         │  │                     │  │ Strands hooks          │
 │ Discord tools       │  │ Relational data     │  │ Run traces             │
 │ Git tools           │  │ Vector search       │  │ Agent metrics           │
 │ Filesystem tools    │  │ Support history     │  │ Tool metrics            │
 │ Documentation tools │  │ Doc versions        │  │ Evaluation history      │
 │ Search tools        │  │ Agent runs          │  │ Failure analysis        │
 │ MCP tools           │  │ Findings             │  │ Audit logs              │
 └──────────┬──────────┘  └──────────┬──────────┘  └───────────┬────────────┘
            │                        │                         │
            └────────────────────────┼─────────────────────────┘
                                     ▼
 ┌──────────────────────────── DELIVERY LAYER ─────────────────────────────────┐
 │                                                                             │
 │  GitHub                         Slack                       Discord          │
 │  ├── Branch                     ├── Answer                  ├── Answer      │
 │  ├── Commit                     ├── Thread                  ├── Thread      │
 │  ├── PR                         └── Notification             └── Notification│
 │  └── Comment                                                                 │
 │                                                                             │
 │                         Documentation Repository                             │
 │                                │                                            │
 │                         Human-approved                                      │
 │                         documentation                                       │
 │                                                                             │
 └─────────────────────────────────────────────────────────────────────────────┘


 ┌──────────────────────────── PLATFORM / INFRASTRUCTURE ──────────────────────┐
 │                                                                             │
 │   AWS                                                                       │
 │   ├── Compute / Agent runtime                                               │
 │   ├── Secrets / IAM                                                         │
 │   ├── Event infrastructure                                                  │
 │   ├── Logs / monitoring                                                     │
 │   └── Deployment                                                            │
 │                                                                             │
 │   CockroachDB                                                               │
 │   ├── Persistent application state                                           │
 │   ├── Agent run history                                                     │
 │   ├── Documentation metadata                                                │
 │   ├── Support-question memory                                               │
 │   └── Vector retrieval                                                      │
 │                                                                             │
 └─────────────────────────────────────────────────────────────────────────────┘
```

---

# 15. The logical architecture

I'd divide Draftly into **seven layers**.

| Layer                    | Responsibility                                         |
| ------------------------ | ------------------------------------------------------ |
| Experience               | Dashboard, approvals, runs, documentation intelligence |
| API/control              | Authentication, projects, webhooks, workflow control   |
| Ingestion                | GitHub, Slack, Discord events                          |
| Agent orchestration      | Strands Graph                                          |
| Tools                    | GitHub, Slack, Discord, filesystem, docs, MCP          |
| Memory                   | CockroachDB + semantic retrieval                       |
| Evaluation/observability | DeepEval + Strands hooks + traces                      |
| Delivery                 | PRs, comments, Slack/Discord responses, docs           |

---

# 16. Strands Graph should be the orchestration spine

This is where I'd make a very deliberate architectural decision.

**Don't build Draftly as one giant Strands Agent.**

Instead:

```text
                DRAFTLY GRAPH
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
     Agent         Agent          Agent
       │             │             │
       ▼             ▼             ▼
    Research       Impact        Writing
       │             │             │
       └─────────────┼─────────────┘
                     ▼
                  Evaluate
                     │
                ┌────┴────┐
                ▼         ▼
              Revise    Review
                           │
                           ▼
                        Deliver
```

The current Strands Graph supports agents, custom nodes, nested Graph/Swarm systems, conditional edges and cyclic topologies, making it a good fit for this controlled-but-adaptive workflow. ([Strands Agents SDK][1])

---

# 17. Use nested Swarm only for research

I would **not** use Swarm for the entire Draftly workflow.

Instead:

```text
Draftly Graph
      │
      ▼
 Research Node
      │
      ▼
   Research Swarm
      │
 ┌────┼─────┬──────┐
 ▼    ▼     ▼      ▼
GitHub Slack Discord Docs
Agent  Agent Agent  Agent
 └────┬─────┴──────┘
      ▼
 Evidence synthesis
      │
      ▼
 Draftly Graph continues
```

This gives you:

**Graph = governance**

**Swarm = exploration**

That's an excellent combination.

Strands explicitly supports nesting multi-agent systems such as Swarms or Graphs as Graph nodes. ([Strands Agents SDK][1])

---

# 18. Production-grade shared state

Your Graph should maintain state such as:

```python
DraftlyState
├── run_id
├── project_id
├── repository
├── event
├── event_type
├── actor
│
├── issue
├── pull_request
├── support_question
│
├── evidence[]
├── related_events[]
├── related_documents[]
│
├── documentation_impact
├── documentation_changes[]
│
├── generated_response
├── evaluation
│
├── review_status
├── reviewer
├── approval
│
├── delivery_status
└── audit_metadata
```

Strands Graph supports shared state across agents and exposes execution state/results, while invocation state can carry runtime context without putting it into prompts. ([Strands Agents SDK][2])

---

# 19. Human-in-the-loop architecture

I would make human review a **first-class system capability**, not just a UI button.

```text
                     Agent generates artifact
                              │
                              ▼
                         Evaluation
                              │
                              ▼
                       Risk assessment
                              │
                  ┌───────────┴───────────┐
                  │                       │
              Low risk                High risk
                  │                       │
                  ▼                       ▼
             Review queue            Review queue
                  │                       │
                  └───────────┬───────────┘
                              ▼
                         Human reviewer
                         /            \
                       Approve       Reject
                         │             │
                         ▼             ▼
                      Deliver       Revise
                                       │
                                       └────→ Evaluation
```

Strands supports interrupts across multi-agent patterns and session-based resume behavior, which is useful for implementing this pause/resume boundary. ([Strands Agents SDK][3])

---

# 20. Production evaluation architecture

I'd have **two levels of evaluation**.

### Runtime evaluation

Every Draftly output gets evaluated:

```text
Answer / Documentation
       │
       ▼
┌─────────────────────────┐
│ Grounding               │
│ Factual correctness     │
│ Completeness            │
│ Consistency             │
│ Source coverage         │
│ Safety                  │
└───────────┬─────────────┘
            ▼
        Evaluation
          score
```

### Build-time evaluation

DeepEval evaluates the entire Draftly system against a golden dataset.

```text
Golden dataset
     ↓
Draftly
     ↓
Expected behavior
     ↓
DeepEval
     ↓
Regression report
     ↓
Improve agents/prompts/tools
```

This lets Draftly itself follow a build/evaluation loop rather than relying solely on human testing.

---

# 21. Observability

Every run should produce something like:

```text
RUN: dr_019283

Event:
GitHub PR #142

Duration:
18.4 seconds

Agents:
✓ EventClassifier       0.8s
✓ PRAnalyzer            2.1s
✓ ContextAgent          2.9s
✓ ResearchSwarm         4.8s
✓ DocumentationImpact   1.7s
✓ DocumentationWriter   2.8s
✓ Evaluator             1.9s

Evidence:
12 sources

Documentation:
3 files affected

Evaluation:
94.7%

Human:
Awaiting approval
```

Strands hooks are specifically designed for monitoring agent execution, tool calls, multi-agent transitions, validation, metrics, and error handling. ([Strands Agents SDK][4])

---

# 22. Failure handling

Production Draftly should never assume an agent succeeds.

Every major stage needs:

```text
Agent
 │
 ├── success → continue
 │
 ├── retryable failure → retry
 │
 ├── insufficient evidence → research
 │
 ├── confidence too low → human
 │
 └── unrecoverable failure → incident
```

For example:

```text
Research Agent
      │
      ▼
No reliable source
      │
      ▼
Expand search
      │
      ▼
Still uncertain
      │
      ▼
Human escalation
```

Don't let the model hallucinate an answer just because the workflow expects an answer.

---

# 23. Idempotency is critical

Suppose GitHub sends:

```text
pull_request.synchronize
```

twice.

Draftly must not create two documentation PRs.

Use:

```text
event_id
+
project_id
+
workflow_type
```

as an idempotency key.

Likewise:

```text
Slack message ID
Discord message ID
GitHub issue ID
GitHub PR SHA
```

should be persisted.

---

# 24. Audit trail

For every generated artifact, store:

```text
Who/what triggered it
        ↓
What evidence was used
        ↓
Which agents ran
        ↓
Which tools were called
        ↓
What was generated
        ↓
What evaluation produced
        ↓
Who approved it
        ↓
What was published
```

This is especially important because Draftly is taking actions against real project repositories and developer communication channels.

---

# 25. Recommended Draftly database model

At minimum:

```text
projects
repositories
events
agent_runs
agent_steps

documents
document_versions
documentation_changes

support_questions
support_clusters
support_answers

github_issues
github_pull_requests

research_findings
evidence

evaluations
evaluation_runs

human_reviews
approvals

deliveries
notifications
audit_logs
```

And the particularly valuable relationship is:

```text
support_question
      │
      ├── related_issue
      ├── related_pr
      ├── related_document
      ├── related_release
      ├── research_finding
      └── documentation_change
```

This creates a **knowledge graph-like relational model** even if you implement it primarily in CockroachDB.

---

# 26. The most important entity: Documentation Gap

I'd actually make **DocumentationGap** a first-class Draftly concept.

```text
DocumentationGap
├── gap_id
├── project_id
├── topic
├── severity
├── evidence_count
├── affected_documents
├── related_support_questions
├── related_issues
├── related_prs
├── source_of_truth
├── recommended_action
├── status
└── confidence
```

Example:

```text
DOCUMENTATION GAP

Topic:
OAuth refresh token expiration

Evidence:
17 support questions
3 GitHub issues
1 PR
2 outdated docs

Severity:
HIGH

Recommendation:
Update OAuth refresh token documentation

Status:
Awaiting human review
```

This would be an excellent feature for the Draftly dashboard.

---

# 27. The Draftly dashboard then becomes much more meaningful

Instead of just showing "agent runs," show:

```text
DRAFTLY
────────────────────────────────────────────

Documentation Health

Documentation gaps       12
Recurring questions       37
Outdated docs               8
Open doc PRs                4
Pending reviews             3

────────────────────────────────────────────

Documentation Intelligence

HIGH PRIORITY

OAuth refresh tokens
17 questions · 3 issues
→ Documentation gap detected

API key rotation
12 questions · 1 issue
→ Documentation insufficient

Webhooks
New feature · no documentation
→ Documentation required

────────────────────────────────────────────

Recent Activity

✓ PR #142 → docs update generated
✓ Discord question → existing answer found
✓ Issue #88 → documentation gap detected
⏳ PR #154 → awaiting review
```

Now the UI communicates the **product value**, not just the underlying agents.

---

# 28. Recommended final Draftly architecture

If I were implementing this for the hackathon, I'd settle on this architecture:

```text
                         ┌─────────────────────────────┐
                         │          DRAFTLY            │
                         │ Documentation Intelligence  │
                         └──────────────┬──────────────┘
                                        │
 ┌──────────────────────────────────────┼────────────────────────────────────┐
 │                                      │                                    │
 ▼                                      ▼                                    ▼
GitHub                               Slack                               Discord
 │                                      │                                    │
 ▼                                      ▼                                    ▼
PR / Issue                         Questions                            Questions
 │                                      │                                    │
 └──────────────────────────────┬───────┴────────────────────────────────────┘
                                ▼
                     ┌───────────────────────┐
                     │ Event Normalization   │
                     │ Idempotency           │
                     │ Classification        │
                     └───────────┬───────────┘
                                 ▼
                     ┌───────────────────────┐
                     │     STRANDS GRAPH     │
                     │                       │
                     │ ┌───────────────────┐ │
                     │ │ Context Agent     │ │
                     │ └────────┬──────────┘ │
                     │          ▼            │
                     │ ┌───────────────────┐ │
                     │ │ Research Swarm    │ │
                     │ │ GitHub / Slack /  │ │
                     │ │ Discord / Docs    │ │
                     │ └────────┬──────────┘ │
                     │          ▼            │
                     │ ┌───────────────────┐ │
                     │ │ Impact Agent      │ │
                     │ └────────┬──────────┘ │
                     │          ▼            │
                     │ ┌───────────────────┐ │
                     │ │ Answer / Update / │ │
                     │ │ Create Agent      │ │
                     │ └────────┬──────────┘ │
                     │          ▼            │
                     │ ┌───────────────────┐ │
                     │ │ Evaluation Agent  │ │
                     │ └────────┬──────────┘ │
                     │          │            │
                     │     FAIL │ PASS       │
                     │       ↙  │  ↘         │
                     │   Revise │ Review     │
                     │       ↖  │    │       │
                     │          │    ▼       │
                     │          │ Approve    │
                     │          │    │       │
                     │          └────┼───────┤
                     │               ▼       │
                     │          Delivery     │
                     └───────────────┬───────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
        GitHub PR/Comment       Slack/Discord           Docs Repo
              │                      │                      │
              └──────────────────────┼──────────────────────┘
                                     ▼
                          ┌───────────────────────┐
                          │     COCKROACHDB       │
                          │                       │
                          │ Events                │
                          │ Support questions     │
                          │ Documentation         │
                          │ Evidence              │
                          │ Runs                  │
                          │ Evaluations           │
                          │ Reviews               │
                          │ Documentation gaps    │
                          └───────────┬───────────┘
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                   Vector retrieval          Analytics
                         │
                         └────────────┬────────────┘
                                      ▼
                          Documentation Intelligence
                                      │
                                      └──────────→ Future runs


        ┌────────────────────────────────────────────────────────┐
        │                 EVALUATION + OBSERVABILITY              │
        │                                                        │
        │ Strands Hooks → traces / metrics / tool activity      │
        │ DeepEval → regression / quality / golden datasets      │
        │ Audit Logs → evidence / approvals / deliveries        │
        └────────────────────────────────────────────────────────┘
```

---

# 29. The architectural philosophy

The most important thing is that Draftly should **not** be positioned as three agents:

```text
PR Agent
Issue Agent
Support Agent
```

That's too shallow.

Position it as:

### **A documentation intelligence system with three event surfaces.**

```text
                 ┌─────────────────────────┐
                 │       DRAFTLY           │
                 │                         │
                 │ Documentation           │
                 │ Intelligence Engine     │
                 └────────────┬────────────┘
                              │
             ┌────────────────┼────────────────┐
             ▼                ▼                ▼
          CHANGE           CONFUSION        REQUEST
             │                │                │
          GitHub PR        Slack/Discord    GitHub Issue
             │                │                │
             └────────────────┼────────────────┘
                              ▼
                       Knowledge graph
                              │
                              ▼
                     Documentation state
                              │
                     ┌────────┴────────┐
                     ▼                 ▼
                   Healthy             Gap
                     │                 │
                     ▼                 ▼
                  Answer        Update/Create
                                       │
                                       ▼
                                   Evaluate
                                       │
                                       ▼
                                  Human review
                                       │
                                       ▼
                                    Publish
```

That's the conceptual model I'd use in your hackathon presentation.

---

## 30. The strongest one-sentence description

I'd describe the final Draftly architecture as:

> **Draftly is a Strands Graph-powered documentation intelligence system that continuously connects code changes, GitHub issues, and developer support conversations to a project's source of truth, detects documentation drift and knowledge gaps, generates or retrieves grounded answers and documentation changes, evaluates them, and closes the loop through human-approved delivery.**

And the most important distinction is:

**GitHub PRs tell Draftly that the software changed.**

**GitHub Issues and Slack/Discord tell Draftly that developers are struggling with the software.**

**Draftly connects those two signals to determine whether the documentation is keeping up.**

That is what turns your original workflows into a genuinely compelling **Professional Agent** rather than just an AI documentation generator.

[1]: https://strandsagents.com/docs/user-guide/concepts/multi-agent/graph/?utm_source=chatgpt.com "Graph Multi-Agent Pattern | Strands Agents"
[2]: https://strandsagents.com/docs/user-guide/concepts/multi-agent/multi-agent-patterns/?utm_source=chatgpt.com "Multi-agent Patterns | Strands Agents"
[3]: https://strandsagents.com/docs/user-guide/concepts/interrupts/?utm_source=chatgpt.com "Interrupts | Strands Agents"
[4]: https://strandsagents.com/docs/user-guide/concepts/agents/hooks/?utm_source=chatgpt.com "Hooks | Strands Agents"
