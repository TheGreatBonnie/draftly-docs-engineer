# Draftly Reference Documents

Deep design documents for major subsystems. Read these when you need to understand *why* something works the way it does.

| Document | Lines | Covers |
|----------|-------|--------|
| [DESIGN.md](DESIGN.md) | 1,733 | Onboarding UI design specification |
| [implementation-plan.md](implementation-plan.md) | 2,110 | Full implementation plan for onboarding |
| [draftly-project-structure.md](draftly-project-structure.md) | 1,850 | Detailed project structure |
| [adaptive-router.md](adaptive-router.md) | 2,035 | Model routing and selection design |
| [draftly-workflows-architecture.md](draftly-workflows-architecture.md) | 1,646 | Workflow architecture and execution |
| [github-pr-flow.md](github-pr-flow.md) | 1,662 | PR documentation flow deep-dive |
| [agentic-memory-design.md](agentic-memory-design.md) | 1,130 | Memory architecture (episodic, procedural, docs) |
| [onboarding-flow.md](onboarding-flow.md) | 1,133 | Onboarding flow design |
| [redis-streams-sse.md](redis-streams-sse.md) | 1,147 | Redis Streams + SSE real-time streaming |
| [docs-sync.md](docs-sync.md) | 1,088 | Documentation sync design |
| [strands-build-guide.md](strands-build-guide.md) | 663 | Strands SDK build guide |
| [project-structure.md](project-structure.md) | 654 | Alternative project structure overview |

**Reading order for new contributors:**
1. `project-structure.md` — orientation
2. `draftly-workflows-architecture.md` — how work flows through the system
3. `agentic-memory-design.md` — how Draftly remembers things
4. `adaptive-router.md` — how models are selected
5. Pick topic-specific docs as needed
