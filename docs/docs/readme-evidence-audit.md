# README evidence audit

Audit date: 2026-09-05. Scope: the persuasive README rewrite, inspected against the current backend checkout and its sibling frontend. This is a source and documentation audit, not a live demonstration or benchmark report.

## Claim and artifact inventory

| Claim or artifact | Source | Evidence class | README treatment |
| --- | --- | --- | --- |
| Strands research agents use source-specific tools | [Research agents](../src/draftly/agents/shared/research.py) | implementation | Link concrete agent factories |
| Documentation graph coordinates research, impact, writing, revision, changelog, delivery | [Graph](../src/draftly/orchestration/graphs/documentation_graph.py) | implementation | Explain GraphBuilder and actual branches |
| Writers cannot directly deliver a documentation PR | `_WRITER_EXCLUDED_TOOLS` in the graph | implementation | Describe tool restrictions, not a universal security guarantee |
| Merged PRs trigger documentation processing | [GitHub route](../src/draftly/app/api/routes/github.py) | implementation | State non-merged PR events are skipped |
| Review can pause delivery or cancel it | [ReviewGate](../src/draftly/orchestration/hooks/review_gate.py), [policies](../src/draftly/orchestration/routing/policies.py) | implementation | Explain always/risky/never; do not promise automatic rework after rejection |
| Graph-level review owns documentation delivery approval | Graph constructs delivery with `hitl=False`; [delivery agent](../src/draftly/agents/shared/delivery.py) receives mutation tools | implementation | Show policy bypass and rejection in the diagram |
| Memory can be curated into persistent knowledge | [Curation workflow](../src/draftly/workflows/memory/curation_workflow.py), [candidate extraction](../src/draftly/workflows/post_run/candidate_extractor.py) | implementation | Say what happens when workflows run; do not claim observed improvement |
| Routing can consider historical task performance | [Router](../src/draftly/models/router.py), [lifecycle warm start](../src/draftly/app/lifecycle.py) | implementation | Bound claim to stored statistics; omit performance benefits without measurements |
| Prompts and packaged skills automatically rewrite themselves | No evidence established by this audit | unverified | Exclude; describe edits as developer work |
| OAuth documentation scenario | [Dataset](../src/draftly/evaluation/datasets/documentation.json) | illustration | Explicit illustrative label and expected coverage table |
| Groundedness and other evaluation dimensions | [Evaluation implementation](../src/draftly/evaluation/), [runtime evaluator](../src/draftly/orchestration/nodes/evaluate.py) | implementation | Separate LLM judgments from deterministic/heuristic checks |
| Measured pass rates, latency, cost, or time saved | No qualifying run artifact found in searched README, docs, reports, or runtime filenames | unverified | Publish no numerical result or efficiency claim |
| Recorded demo and delivered PR | No verified link found in searched README, docs, and Authly scenario Markdown | unverified | State absence; do not invent links |
| UI image assets | Sibling `onboarding-flow-designs/` contains design images; frontend public assets contain a logo | illustration | Do not present design assets as execution screenshots |
| Complete frontend experience | [Frontend README](../../draftly-agent-frontend/README.md), frontend routes and typed API client | implementation | Link setup and describe review workspace; do not claim live validation |
| Open-source license | [LICENSE](../LICENSE) has zero bytes | unverified | Identify unresolved licensing explicitly; owner must select license |
| Hackathon judging and submission expectations | [Official hackathon page](https://agentsforhumans.devpost.com/), opened during this audit | observed run | Cite event page; identify Professional Agents as intended track only |

Searches included tracked files and an additional filesystem walk excluding `.git`, `.venv`, `node_modules`, and Python caches. Internal `.superpowers/sdd/` implementation reports and graph reports were found; they were not treated as live agent benchmark results. The audit does not establish that no evidence exists outside the searched workspace.

## Setup checklist and findings

| Area | Inspected source | Finding and README decision |
| --- | --- | --- |
| Python environment | [Manifest](../pyproject.toml), [main](../main.py) | Python 3.11+, uv; use `uv run` for native processes |
| Database | [Bootstrap](../scripts/bootstrap.py), [migrations](../src/draftly/persistence/migrations/) | Apply migrations to development DB; vector extension and 1,536-dimensional embeddings; bootstrap skips some duplicate errors and has no version ledger |
| Redis | [Compose](../docker-compose.redis.yml), [Settings](../src/draftly/app/config.py) | Plain Redis 7 lacks RediSearch; choose pgvector and disable semantic cache |
| Model access | [Model factory](../src/draftly/models/factory.py) | Bedrock requires AWS configuration; alternative providers are supported |
| Embedding access | `build_embedding_router` in model factory, [Bedrock provider](../src/draftly/models/providers/bedrock.py) | Separate registered OpenRouter, Requesty, or Orcarouter embedding provider required; no native Bedrock embedding implementation |
| Worker topology | [RQ worker](../workers/rq_worker.py), [lifecycle](../src/draftly/app/lifecycle.py), [Settings](../src/draftly/app/config.py) | `rq_enabled` defaults true; document separate native worker rather than implying API consumes queues |
| Authentication | [API auth](../src/draftly/app/api/auth.py), [Settings](../src/draftly/app/config.py) | Clerk configuration additional to API liveness; same application as frontend |
| GitHub connection | [GitHub route](../src/draftly/app/api/routes/github.py), Settings | App configuration, installed repository, webhook reachability, and private-key path required |
| Frontend | [Frontend setup](../../draftly-agent-frontend/README.md) | Sibling app, Clerk keys, backend URL, onboarding |
| API liveness | [Health route](../src/draftly/app/api/routes/health.py), [API composition](../src/draftly/app/api/app.py) | `/api/health` returns status ok and service draftly; does not test models or delivery |
| Integrated outcome | Dataset and route implementation | Merged PR → run → required review → approved delivery is expected, not demonstrated here |
| Evaluation CLI | [Script](../scripts/run_evaluation.py) | `--live` and `--datasets` supported; inspect result status/errors because main returns zero after printing batch output |
| Evaluation portability | [Dataset directory](../src/draftly/evaluation/datasets/) | Machine-specific repository paths and organization/project identifiers require adaptation |
| API container | [Dockerfile.api](../docker/Dockerfile.api) | Runtime omits main.py; build also omits explicit README copy; document intended commands with packaging limitation |
| Worker container | [Dockerfile.worker](../docker/Dockerfile.worker) | Copies secrets into image; preserve operational details and explicitly identify sensitive image handling |

## Editorial decisions

- Keep the backend README as entry point and link the frontend; do not create a root README.
- Use one product walkthrough and one architecture diagram, including no-docs release routing and review bypass.
- Describe runtime evaluators separately from dataset-based Strands Evals; do not equate scores with factual guarantees.
- Use existing source and scenario links in place of unavailable recorded demonstrations.
- Keep provider and worker alternatives in engineering guides; preserve container instructions with their observed limitations.
- Keep licensing choice with the owner. The rewrite neither selects a license nor edits the empty file.
- Existing architecture/deployment guides contain broader historical assertions; links provide further context, not blanket verification of every statement in those guides.

## Verification record

- `git -C draftly-agent-backend diff --check`: passed for the documentation diff.
- Local-link/anchor verification: 95 links checked across the four documentation files; all targets and anchors resolved. Eleven README sections appear in the planned order; exactly one Mermaid block and balanced fences confirmed.
- SHA-256 comparison: all 628 Python files captured before editing remained unchanged. Git status shows only the README, the two deployment guides, and this audit as backend changes.
- `pandoc -f gfm -t html5 --standalone`: generated a local GitHub-flavored Markdown preview successfully.
- Browser preview: inspected the opening and architecture screenshots at 1280px viewport width; tables and navigation remained within the page. Mermaid 11.17.2 rendered 18 nodes, with no page overflow. Preview styling approximates GitHub; this was not a hosted GitHub rendering check.
- The first evaluation `--help` attempt encountered an inherited `DEBUG=release`, which Pydantic rejects as a boolean. Re-running from the backend with `DEBUG=false .venv/bin/python scripts/run_evaluation.py --help` passed and confirmed `--datasets` and `--live`. The README now explains the exported environment override.
- The official hackathon page was opened and its stated track and submission requirements checked. No public demo or artifact URL was available to verify.
- Commands for bootstrap, native startup, Compose, and containers were inspected against source and manifests. No migrations, service launches, image builds, live model calls, publication, or application test suite were run. Health JSON is verified from route code, not a running service.

## Plan completion and remaining evidence

All five documentation tasks are implemented. The README is shorter than the advisory 180–250 nonblank-line target because unsupported demonstration assets and numeric results were omitted. The scope remains documentation only; the application and dataset behavior were not changed, and no graph update is needed for code changes.

A recorded demo, a generated output PR, measured runs with provenance, successful fresh setup, and a selected license remain project evidence/submission work outside this rewrite. The empty license and API image packaging defects are documented rather than silently fixed. The plan's rendering check required correcting the temporary Pandoc-to-Mermaid preview adapter; the source diagram itself parsed successfully.
