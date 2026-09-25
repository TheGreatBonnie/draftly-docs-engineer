# Draftly — Nebius Production Runbook (repo-accurate)

This runbook deploys the real code in `draftly-agent-backend/` (and
`draftly-agent-ui/`) to production on Nebius AI Cloud. It is the
executable companion to [`nebius-deployment.md`](./nebius-deployment.md),
which describes the target architecture. Where that document assumed module
paths and a queue model that do not exist in this repository, this runbook
states the actual entrypoints and corrects the plan.

Reference documentation:
- [Nebius Container Registry quickstart](https://docs.nebius.com/container-registry/quickstart)
- [Nebius Managed Kubernetes](https://docs.nebius.com/kubernetes/index)
- [Nebius Observability](https://docs.nebius.com/observability/index)
- [Nebius Serverless AI overview](https://docs.nebius.com/serverless/overview)

Related internal docs:
- [`nebius-deployment.md`](./nebius-deployment.md) — target architecture (this runbook corrects its entrypoints/queue model).
- [`docs/superpowers/specs/2026-09-19-nebius-production-deployment-design.md`](./superpowers/specs/2026-09-19-nebius-production-deployment-design.md) and
  [`docs/superpowers/plans/2026-09-19-nebius-production-deployment.md`](./superpowers/plans/2026-09-19-nebius-production-deployment.md) — a planned evolution that moves
  documentation workflow execution out of the in-cluster worker pool into Nebius **Serverless Jobs** (a dispatcher + reconciler, with PostgreSQL as the source of truth
  and Redis demoted to live delivery). That dispatcher/reconciler is **not yet implemented** as of this runbook; the instructions here deploy the current codebase,
  which executes workflows on the unified RQ worker pool. The Token Factory provider and Tavily research integration called for by that plan already exist in the repo,
  so this runbook already configures `DRAFTLY_ENABLED_PROVIDERS=nebius_token_factory`. Revisit the plan's sections when the dispatcher/reconciler lands.

---

## 0. How this differs from `nebius-deployment.md`

The architecture document describes a role-split worker pool, Redis Streams,
and module paths that do not exist in this codebase. The real repository uses
a **single unified RQ worker** consuming Redis queues, and the API serves SSE
itself. Every section below is grounded in the actual code.

| `nebius-deployment.md` assumed              | This repository actually has                                             | Runbook action                                  |
| ------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| `draftly.api.main:app` (API entrypoint)     | `main.py` → `src.draftly.app.api.app:app` (FastAPI)                      | Use `python main.py` (existing `Dockerfile.api`) |
| `draftly.workers.orchestrator`              | `python -m workers.rq_worker` (unified RQ worker)                        | One worker Deployment, scaled by replicas       |
| `draftly.workers.writer`                    | no such entrypoint — writer tasks are RQ jobs on the unified worker       | Scale the worker Deployment                     |
| `draftly.workers.reviewer`                  | no such entrypoint — review jobs run on the unified worker                | Scale the worker Deployment                     |
| `draftly.evaluations.run`                   | `scripts/run_evaluation.py` (not packaged into any image)                | Add `scripts/` to the worker image; run as a Job |
| Redis **Streams**                           | **RQ** queues + `rq-scheduler` (`scheduled`, `webhooks`, `default`)       | No stream code; scale on RQ queue depth/CPU     |
| Separate SSE service                        | SSE is served by the API (`/api/workflows/.../events`, `/api/workflow-runs/{id}/events`) with Redis-backed replay | Keep SSE inside the API Deployment              |
| Backend Dockerfile from scratch             | Existing multi-stage `docker/Dockerfile.api`, `.worker`, `.agentcore`     | Reuse them; add non-root user and `scripts/`    |
| Frontend Next.js                            | `draftly-agent-ui/` (no Dockerfile yet)                                  | Add a standalone Next.js Dockerfile             |

Key facts verified in the repository:

- API app: `src.draftly.app.api.app:app` (factory `create_api_app()`), run by `main.py`.
- Health endpoints: `/api/health/live` (liveness) and `/api/health/ready`
  (readiness, returns 503 when dependencies are not ready).
- Metrics endpoint: `/api/metrics` (Prometheus format).
- Unified worker: `workers/rq_worker.py` — an RQ `SimpleWorker` consuming the
  `scheduled`, `webhooks` and `default` queues; init-lock aware; reconciles
  stale workflows on boot. It replaces the former workflow, indexing and
  evaluation workers.
- Optional Event worker: `workers/event_worker.py` — runs the same FastAPI app
  under uvicorn (in-process webhook handling). Not needed when the API and RQ
  worker are both deployed.
- Optional AgentCore runtime: `agentcore_server.py` (port `8080`),
  `docker/Dockerfile.agentcore`, deployed via `scripts/deploy_agentcore.py`.
- Migrations: `scripts/bootstrap.py` (applies `src/draftly/persistence/migrations/*.sql`).
- Evaluations: `scripts/run_evaluation.py` (`--live` for real agent invocation).
- SSE is safe across replicas: events are published to a Redis event bus and
  replayed from Redis on reconnect (`GET .../events` uses `list_after`).
- Queue model: environment flags `RQ_ENABLED`, `EVENTS_STREAMING_ENABLED`,
  `REDIS_URL`; workers live in `src/draftly/app/workers/`.

> **Required small repo change:** copy `scripts/` into the worker image
> (used for migrations and evaluations). Section 3 shows the diff.

---

## 1. Rollout order (TL;DR)

1. Containerize (API, worker, optional agentcore) and add the frontend Dockerfile.
2. Push images to Nebius Container Registry.
3. Create Managed Kubernetes with an autoscaling CPU node group.
4. Create namespaces, ConfigMap, and Secret.
5. Run migrations as a one-off Kubernetes Job.
6. Deploy Redis (external managed or in-cluster), then API, worker, and frontend.
7. Verify health + SSE + a real 1-page pull request workflow.
8. Optionally add Serverless AI Endpoint (self-hosted LLM) and Serverless AI Jobs (evaluations).
9. Install the Nebius Observability Agent and wire metrics/logs/traces.
10. Load-test – 1-page, 5-page, 11-page – then tune HPA and autoscaler.

---

## 2. Prerequisites

### 2.1 Nebius AI Cloud

- Sign up and create the account: [create a Nebius AI Cloud account](https://docs.nebius.com/signup-billing/sign-up).
- Install and configure the CLI. Use one profile per project:

  ```bash
  nebius profile create
  nebius config set parent-id <project-id>     # project id (parent container)
  ```

- Choose a region. Example used throughout: `eu-north1`.

  ```bash
  export DRAFTLY_REGION_ID=eu-north1
  export DRAFTLY_PROJECT_ID=<project-id>
  ```

### 2.2 External durable services (unchanged from the architecture doc)

- **NeonDB (Postgres)** — Draftly's durable database and pgvector store.
  Get the connection string; wire it to `DATABASE_URL` / `NEON_DATABASE_URL`.
- **Redis** — required for RQ + event streaming. Nebius does not currently
  offer managed Redis, so choose one:
  - *Recommended for production:* an external managed Redis (e.g. Redis Cloud /
    Upstash) with TLS, to avoid operating a stateful service in-cluster.
  - *Simplest for a demo:* an in-cluster StatefulSet size 1 (Section 7.4).

### 2.3 Application integrations

Gather the values already present in `draftly-agent-backend/.env.example`:

- GitHub App credentials (`GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`,
  `GITHUB_APP_SLUG`, and the **private key** `GITHUB_PRIVATE_KEY_PATH`).
- Slack and/or Discord tokens (if deployed).
- Clerk keys (`CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_SIGNING_SECRET`).
- SendGrid keys (if email delivery is used).
- Model providers (at minimum the Nebius Token Factory key for LLM + Qwen
  embeddings; optionally Requesty/OpenRouter keys).
- `DRAFTLY_ENABLED_PROVIDERS` — e.g. `nebius_token_factory`.

---

## 3. Containerization

Reuse the existing Dockerfiles; apply two changes.

### 3.1 Backend images

Currently: `docker/Dockerfile.api` (runtime `python main.py`, exposes `8000`),
`docker/Dockerfile.worker` (`ENTRYPOINT python -m`, `CMD workers.rq_worker`,
installs `git` for repository checkouts, copies `secrets/`).

Apply to both runtime stages:

1. **Run as a non-root user.** Both images currently run as root. Add:

   ```dockerfile
   RUN useradd --create-home --uid 10001 draftly
   COPY --chown=draftly:draftly . .
   USER draftly
   ```

2. **In `Dockerfile.worker`, copy `scripts/`** so the same image can run
   migrations and evaluations:

   ```dockerfile
   COPY scripts ./scripts
   ```

3. The remaining `draftly-agent-backend/docker/Dockerfile` is a shared builder
   base and is not runnable on its own; build the API and worker images from
   `Dockerfile.api` and `Dockerfile.worker`.

### 3.2 Frontend image (new)

`draftly-agent-ui/` is a Next.js app with no Dockerfile. It consumes `API_URL`
(build-time, used by `next.config.ts` rewrites), `NEXT_PUBLIC_API_URL` (client
side) and the `NEXT_PUBLIC_CLERK_*` keys. Use the standalone output:

```dockerfile
# draftly-agent-ui/Dockerfile
FROM node:22-alpine AS builder

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .

ARG API_URL
ENV API_URL=${API_URL}
RUN pnpm build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
```

Enable `output: "standalone"` in `next.config.ts` if it is not already set.
`NEXT_PUBLIC_*` variables are inlined at build time, so pass them as build args
(`API_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, and the
route overrides). Runtime-only values such as `CLERK_SECRET_KEY` are injected
by the Kubernetes Deployment (Section 7.6).

### 3.3 Container contract

Every service must already meet (or be made to meet):

- Structured JSON logs to stdout — Draftly uses `structlog`
  (`src/draftly/observability/logging.py`).
- Health probes — already present: `/api/health/live`, `/api/health/ready`.
- Prometheus metrics — already present: `/api/metrics`.
- Graceful `SIGTERM` shutdown — the API lifespan and RQ worker handle teardown.
- Configuration via environment — yes (`src/draftly/app/config.py`).
- No important state on the container filesystem — yes (state is in NeonDB/Redis).
- Immutable tags or digests in production (Section 11).
- Non-root user — add as in 3.1.
- Explicit CPU/memory requests and limits — set in the manifests (Section 7).

---

## 4. Push images to Nebius Container Registry

Set up the CLI credential helper (no separate `docker login`):

```bash
nebius registry configure-helper
```

Create the registry and capture its id (the registry path is the id fragment
after the first dash, and the FQDN is `cr.<region>.nebius.cloud`):

```bash
export DRAFTLY_REGISTRY_PATH=$(
  nebius registry create --name draftly --format json |
  jq -r '.metadata.id' |
  cut -d- -f 2
)
# verify the FQDN
nebius registry list --format json | jq -r '.items[] | select(.metadata.name=="draftly") | .status.registry_fqdn'
```

Build and push the backend images (note: `--platform linux/amd64` is required
for Serverless AI and is safe for Kubernetes too; do not run Docker as root):

```bash
docker build --platform linux/amd64 \
  -t cr.$DRAFTLY_REGION_ID.nebius.cloud/$DRAFTLY_REGISTRY_PATH/draftly-api:1.0.0 \
  -f docker/Dockerfile.api .
docker push cr.$DRAFTLY_REGION_ID.nebius.cloud/$DRAFTLY_REGISTRY_PATH/draftly-api:1.0.0

docker build --platform linux/amd64 \
  -t cr.$DRAFTLY_REGION_ID.nebius.cloud/$DRAFTLY_REGISTRY_PATH/draftly-worker:1.0.0 \
  -f docker/Dockerfile.worker .
docker push cr.$DRAFTLY_REGION_ID.nebius.cloud/$DRAFTLY_REGISTRY_PATH/draftly-worker:1.0.0
```

Frontend (build args must match the deployed origin):

```bash
docker build --platform linux/amd64 \
  --build-arg API_URL=https://draftly-api.<your-domain> \
  --build-arg NEXT_PUBLIC_API_URL=https://draftly-api.<your-domain> \
  -t cr.$DRAFTLY_REGION_ID.nebius.cloud/$DRAFTLY_REGISTRY_PATH/draftly-ui:1.0.0 \
  draftly-agent-ui
docker push cr.$DRAFTLY_REGION_ID.nebius.cloud/$DRAFTLY_REGISTRY_PATH/draftly-ui:1.0.0
```

Optionally build `draftly-agentcore` from `docker/Dockerfile.agentcore`.

**Registry pulls from Kubernetes:** when the node group template carries a
Nebius service account, Pods pull same-project registry images without an
`imagePullSecret` — see [Pulling Nebius registry images from Kubernetes](https://docs.nebius.com/kubernetes/workloads/images-container-registry).

---

## 5. Create Managed Kubernetes

### 5.1 Cluster

Create the control plane with the CLI (see `nebius mk8s cluster create --help`,
and [how to create clusters](https://docs.nebius.com/kubernetes/clusters/manage)):

```bash
nebius mk8s cluster create \
  --name draftly \
  --version 1.35 \
  --network-id <network-id> \
  --subnet-id <subnet-id> \
  --format json
```

### 5.2 Autoscaling CPU node group

Create one general CPU node group with cluster autoscaler. It must attach a
service account so Pods can pull registry images. Verified flags:

```bash
nebius mk8s node-group create \
  --name draftly-cpu \
  --version 1.35 \
  --autoscaling-min-node-count 2 \
  --autoscaling-max-node-count 6 \
  --template-resources-platform cpu-d3 \
  --template-resources-preset 4vcpu-16gb \
  --template-service-account-id <service-account-id> \
  --template-network-interfaces '[{"public_ip_address": {}, "subnet_id": "<subnet-id>"}]'
```

Notes:

- Keep at least 2 nodes so CoreDNS and Cilium have non-overlapping placement;
  the cluster autoscaler adds/removes nodes as Pods schedule.
- A second burst node group (e.g. 0–10 larger CPU nodes, tainted for intensive
  workers) is optional and only useful once workload bursts justify it.
- GPU node groups are only needed if models run inside Kubernetes; the
  recommended setup keeps models in Serverless AI Endpoints instead.

### 5.3 Namespaces and kubectl connect

```bash
kubectl create namespace draftly
kubectl create namespace observability
# connect: docs.nebius.com/kubernetes/connect
```

---

## 6. Configuration and secrets

Split `.env` values into a ConfigMap (non-secret) and a Secret. Start from
`draftly-agent-backend/.env.example` and set production values.

Non-secret (ConfigMap `draftly-config`):

```bash
kubectl create configmap draftly-config --namespace draftly \
  --from-literal=ENVIRONMENT=production \
  --from-literal=LOG_LEVEL=INFO \
  --from-literal=RQ_ENABLED=true \
  --from-literal=EVENTS_STREAMING_ENABLED=true \
  --from-literal=VECTOR_SEARCH_BACKEND=pgvector \
  --from-literal=DRAFTLY_ENABLED_PROVIDERS=nebius_token_factory \
  --from-literal=APP_URL=https://draftly-api.<your-domain> \
  --from-literal=FRONTEND_URL=https://draftly.<your-domain> \
  --from-literal=ALLOWED_ORIGINS=https://draftly.<your-domain> \
  --from-literal=REVIEW_DASHBOARD_URL=https://draftly-api.<your-domain> \
  --from-literal=OTEL_SERVICE_NAME=draftly \
  --from-literal=OTEL_EXPORTER_OTLP_PROTOCOL=grpc
```

> The API's CORS allowlist only includes localhost/ngrok by default; set
> `ALLOWED_ORIGINS` to the production frontend origin or browser calls fail.

Secret (Secret `draftly-secrets`):

```bash
kubectl create secret generic draftly-secrets --namespace draftly \
  --from-literal=DATABASE_URL='postgresql://...@neon...' \
  --from-literal=NEON_DATABASE_URL='postgresql://...@neon...' \
  --from-literal=REDIS_URL='rediss://...' \
  --from-literal=NEBIUS_TOKEN_FACTORY_API_KEY='...' \
  --from-literal=SLACK_BOT_TOKEN='...' \
  --from-literal=GITHUB_APP_ID='...' \
  --from-literal=GITHUB_WEBHOOK_SECRET='...' \
  --from-literal=GITHUB_APP_SLUG='...' \
  --from-literal=CLERK_SECRET_KEY='...' \
  --from-literal=CLERK_SIGNING_SECRET='...' \
  --from-literal=GITHUB_PRIVATE_KEY_PATH=secrets/private-key.pem
```

The GitHub private key must reach the worker at `secrets/private-key.pem`
(the worker image copies `secrets/`). Mount it as a Secret volume:

```bash
kubectl create secret generic draftly-github-key --namespace draftly \
  --from-file=private-key.pem=draftly-agent-backend/secrets/private-key.pem
```

Preferred dataclass: manage both Secrets and the ConfigMap declaratively
(git-encrypted or through a sealed-secrets workflow) rather than from the
shell. Never commit the real `.env` or key material.

---

## 7. Deploy the core platform to Kubernetes

All manifests here are representative; version with the repo and pin image
digests in production (Section 11).

### 7.1 API Deployment

The API serves REST routes, webhooks (GitHub/Slack/Discord), metrics, and the
SSE streams. Health endpoints live under `/api`.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: draftly-api
  namespace: draftly
spec:
  replicas: 2
  selector:
    matchLabels:
      app: draftly-api
  template:
    metadata:
      labels:
        app: draftly-api
    spec:
      containers:
        - name: api
          image: cr.eu-north1.nebius.cloud/REGISTRY_ID/draftly-api:1.0.0
          command: ["python", "main.py"]
          envFrom:
            - configMapRef: { name: draftly-config }
            - secretRef:   { name: draftly-secrets }
          ports:
            - name: http
              containerPort: 8000
          readinessProbe:
            httpGet: { path: /api/health/ready, port: http }
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /api/health/live, port: http }
            periodSeconds: 20
          startupProbe:
            httpGet: { path: /api/health/live, port: http }
            failureThreshold: 30
            periodSeconds: 5
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits:   { cpu: "1",  memory: 1Gi }
      terminationGracePeriodSeconds: 60
---
apiVersion: v1
kind: Service
metadata:
  name: draftly-api
  namespace: draftly
spec:
  selector: { app: draftly-api }
  ports:
    - name: http
      port: 80
      targetPort: http
  sessionAffinity: ClientIP     # reduces SSE re-fanout; see note below
  type: LoadBalancer
```

> **SSE and multiple replicas.** Draftly publishes workflow events to a Redis
> event bus and replays them on reconnect, so SSE is correct across replicas
> (no sticky sessions required for correctness). `sessionAffinity: ClientIP`
> is set as an optimization to keep each browser on one replica. The
> LoadBalancer Service provisions a Nebius load balancer.

A Pod Disruption Budget keeps both replicas available during node drains:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: draftly-api
  namespace: draftly
spec:
  minAvailable: 1
  selector:
    matchLabels: { app: draftly-api }
```

### 7.2 Worker Deployment

One Deployment runs the unified RQ worker. Scale it horizontally — each Pod
consumes one RQ job at a time from the shared queues. Keep **two warm
replicas** so a live demo does not wait for both model warm-up and worker
startup.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: draftly-worker
  namespace: draftly
spec:
  replicas: 2
  selector:
    matchLabels:
      app: draftly-worker
  template:
    metadata:
      labels:
        app: draftly-worker
    spec:
      containers:
        - name: worker
          image: cr.eu-north1.nebius.cloud/REGISTRY_ID/draftly-worker:1.0.0
          command: ["python", "-m", "workers.rq_worker"]
          envFrom:
            - configMapRef: { name: draftly-config }
            - secretRef:   { name: draftly-secrets }
          volumeMounts:
            - name: github-key
              mountPath: /app/secrets
              readOnly: true
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits:   { cpu: "2",  memory: 4Gi }
      volumes:
        - name: github-key
          secret:
            secretName: draftly-github-key
```

> **Do not** split the worker into orchestrator/writer/reviewer Deployments as
> the architecture doc sketched — the repo has no such entrypoints. RQ job
> type (webhook, workflow, evaluation, scheduled) is explicit on each job, and
> worker Pods are interchangeable.

### 7.3 Horizontal Pod Autoscaling for workers

CPU utilization is a reasonable starting point:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: draftly-worker
  namespace: draftly
spec:
  minReplicas: 2
  maxReplicas: 20
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: draftly-worker
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 65 }
```

Queue-depth scaling is more accurate for a batch system: expose
`draftly_queue_pending_tasks{queue=...}` from the metrics endpoint (already
listed in the alert set of `nebius-deployment.md`), scrape it with
Prometheus, and target replicas so that

```text
desired workers ≈ ceil(pending RQ jobs / jobs per worker)
```

e.g. 40 pending document tasks with a target of 2 tasks per worker → ~20
workers. The CPU HPA above is the pragmatic first step; move to a custom
metric once the burst profile is understood.

### 7.4 Redis (single-node StatefulSet fallback)

Only if not using external managed Redis. A size-1 StatefulSet is enough for
a demo; use an external service for production durability.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
  namespace: draftly
spec:
  serviceName: redis
  replicas: 1
  selector:
    matchLabels: { app: redis }
  template:
    metadata:
      labels: { app: redis }
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          args: ["--appendonly", "yes"]
          ports: [{ containerPort: 6379 }]
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests: { storage: 10Gi }
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: draftly
spec:
  selector: { app: redis }
  ports:
    - name: redis
      port: 6379
```

Point `REDIS_URL=redis://redis:6379/0` in the Secret when using this option.

### 7.5 Migrations as a one-off Job

Run `scripts/bootstrap.py` (in the worker image after Section 3.1) once per
version, before rolling out the new API/worker. Apply the Job manifest:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: draftly-migrate
  namespace: draftly
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: migrate
          image: cr.eu-north1.nebius.cloud/REGISTRY_ID/draftly-worker:1.0.0
          command: ["python", "scripts/bootstrap.py"]
          envFrom:
            - configMapRef: { name: draftly-config }
            - secretRef:   { name: draftly-secrets }
```

### 7.6 Frontend Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: draftly-ui
  namespace: draftly
spec:
  replicas: 2
  selector:
    matchLabels: { app: draftly-ui }
  template:
    metadata:
      labels: { app: draftly-ui }
    spec:
      containers:
        - name: ui
          image: cr.eu-north1.nebius.cloud/REGISTRY_ID/draftly-ui:1.0.0
          envFrom:
            - secretRef: { name: draftly-ui-secrets }   # CLERK_SECRET_KEY etc.
          ports: [{ containerPort: 3000 }]
          readinessProbe:
            httpGet: { path: /, port: 3000 }
            periodSeconds: 10
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits:   { cpu: "1",  memory: 1Gi }
---
apiVersion: v1
kind: Service
metadata:
  name: draftly-ui
  namespace: draftly
spec:
  selector: { app: draftly-ui }
  ports:
    - name: http
      port: 80
      targetPort: 3000
  type: LoadBalancer
```

Point DNS at the two LoadBalancer addresses (`draftly.<domain>` → UI,
`draftly-api.<domain>` → API) and set `ALLOWED_ORIGINS` accordingly.

### 7.7 Optional AgentCore runtime

If you use the AgentCore runtime:

```bash
docker buildx build --platform linux/amd64 \
  -f docker/Dockerfile.agentcore \
  -t cr.$DRAFTLY_REGION_ID.nebius.cloud/$DRAFTLY_REGISTRY_PATH/draftly-agentcore:1.0.0 \
  --output=type=docker .
docker push cr.$DRAFTLY_REGION_ID.nebius.cloud/$DRAFTLY_REGISTRY_PATH/draftly-agentcore:1.0.0
```

Deploy as a `Deployment` serving `agentcore_server.py` on port `8080`, or use
`scripts/deploy_agentcore.py` as the orchestration entrypoint.

---

## 8. Optional: models as Serverless AI Endpoints

Draftly already calls hosted LLMs (Nebius Token Factory, Requesty, etc.) over
HTTPS, so self-hosted inference is optional. If you want control of the
writer/reviewer model, run vLLM behind a Nebius Serverless AI Endpoint
(managed HTTPS, token auth, private-registry image, no public IP needed):

```bash
nebius ai endpoint create \
  --name draftly-writer-model \
  --image <vllm-or-custom-image> \
  --container-command "python3 -m vllm.entrypoints.openai.api_server" \
  --container-port 8000 \
  --auth token \
  --token-secret draftly-model-auth \
  --subnet-id <subnet-id> \
  --platform <gpu-platform> \
  --preset <gpu-preset> \
  --disk-size 250Gi
```

Endpoint creation takes ~5 minutes; stopped endpoints stop billing, but
restarting brings a cold-start delay. Keep the writer endpoint warm during a
hackathon demo and run a warm-up inference before marking the provider ready.

Mesh the endpoint URL + token into Draftly via the provider config (e.g. set
`NVIDIA_BASE_URL`/`OPENROUTER_BASE_URL` pattern, or a Nebius endpoint URL +
`*_API_KEY`), then add it to `DRAFTLY_ENABLED_PROVIDERS`.

---

## 9. Batch work as Serverless AI Jobs

Evaluations and index rebuilds are finite, resource-intensive batches — the
right shape for `nebius ai job`. The evaluation entrypoint is
`scripts/run_evaluation.py` (`--live` for real agent runs). Use an image that
has `scripts/` (the worker image after Section 3.1):

```bash
nebius ai job create \
  --name draftly-documentation-eval \
  --image cr.eu-north1.nebius.cloud/REGISTRY_ID/draftly-worker:1.0.0 \
  --container-command python \
  --args "scripts/run_evaluation.py --live --dataset documentation" \
  --env DRAFTLY_ENV=production \
  --env-secret NEON_DATABASE_URL=draftly-production \
  --env-secret MODEL_API_KEY=draftly-production \
  --volume "storagebucket-e***:/artifacts:rw" \
  --subnet-id <subnet-id> \
  --platform <platform> \
  --preset <preset> \
  --timeout 2h
```

Write results to NeonDB or Object Storage before the job exits — the job's
local disk is removed on completion.

Alternative (no extra service): the unified RQ worker already consumes the
`scheduled` queue via `rq-scheduler`, so nightly evals / indexing can equally
be scheduled RQ jobs and run on the autoscaled worker pool. Use Serverless AI
Jobs when the batch is heavy enough to deserve dedicated, tear-down-after-run
compute.

---

## 10. Observability

### 10.1 Nebius Observability Agent (logs, metrics, traces)

Install the agent in the `observability` namespace:

```bash
helm install nebius-observability-agent \
  oci://cr.nebius.cloud/observability/public/nebius-observability-agent-helm \
  --version $(curl \
    https://nebius-observability-agent.storage.eu-north1.nebius.cloud/nebius-observability-agent-helm/latest-release) \
  --namespace observability \
  --create-namespace
```

It collects structured JSON logs (Draftly already writes these with
`structlog`). With tracing enabled it exposes an in-cluster OTLP endpoint at:

```text
nebius-observability-agent.observability.svc.cluster.local:4317
```

### 10.2 Traces

Draftly's `src/draftly/observability/tracing.py` records span durations into
the shared metrics registry but does **not** export OTLP today — there are no
`opentelemetry-*` dependencies in `pyproject.toml`. To get Nebius Tracing:

- add `opentelemetry-api/sdk`, `opentelemetry-exporter-otlp` and the FastAPI /
  httpx instrumentation packages to `pyproject.toml`, and
- set the OTLP env vars in the ConfigMap:

```yaml
env:
  - name: OTEL_SERVICE_NAME
    value: draftly-worker
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: http://nebius-observability-agent.observability.svc.cluster.local:4317
  - name: OTEL_EXPORTER_OTLP_PROTOCOL
    value: grpc
  - name: OTEL_RESOURCE_ATTRIBUTES
    value: deployment.environment=production,service.version=1.0.0
```

Until then, traces are the one gap; logs + metrics work immediately.

### 10.3 Metrics

Route `/api/metrics` into Nebius Observability Metrics via Prometheus
remote-write (kube-prometheus-stack in agent mode):

```bash
kubectl create secret generic nebius-o11y-token \
  --from-literal token=<token> --namespace observability
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
```

```yaml
# values.yaml
grafana:
  enabled: false
alertmanager:
  enabled: false
prometheus:
  agentMode: true
  prometheusSpec:
    remoteWrite:
      - name: Nebius
        url: https://write.monitoring.eu-north1.nebius.cloud/projects/<project-id>/prometheus/api/v1/write
        authorization:
          credentials:
            name: nebius-o11y-token
            key: token
```

```bash
helm install prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace observability \
  --values values.yaml
```

Add a `ServiceMonitor` (or scrape config) for `draftly-api` on `/api/metrics`.
For Grafana dashboards, use the alert/`draftly_*` metric names from the
architecture doc's Section 9, and keep label cardinality low (no workflow IDs
or prompt text — those belong in logs/traces).

### 10.4 Alerts

For application-level conditions, ship `alerting-rules.yaml` to
kube-prometheus-stack (or Alertmanager directly) using the thresholds from
`nebius-deployment.md` Section 11 (writer backlog > 20 files for 5m, stuck
workflow 10m, model P95 > 60s, review rejection > 20%/1h, etc.).

---

## 11. CI/CD and rollout hygiene

Pipeline:

```text
push → tests (+ eval suite) → build → image scan → push to Nebius Registry →
staging rollout → smoke/agent tests → canary production → monitor + rollback
```

- Version application code, Strands agent definitions, prompts, skills, tool
  schemas, model-routing policy, evaluation datasets, and DB migrations
  together.
- Use image **digests** in production manifests:

  ```yaml
  image: cr.eu-north1.nebius.cloud/REGISTRY_ID/draftly-api@sha256:...
  ```

- Zero-downtime upgrades: rolling Deployments; readiness gating; PDB for API
  and UI; drain-safe. RQ workers already finish their current job before exit,
  and workflow operations are idempotent + checkpointed in NeonDB, so worker
  Pods can be recycled freely.
- Run `draftly-migrate` (Section 7.5) before each rollout, backwards compatible.

---

## 12. Verification checklist

1. `kubectl get all -n draftly` — API/worker/UI `Ready`.
2. `curl https://draftly-api.<domain>/api/health/live` → 200.
3. `curl https://draftly-api.<domain>/api/health/ready` → 200 (DB + Redis reachable).
4. `curl https://draftly-api.<domain>/api/metrics` → Prometheus output.
5. Open `https://draftly.<domain>` → Clerk sign-in works.
6. Turn on a repository; open a 1-page PR; confirm GitHub webhook → RQ job →
   writer → review → PR delivery, and watch the SSE progress in the UI.
7. `kubectl logs -n draftly deployment/draftly-worker -f` — structured JSON logs.
8. Trigger a 5-page and an 11-page PR; watch the worker HPA scale and the node
   autoscaler grow `draftly-cpu`.
9. Run a Serverless AI Job evaluation and confirm results land in NeonDB.

---

## 13. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Webhooks not processed | API cannot reach Redis / RQ disabled | Check `REDIS_URL`, `RQ_ENABLED=true`, `EVENTS_STREAMING_ENABLED=true` |
| Workers crash-loop on GitHub checkout | `secrets/private-key.pem` missing | Verify `draftly-github-key` Secret and mount path |
| Browser calls blocked | CORS allowlist empty | Set `ALLOWED_ORIGINS` to the UI origin |
| `Ready` probe 503 | NeonDB or Redis unreachable | Verify the Secret URLs are reachable from the cluster |
| Registry pull `forbidden` | Node group has no service account token | Add `--template-service-account-id` to the node group |
| No traces | OTel SDK not installed | Section 10.2 — add the `opentelemetry-*` deps |
| SSE stalls after redeploy | Browser pinned to a terminated replica | Rely on Redis replay via `/events`; check event bus config |

---

## 14. Final notes

The single most important decision (from the architecture doc, confirmed by
the code) is to keep Draftly's orchestration + worker pool on Managed
Kubernetes rather than as one Serverless AI Endpoint. Kubernetes gives the
API, the exchangeable RQ worker pool (scaled by queue depth), warm capacity,
Redis-driven execution, SSE, and node autoscaling. Serverless AI then
complements it with managed inference (Endpoints) and heavy batch evaluation
(Jobs); NeonDB stays the durable store; Nebius Container Registry and
Observability complete the picture.