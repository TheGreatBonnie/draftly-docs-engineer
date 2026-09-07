# Slack and Discord Workflow Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Slack and Discord support workflows organization-scoped, durable, reviewable, observable, and capable of routing documentation gaps to GitHub delivery.

**Architecture:** Normalize provider events into a shared support-event contract carrying both the Clerk organization ID and the platform delivery target. Dispatch support work through the existing task-runner/RQ boundary, install a shared review-resume service for dashboard and platform actions, notify org reviewers of pending reviews through independently idempotent Slack, Discord, and email delivery legs, and persist platform-specific delivery receipts and workflow status. Resolve reviewer notification integrations from organization identity, not from a source message's single-platform runtime context. Keep platform credentials in integration storage/runtime context rather than in prompts or persisted event payloads.

**Tech Stack:** Python 3.11, FastAPI, Slack Bolt, Discord Gateway/Interactions, Strands GraphBuilder, RQ, Redis, CockroachDB/PostgreSQL-compatible SQL, pytest, Ruff.

**Spec:** Approved audit scope from the 2026-09-06 Slack/Discord wiring review; no separate design document was requested.

## Global Constraints

- Preserve the existing GitHub workflow and installation-token behavior.
- Never put Slack bot tokens, Discord bot tokens, or installation secrets in normalized events, prompts, Redis streams, reviews, or database payloads.
- Every support event and persisted workflow row must use the Clerk organization ID as its tenant key.
- Replies must remain in the originating Slack thread or Discord thread/channel.
- Platform webhook signatures remain mandatory at ingress.
- Delivery must be idempotent by source event/run and must not double-post after retries.
- Review approval must resume the graph only after the pending review and source event are validated for the same organization.
- Reviewer notification delivery must be claimed and recorded independently per review, platform, and recipient; one channel's success or failure must not suppress another channel.
- Email notification must work for GitHub-originated reviews and must not require Slack or Discord runtime context.
- Every task below ends with focused tests before moving to the next task.

---

### Task 1: Define the organization-scoped support event and delivery-target contract

**Files:**
- Create: `draftly-agent-backend/src/draftly/support/identity.py`
- Modify: `draftly-agent-backend/src/draftly/events/base.py`
- Modify: `draftly-agent-backend/src/draftly/events/support/slack.py`
- Modify: `draftly-agent-backend/src/draftly/events/support/discord.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/slack/app.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/discord/app.py`
- Test: `draftly-agent-backend/tests/events/test_support_identity.py`
- Test: `draftly-agent-backend/tests/workflows/test_phase5_runner_events.py`

**Interfaces:**
- Add `SupportDeliveryTarget` with fields `platform`, `org_id`, `channel_id`, `thread_id`, `source_message_id`, and `platform_account_id`.
- Define `SupportIdentityError` in the same module for missing or unlinked platform identities.
- Add `async resolve_support_target(event, db) -> SupportDeliveryTarget` in `support/identity.py`.
- Slack resolution must call `get_org_by_slack_team(team_id=...)`; Discord resolution must call `get_org_by_discord_guild(guild_id=...)`.
- Normalized events must retain `team_id` or `guild_id` for credential lookup while setting `project_id` to the resolved Clerk organization ID.

- [x] **Step 1: Write the failing tests**

```python
class FakeDb:
    def __init__(self, org):
        self.org = org

    async def fetch_one(self, *_args):
        return self.org

@pytest.mark.asyncio
async def test_slack_event_resolves_clerk_org_and_preserves_team_id():
    event = await enrich_support_event(
        {"source": "slack", "team_id": "T1", "channel": "C1", "thread_ts": "1"},
        db=FakeDb(org={"clerk_org_id": "org-1"}),
    )
    assert event["project_id"] == "org-1"
    assert event["team_id"] == "T1"

@pytest.mark.asyncio
async def test_unknown_discord_guild_is_rejected():
    with pytest.raises(SupportIdentityError, match="not linked"):
        await enrich_support_event(
            {"source": "discord", "guild_id": "G1"},
            db=FakeDb(org=None),
        )
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/events/test_support_identity.py`

Expected: FAIL because the enrichment contract and platform organization lookups are not implemented.

- [x] **Step 3: Implement the identity resolver**

Use the existing organization repository functions. Do not change processors into database-aware components; enrich the normalized event in the integration boundary after normalization.

```python
async def enrich_support_event(event: dict[str, Any], db: DatabaseClient) -> dict[str, Any]:
    platform = str(event.get("source") or "")
    if platform == "slack":
        organization = await get_org_by_slack_team(team_id=str(event["team_id"]), db=db)
    elif platform == "discord":
        organization = await get_org_by_discord_guild(guild_id=str(event["guild_id"]), db=db)
    else:
        raise SupportIdentityError(f"Unsupported support platform: {platform}")
    if not organization:
        raise SupportIdentityError(f"{platform} installation is not linked")
    enriched = dict(event)
    enriched["project_id"] = str(organization["clerk_org_id"])
    enriched["org_id"] = str(organization["clerk_org_id"])
    return enriched
```

- [x] **Step 4: Call enrichment before scheduling the runner**

In Slack and Discord ingress handlers, normalize first, enrich second, then dispatch. Return/log an explicit platform-not-linked failure instead of launching a workflow with a team/guild ID as its tenant.

- [x] **Step 5: Run focused tests**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/events/test_support_identity.py tests/workflows/test_phase5_runner_events.py`

Expected: PASS.

- [ ] **Step 6: Commit** — SKIPPED (working directory is not a git repo; no commits can be made)

```bash
git add src/draftly/support/identity.py src/draftly/events/base.py src/draftly/events/support src/draftly/integrations/slack/app.py src/draftly/integrations/discord/app.py tests/events/test_support_identity.py tests/workflows/test_phase5_runner_events.py
git commit -m "fix: scope support events to organizations"
```

### Task 2: Make outbound Slack and Discord credentials installation-aware

**Files:**
- Create: `draftly-agent-backend/src/draftly/integrations/support/runtime.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/slack/installation_store.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/slack/client.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/discord/client.py`
- Modify: `draftly-agent-backend/src/draftly/tools/slack/post_message.py`
- Modify: `draftly-agent-backend/src/draftly/tools/discord/post_message.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py`
- Test: `draftly-agent-backend/tests/unit/integrations/test_support_clients.py`

**Interfaces:**
- Add `SupportRuntimeContext` containing `org_id`, `platform`, `platform_account_id`, `channel_id`, and `thread_id`; expose `set_support_runtime`, `reset_support_runtime`, and `current_support_runtime`.
- Add `SlackInstallationStore.async_get_by_team(team_id) -> Installation | None` without changing the existing Slack Bolt lookup contract.
- Add `SlackInstallationStore.async_get_by_org(org_id) -> Installation | None` for organization-scoped background delivery; background jobs must not guess a team from a global token.
- Slack delivery must resolve the bot token using the current event’s `team_id`; `SLACK_BOT_TOKEN` remains only an explicit single-tenant fallback.
- Discord delivery must validate the current `guild_id`/organization target while using the configured bot token; it must not send to a target outside the resolved organization’s configured guild/channels.

- [x] **Step 1: Write the failing tests**

```python
from types import SimpleNamespace

class FakeInstallations:
    def __init__(self, tokens):
        self.tokens = tokens

    async def async_get_by_team(self, team_id):
        installation = self.tokens.get(team_id)
        return SimpleNamespace(bot_token=installation) if installation else None

@pytest.mark.asyncio
async def test_slack_delivery_uses_event_team_installation_token():
    client = SlackClient(installation_store=FakeInstallations({"T1": "xoxb-team"}))
    await client.send_message("C1", "answer", thread_id="1", team_id="T1")
    assert client.last_token == "xoxb-team"

@pytest.mark.asyncio
async def test_discord_delivery_rejects_unlinked_guild():
    client = DiscordClient(allowed_guilds={"G1"})
    with pytest.raises(PermissionError):
        await client.send_message("C1", "answer", guild_id="G2")
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/unit/integrations/test_support_clients.py`

Expected: FAIL because the clients do not accept platform identity or installation-specific credentials.

- [x] **Step 3: Implement runtime context and client lookup**

Set the support context around both initial graph invocation and review resume. Do not serialize the context into the prompt; tools read it only at call time.

- [x] **Step 4: Update tools to use the runtime target**

`slack_post_message` and `discord_post_message` must obtain the current target from runtime context and pass it to the client. If no context exists, raise a clear configuration error rather than silently choosing another tenant.

- [x] **Step 5: Run focused tests**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/unit/integrations/test_support_clients.py tests/graph/test_surface_graphs.py`

Expected: PASS.

- [ ] **Step 6: Commit** — SKIPPED (not a git repo)

```bash
git add src/draftly/integrations/support/runtime.py src/draftly/integrations/slack/installation_store.py src/draftly/integrations/slack/client.py src/draftly/integrations/discord/client.py src/draftly/tools/slack/post_message.py src/draftly/tools/discord/post_message.py src/draftly/workflows/runner.py tests/unit/integrations/test_support_clients.py
git commit -m "fix: use organization-scoped support credentials"
```

### Task 3: Dispatch Slack and Discord support work through the durable worker path

**Files:**
- Modify: `draftly-agent-backend/src/draftly/integrations/slack/app.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/discord/app.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/workers.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/rq_jobs.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/workflows.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/slack.py`
- Modify: `draftly-agent-backend/src/draftly/app/lifecycle.py`
- Test: `draftly-agent-backend/tests/test_workers/test_rq_jobs.py`
- Test: `draftly-agent-backend/tests/test_workers/test_rq_dispatch.py`
- Test: `draftly-agent-backend/tests/integrations/test_support_dispatch.py`

**Interfaces:**
- Register `slack_support.enqueue -> slack_support` and `discord_support.enqueue -> discord_support` in `TASK_REGISTRY`.
- Add queue routing for both tasks to the `webhooks` queue.
- Add `enqueue_support_event(event)` that uses RQ when enabled and the existing worker fallback when disabled.
- Define `enqueue_support_event(event)` in `draftly/app/composition/rq_jobs.py` so adapters and route handlers share one dispatch boundary.
- Preserve Slack’s fast webhook acknowledgement and Discord Gateway responsiveness; enqueue before returning control to the provider.

- [x] **Step 1: Write failing registration and dispatch tests**

```python
def test_support_tasks_are_registered():
    assert TASK_REGISTRY["slack_support.enqueue"] == "slack_support"
    assert TASK_REGISTRY["discord_support.enqueue"] == "discord_support"

def test_support_tasks_use_webhooks_queue():
    assert get_queue_for_task("slack_support.enqueue") == "webhooks"
    assert get_queue_for_task("discord_support.enqueue") == "webhooks"
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/test_workers/test_rq_jobs.py tests/test_workers/test_rq_dispatch.py tests/integrations/test_support_dispatch.py`

Verified: FAIL before implementation — `ImportError: cannot import name 'enqueue_support_event' from 'draftly.app.composition.rq_jobs'`.

- [x] **Step 3: Implement task registration and shared enqueue helper**

Keep workflow functions `run_slack_support` and `run_discord_support` as the task handlers so both RQ and the fallback path share identical execution behavior.

- [x] **Step 4: Replace direct `asyncio.create_task(runner.run(...))` calls**

Both platform adapters must call the shared enqueue helper with the enriched event. The fallback may schedule `worker.run_task`, but it must not bypass task registration.

- [x] **Step 5: Run focused dispatch tests**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/test_workers/test_rq_jobs.py tests/test_workers/test_rq_dispatch.py tests/integrations/test_support_dispatch.py`

Verified: PASS — plus `tests/events/`, `tests/unit/integrations/`, `tests/integrations/`, `tests/workflows/test_phase5_runner_events.py`, `tests/graph/test_surface_graphs.py` → 191 passed. ruff clean.

- [ ] **Step 6: Commit** — SKIPPED (not a git repo)

SKIPPED (not a git repo).

```bash
git add src/draftly/integrations/slack/app.py src/draftly/integrations/discord/app.py src/draftly/app/composition/workers.py src/draftly/app/composition/rq_jobs.py src/draftly/app/composition/workflows.py src/draftly/app/api/routes/slack.py src/draftly/app/lifecycle.py tests/test_workers/test_rq_jobs.py tests/test_workers/test_rq_dispatch.py tests/integrations/test_support_dispatch.py
git commit -m "fix: dispatch support workflows through worker queues"
```

### Task 4: Notify reviewers of pending reviews via Slack and Discord

**Files:**
- Create: `draftly-agent-backend/src/draftly/review/notifier.py`
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/046_review_notification_deliveries.sql`
- Create: `draftly-agent-backend/src/draftly/persistence/repositories/review_notifications.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/context.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/workflows.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/slack/client.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/discord/client.py`
- Test: `draftly-agent-backend/tests/review/test_review_notifier.py`
- Test: `draftly-agent-backend/tests/persistence/test_review_notification_delivery.py`

**Interfaces:**
- Add a `notifier: Any = None` field to `WorkflowContext` (alongside the existing `publisher`/`broadcaster`) and populate it from `app/composition/workflows.py`, consistent with how the streaming publisher and dashboard broadcaster are already injected.
- Add `ReviewNotifier` with `async notify_reviewers(run_id) -> dict[str, list[str]]` mapping platform → reviewer IDs notified. It must load the pending review for that run via `ReviewsRepository.get_pending_by_run_id(run_id)` (the runner holds `run_id`, not the review UUID), fetch active reviewers via `ReviewersRepository.get_active_reviewers(org_id)`, resolve each platform's organization-scoped installation/guild independently of the source runtime context, and DM only reviewers whose `notify_slack` / `notify_discord` flag is set and who have a matching `slack_user_id` / `discord_user_id`.
- Add `ReviewNotificationRepository.claim(review_id, org_id, platform, recipient_id) -> bool` backed by a unique `(review_id, platform, recipient_id)` key, plus `mark_sent(...)` and `mark_failed(...)`. Claim must be atomic so concurrent runner retries cannot double-send.
- Slack sends use an organization-aware `SlackClient.send_dm(user_id, ..., org_id=...)` that resolves the linked installation before calling the existing Slack API method. Add an organization/guild-aware `DiscordClient.send_dm(user_id, content, org_id=..., guild_id=...)` private-channel method and use it for Discord notifications.
- Slack delivery must resolve the org's installation token by `org_id`/team installation; Discord delivery must resolve the organization's linked guild, verify the reviewer is a member of that guild, then open/send the DM. Notification DMs must remain within the resolved organization.
- The notification body must include the run summary and a link/pointer to the pending review, and must never embed credentials or installation secrets.
- After a successful send, mark only that `(review_id, platform, recipient_id)` notification receipt as sent. Do not use the existing global `reviews.notification_sent_at` field as the idempotency guard; retain it only for backward-compatible aggregate display if needed.
- Notification failure must never fail the workflow — it is best-effort and logged per reviewer.
- If the source event has no support runtime (for example, a GitHub-surface review), Slack/Discord legs resolve integrations from the review's `org_id`; email remains eligible. If the organization has no linked platform integration, that platform is recorded as skipped and never falls back to another tenant.

- [x] **Step 1: Write failing tests**

The test module defines reusable `FakeReviews`, `FakeReviewers`, `FakeSlack`, `FakeDiscord`, and `FakeNotificationRepository` fixtures with record/claim behavior matching the production interfaces; no snippet depends on undeclared globals.

```python
@pytest.mark.asyncio
async def test_notifies_only_reviewers_with_matching_pref():
    reviews = FakeReviews(pending={"run-1": {"org_id": "org-1", "id": "review-1"}})
    reviewers = FakeReviewers(org="org-1", rows=[
        {"name": "A", "notify_slack": True, "slack_user_id": "U1"},
        {"name": "B", "notify_slack": False, "slack_user_id": "U2"},
        {"name": "C", "notify_discord": True, "discord_user_id": "D1"},
    ])
    notifications = FakeNotificationRepository()
    notifier = ReviewNotifier(
        reviews=reviews, reviewers=reviewers, slack=fake_slack, discord=fake_discord,
        notifications=notifications,
    )
    sent = await notifier.notify_reviewers("run-1")
    assert sent == {"slack": ["U1"], "discord": ["D1"]}
    assert fake_slack.dms == [("U1", "review-1")]
    assert fake_discord.dms == [("D1", "review-1")]
    assert notifications.sent == [("review-1", "slack", "U1"), ("review-1", "discord", "D1")]

@pytest.mark.asyncio
async def test_does_not_resend_after_notification_sent():
    reviews = FakeReviews(pending={"run-1": {"org_id": "org-1", "id": "review-1"}})
    reviewers = FakeReviewers(org="org-1", rows=[{"notify_slack": True, "slack_user_id": "U1"}])
    notifications = FakeNotificationRepository(sent={("review-1", "slack", "U1")})
    notifier = ReviewNotifier(
        reviews=reviews,
        reviewers=reviewers,
        slack=fake_slack,
        discord=fake_discord,
        notifications=notifications,
    )
    await notifier.notify_reviewers("run-1")
    assert fake_slack.dms == []

@pytest.mark.asyncio
async def test_platform_delivery_error_is_best_effort():
    reviews = FakeReviews(pending={"run-1": {"org_id": "org-1", "id": "review-1"}})
    reviewers = FakeReviewers(org="org-1", rows=[{"notify_slack": True, "slack_user_id": "U1"}])
    fake_slack.raise_on_send = RuntimeError("provider down")
    notifier = ReviewNotifier(
        reviews=reviews,
        reviewers=reviewers,
        slack=fake_slack,
        discord=fake_discord,
        notifications=FakeNotificationRepository(),
    )
    sent = await notifier.notify_reviewers("run-1")  # must not raise
    assert sent["slack"] == []

@pytest.mark.asyncio
async def test_github_surface_without_support_runtime_is_skipped():
    notifier = ReviewNotifier(
        reviews=FakeReviews(pending={"run-9": {"org_id": "org-1", "id": "review-9"}}),
        reviewers=FakeReviewers(org="org-1", rows=[]),
        slack=fake_slack,
        discord=fake_discord,
        notifications=FakeNotificationRepository(),
    )
    await notifier.notify_reviewers("run-9")  # no support runtime context
    assert fake_slack.dms == [] and fake_discord.dms == []
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/review/test_review_notifier.py tests/persistence/test_review_notification_delivery.py`

Verified: FAIL before implementation — `ModuleNotFoundError: No module named 'draftly.persistence.repositories.review_notifications'`.

- [x] **Step 3: Add notification persistence and implement the notifier**

Create migration `046_review_notification_deliveries.sql` with columns `id`, `review_id`, `org_id`, `platform`, `recipient_id`, `status`, `sent_at`, `error`, `created_at`, and a unique constraint on `(review_id, platform, recipient_id)`. Implement the atomic claim/mark methods. Implement `ReviewNotifier` as a standalone module. Add a `notifier` field to `WorkflowContext` and populate it in `app/composition/workflows.py` with explicit review/reviewer repositories and organization-scoped Slack/Discord integration resolvers, mirroring how `publisher`/`broadcaster` are injected. The runner reads it via `self.context.notifier`. Keep the notifier out of `ReviewService` (that decision path is refactored by Task 6). It reads the pending review by `run_id`, fetches reviewers by org, claims each channel/recipient before sending, and dispatches only to reviewers with a matching platform preference and identity. The Slack and Discord test doubles expose the same `org_id`-aware methods as production clients.

The migration uses an atomic claim shape that supports retries after failures:

```sql
CREATE TABLE IF NOT EXISTS review_notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL REFERENCES organizations(clerk_org_id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'claimed',
    sent_at TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (review_id, platform, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_review_notification_deliveries_org
    ON review_notification_deliveries (org_id, status);
```

`claim` must insert a new row or reclaim a prior `failed` row; it must return `False` for an already `claimed` or `sent` row unless the claim lease has expired.

The notifier must call `mark_failed` when a provider attempt fails, but a failed claim must remain retryable according to the repository policy. It must invoke notification only after `store_interrupts` has persisted the pending review, and it must guard `context.notifier is not None` so existing non-composed test contexts remain valid.

- [x] **Step 4: Call the notifier on the pending_review transition**

In `workflows/runner.py`, invoke `self.context.notifier.notify_reviewers(run_id)` at each `pending_review` transition — the `_finish_result` INTERRUPTED path (the ReviewGate pause before delivery, `Status.INTERRUPTED`) and the `resume_review` failure path — before returning control. Failures must be caught and logged without affecting run status.

- [x] **Step 5: Run focused tests**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/review/test_review_notifier.py tests/persistence/test_review_notification_delivery.py tests/workflows/test_phase5_runner_events.py tests/workflows/test_github_pr_workflow.py`

Verified: PASS — 51 focused tests; full suite 1222 passed, 5 skipped. ruff clean.

- [ ] **Step 6: Commit** — SKIPPED (not a git repo)

SKIPPED (not a git repo).

```bash
git add src/draftly/review/notifier.py src/draftly/persistence/migrations/046_review_notification_deliveries.sql src/draftly/persistence/repositories/review_notifications.py src/draftly/workflows/context.py src/draftly/app/composition/workflows.py src/draftly/workflows/runner.py src/draftly/integrations/slack/client.py src/draftly/integrations/discord/client.py tests/review/test_review_notifier.py tests/persistence/test_review_notification_delivery.py
git commit -m "feat: notify reviewers of pending reviews via Slack/Discord"
```

### Task 5: Notify reviewers of pending reviews via email

**Files:**
- Create: `draftly-agent-backend/src/draftly/integrations/email.py`
- Modify: `draftly-agent-backend/src/draftly/app/config.py` (add `sendgrid_api_key`, `sendgrid_from_email`, `sendgrid_from_name`)
- Modify: `draftly-agent-backend/src/draftly/review/notifier.py` (Task 4 — add the email leg)
- Modify: `draftly-agent-backend/src/draftly/app/composition/workflows.py` (Task 4 — inject the email module into the notifier)
- Modify: `draftly-agent-backend/tests/review/test_review_notifier.py` (Task 4 — expect the `email` key)
- Test: `draftly-agent-backend/tests/review/test_review_email_notifier.py`

**Interfaces:**
- Consumes: `ReviewNotifier` from Task 4 (`async notify_reviewers(run_id) -> dict[str, list[str]]`), `ReviewersRepository.get_active_reviewers(org_id)`, `ReviewsRepository.get_pending_by_run_id(run_id)`, and the per-recipient `ReviewNotificationRepository.claim/mark_sent/mark_failed` idempotency operations from Task 4. The `reviewers` table already has `email` and `notify_email` (migration 018); notification delivery persistence is provided by Task 4 migration 046.
- Produces: `async send_email(to, subject, html_content) -> dict` and `async send_review_notification(*, to, reviewer_name, review_id, summary, dashboard_url) -> dict` in `integrations/email.py`. Both are best-effort: they return `{"ok": True, "status": "sent"}` on success and `{"ok": False, "status": "skipped"|"failed", ...}` on missing key/provider error, and never raise on delivery failure.
- `ReviewNotifier.notify_reviewers(run_id)` (Task 4) now also emails active reviewers with `notify_email=True` **and** a non-empty `email`, recording their addresses under the `"email"` key of the returned dict. Email dispatch claims `(review_id, "email", email)` through the same per-recipient notification repository, so a review is notified at most once per recipient/channel.
- The notifier constructor gains an `email` dependency (the `integrations.email` module); Task 4's wiring in `app/composition/workflows.py` passes `email=email`.
- The email body is the run summary plus a dashboard pointer to the pending review — nothing else, and no credentials or installation secrets.
- Email is independent of support runtime and remains eligible for GitHub-originated reviews. It is skipped only when the reviewer has no email, has disabled email, or the provider is not configured.

- [x] **Step 1: Write the failing email notifier tests**

```python
class FakeEmail:
    def __init__(self):
        self.sent = []
        self.raise_on_send = None

    async def send_review_notification(self, **kwargs):
        if self.raise_on_send is not None:
            raise self.raise_on_send
        self.sent.append((kwargs["to"], kwargs["review_id"]))
        return {"ok": True, "status": "sent"}


@pytest.mark.asyncio
async def test_emails_only_reviewers_with_email_pref():
    reviews = FakeReviews(pending={"run-1": {"org_id": "org-1", "id": "review-1"}})
    reviewers = FakeReviewers(org="org-1", rows=[
        {"name": "A", "notify_email": True, "email": "a@acme.com"},
        {"name": "B", "notify_email": False, "email": "b@acme.com"},
        {"name": "C", "notify_email": True, "email": None},
    ])
    email = FakeEmail()
    notifier = ReviewNotifier(
        reviews=reviews, reviewers=reviewers,
        slack=fake_slack, discord=fake_discord,
        notifications=FakeNotificationRepository(), email=email,
    )
    sent = await notifier.notify_reviewers("run-1")
    assert sent["email"] == ["a@acme.com"]
    assert email.sent == [("a@acme.com", "review-1")]


@pytest.mark.asyncio
async def test_email_leg_is_best_effort():
    reviews = FakeReviews(pending={"run-1": {"org_id": "org-1", "id": "review-1"}})
    reviewers = FakeReviewers(org="org-1", rows=[{"notify_email": True, "email": "a@acme.com"}])
    email = FakeEmail()
    email.raise_on_send = RuntimeError("provider down")
    notifier = ReviewNotifier(
        reviews=reviews,
        reviewers=reviewers,
        slack=fake_slack,
        discord=fake_discord,
        notifications=FakeNotificationRepository(),
        email=email,
    )
    sent = await notifier.notify_reviewers("run-1")  # must not raise
    assert sent["email"] == []


@pytest.mark.asyncio
async def test_email_link_points_at_dashboard_review():
    html = await build_review_email_html(
        reviewer_name="A",
        summary="Gap in auth docs",
        dashboard_url="https://app.draftly.ai/review/review-1",
    )
    assert "Gap in auth docs" in html and "/review/review-1" in html

```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/review/test_review_email_notifier.py`

Expected: FAIL because `build_review_email_html`, the email leg, and the `email` key do not exist.

- [x] **Step 3: Implement the email integration and notifier leg**

Add the SendGrid settings to `draftly-agent-backend/src/draftly/app/config.py`:

```python
sendgrid_api_key: str | None = None
sendgrid_from_email: str = "reviews@draftly.ai"
sendgrid_from_name: str = "Draftly Reviews"
```

Create `draftly-agent-backend/src/draftly/integrations/email.py`:

```python
"""Email review notifications (SendGrid v3 API, best-effort)."""

from __future__ import annotations

from html import escape
from string import Template

import httpx
import structlog

from draftly.app.config import get_settings

logger = structlog.get_logger(__name__)

REVIEW_EMAIL_TEMPLATE = Template("""\
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
  <h1>Documentation Review Required</h1>
  <p>Hi ${reviewer_name},</p>
  <p>Draftly produced a documentation change that needs your review:</p>
  <blockquote>${summary}</blockquote>
  <p><a href="${dashboard_url}">Review in Dashboard</a></p>
  <p>This review link expires in 24 hours.</p>
</body>
</html>
""")


async def build_review_email_html(
    *,
    reviewer_name: str,
    summary: str,
    dashboard_url: str,
) -> str:
    return REVIEW_EMAIL_TEMPLATE.substitute(
        reviewer_name=escape(reviewer_name),
        summary=escape(summary),
        dashboard_url=escape(dashboard_url),
    )


async def send_email(to: str, subject: str, html_content: str) -> dict:
    settings = get_settings()
    if not settings.sendgrid_api_key:
        logger.warning("sendgrid_not_configured")
        return {"ok": False, "status": "skipped", "reason": "no_api_key"}

    headers = {
        "Authorization": f"Bearer {settings.sendgrid_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "personalizations": [{"to": [{"email": to}]}],
        "from": {
            "email": settings.sendgrid_from_email,
            "name": settings.sendgrid_from_name,
        },
        "subject": subject,
        "content": [{"type": "text/html", "value": html_content}],
    }

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.sendgrid.com/v3/mail/send",
                headers=headers,
                json=payload,
                timeout=10,
            )
    except httpx.HTTPError as exc:
        logger.exception("sendgrid_transport_failed")
        return {"ok": False, "status": "failed", "error": str(exc)}
    if resp.status_code not in (200, 201, 202):
        logger.error("sendgrid_send_failed", status=resp.status_code, body=resp.text)
        return {"ok": False, "status": "failed", "error": resp.text}
    return {"ok": True, "status": "sent"}


async def send_review_notification(
    *,
    to: str,
    reviewer_name: str,
    review_id: str,
    summary: str,
    dashboard_url: str,
) -> dict:
    html = await build_review_email_html(
        reviewer_name=reviewer_name,
        summary=summary,
        dashboard_url=dashboard_url,
    )
    return await send_email(to, f"Review Required: {summary[:80]}", html)
```

In `draftly-agent-backend/src/draftly/review/notifier.py`, extend `ReviewNotifier` with an `email` dependency and an email leg inside `notify_reviewers`, after the Discord leg. For each active reviewer with `notify_email=True` and a non-empty address, claim `(review_id, "email", reviewer.email)`, call `send_review_notification()` with the reviewer name, review action summary, and configured dashboard URL, then mark the claim sent or failed. Return `{"slack": slack_targets, "discord": discord_targets, "email": email_targets}`. Do not gate this leg on support runtime.

Update Task 4's notifier test to expect the new key (`tests/review/test_review_notifier.py`):

```python
assert sent == {"slack": ["U1"], "discord": ["D1"], "email": []}
```

In `draftly-agent-backend/src/draftly/app/composition/workflows.py`, pass the email module when constructing the notifier:

```python
from draftly import integrations as _integrations

notifier = ReviewNotifier(
    reviews=reviews_repository,
    reviewers=reviewers_repository,
    slack=slack_client,
    discord=discord_client,
    notifications=review_notification_repository,
    email=_integrations.email,
)
```

- [x] **Step 4: Run focused tests**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/review/test_review_email_notifier.py tests/review/test_review_notifier.py tests/workflows/test_phase5_runner_events.py`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/draftly/integrations/email.py src/draftly/app/config.py src/draftly/review/notifier.py src/draftly/app/composition/workflows.py tests/review/test_review_email_notifier.py tests/review/test_review_notifier.py
git commit -m "feat: notify reviewers of pending reviews via email"
```

### Task 6: Unify review decisions and resume Slack/Discord workflows

**Files:**
- Create: `draftly-agent-backend/src/draftly/review/resume.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/github.py`
- Modify: `draftly-agent-backend/src/draftly/integrations/slack/app.py`
- Modify: `draftly-agent-backend/src/draftly/app/api/routes/discord.py`
- Modify: `draftly-agent-backend/src/draftly/review/service.py`
- Test: `draftly-agent-backend/tests/review/test_review_resume.py`
- Test: `draftly-agent-backend/tests/integrations/test_review_interactions.py`

**Interfaces:**
- Add `async resume_review_decision(*, review_id, approved, reviewer_id, comment, app_state) -> WorkflowState`.
- Define `ReviewResumeError` in `review/resume.py` for validation, resume, and final-status failures.
- It must load the pending review, verify its organization, load the persisted source event, restore `installation_id`/support target metadata, call `WorkflowRunner.resume_review`, and only then persist the review decision.
- Approval requires final status `delivered`; rejection requires final status `failed`.
- Resume failures must leave the review actionable and must not record a successful approval.

- [x] **Step 1: Write failing tests for approval and rejection**

```python
@pytest.mark.asyncio
async def test_slack_approval_resumes_support_graph_and_delivers():
    state = await resume_review_decision(
        review_id="review-1",
        approved=True,
        reviewer_id="user-1",
        comment="ship it",
        app_state=fake_app_state(workflow_status="delivered"),
    )
    assert state.status.value == "delivered"

@pytest.mark.asyncio
async def test_resume_failure_does_not_mark_approval_complete():
    with pytest.raises(ReviewResumeError):
        await resume_review_decision(
            review_id="review-1",
            approved=True,
            reviewer_id="user-1",
            comment="ship it",
            app_state=fake_app_state(workflow_status="pending_review"),
        )
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/review/test_review_resume.py tests/integrations/test_review_interactions.py`

Expected: FAIL because Slack and Discord interaction handlers currently only call `ReviewService.decide`.

- [x] **Step 3: Implement the shared resume service**

Refactor the GitHub review route to use the same service rather than maintaining a separate resume implementation.

- [x] **Step 4: Update Slack and Discord interaction handlers**

Replace direct `review_decision.decide(...)` calls with the shared resume operation. Preserve platform-specific acknowledgement responses after the resume result is known.

- [x] **Step 5: Run focused interaction tests**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/review/test_review_resume.py tests/integrations/test_review_interactions.py tests/workflows/test_phase5_runner_events.py`

Expected: PASS.

- [ ] **Step 6: Commit** — SKIPPED (not a git repo)

```bash
git add src/draftly/review/resume.py src/draftly/app/api/routes/github.py src/draftly/integrations/slack/app.py src/draftly/app/api/routes/discord.py src/draftly/review/service.py tests/review/test_review_resume.py tests/integrations/test_review_interactions.py
git commit -m "fix: resume support workflows from platform reviews"
```

### Task 7: Persist support workflow identity, delivery receipts, and statuses

**Files:**
- Create: `draftly-agent-backend/src/draftly/persistence/migrations/047_support_delivery_receipts.sql`
- Modify: `draftly-agent-backend/src/draftly/delivery/models.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/slack.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/discord.py`
- Modify: `draftly-agent-backend/src/draftly/persistence/repositories/support.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/runner.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/support/support_resolution.py`
- Test: `draftly-agent-backend/tests/persistence/test_support_delivery.py`
- Test: `draftly-agent-backend/tests/workflows/test_support_delivery_persistence.py`

**Interfaces:**
- Add `SupportDeliveryReceipt` with `run_id`, `org_id`, `platform`, `channel_id`, `thread_id`, `source_message_id`, `provider_message_id`, `status`, `error`, and `delivered_at`.
- Add repository methods `save_support_delivery(receipt)` and `get_support_delivery(run_id)` for Slack and Discord workflow records.
- Add `get_support_delivery_by_source(org_id, platform, source_message_id)` for idempotency checks before posting.
- Add `source_message_id`, provider delivery ID, delivery error, and delivered timestamp to both existing workflow tables. Existing columns are `slack_workflows.source_message` and `discord_workflows.source_message`; do not index the message body as the event identity. Add indexes on `(org_id, status)` and partial unique indexes on `(org_id, source_message_id)`.
- `_persist_delivery_result` must handle `surface in {"slack", "discord"}` in addition to GitHub.

- [x] **Step 1: Write failing persistence tests**

```python
@pytest.mark.asyncio
async def test_slack_receipt_persists_provider_message_id():
    repo = FakeSlackWorkflowRepository()
    receipt = SupportDeliveryReceipt(
        run_id="run-1", org_id="org-1", platform="slack",
        channel_id="C1", thread_id="1", source_message_id="C1:1",
        provider_message_id="2", status="delivered",
    )
    await repo.save_support_delivery(receipt)
    assert repo.saved[0].provider_message_id == "2"
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/persistence/test_support_delivery.py tests/workflows/test_support_delivery_persistence.py`

Expected: FAIL because support delivery receipts and repository methods do not exist.

- [x] **Step 3: Add the migration and model**

Use nullable provider IDs so failed/pending records remain representable. Add a source event identity to each existing workflow table and enforce one delivery record per organization/source event at the database layer.

The migration must add the provider receipt fields to the existing Slack/Discord workflow persistence and enforce the source-event uniqueness at the database layer:

```sql
ALTER TABLE slack_workflows ADD COLUMN IF NOT EXISTS source_message_id TEXT;
ALTER TABLE slack_workflows ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE slack_workflows ADD COLUMN IF NOT EXISTS delivery_error TEXT;
ALTER TABLE slack_workflows ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE discord_workflows ADD COLUMN IF NOT EXISTS source_message_id TEXT;
ALTER TABLE discord_workflows ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE discord_workflows ADD COLUMN IF NOT EXISTS delivery_error TEXT;
ALTER TABLE discord_workflows ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_slack_workflows_org_status ON slack_workflows (org_id, status);
CREATE INDEX IF NOT EXISTS idx_discord_workflows_org_status ON discord_workflows (org_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_slack_workflows_org_source
    ON slack_workflows (org_id, source_message_id)
    WHERE source_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_discord_workflows_org_source
    ON discord_workflows (org_id, source_message_id)
    WHERE source_message_id IS NOT NULL;
```

- [x] **Step 4: Persist delivery results and lifecycle transitions**

Extract Slack `ts` and Discord message `id` from tool results. Update the matching platform workflow row to `delivered` or `failed`. Invoke `resolve_support_thread` only after a successful persisted delivery.

- [x] **Step 5: Add idempotency checks before posting**

Before `slack_post_message` or `discord_post_message`, query the receipt by organization/source event. If an existing delivered receipt is found, return it instead of posting again.

- [x] **Step 6: Run focused persistence tests**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/persistence/test_support_delivery.py tests/workflows/test_support_delivery_persistence.py tests/workflow/test_runner_post_run_memory.py`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/draftly/persistence/migrations/047_support_delivery_receipts.sql src/draftly/delivery/models.py src/draftly/persistence/repositories/slack.py src/draftly/persistence/repositories/discord.py src/draftly/persistence/repositories/support.py src/draftly/workflows/runner.py src/draftly/workflows/support/support_resolution.py tests/persistence/test_support_delivery.py tests/workflows/test_support_delivery_persistence.py
git commit -m "feat: persist support delivery receipts"
```

### Task 8: Connect documentation-gap support outcomes to GitHub delivery

**Files:**
- Modify: `draftly-agent-backend/src/draftly/orchestration/graphs/support_graph.py`
- Create: `draftly-agent-backend/src/draftly/workflows/support/models.py`
- Modify: `draftly-agent-backend/src/draftly/app/composition/tools.py`
- Modify: `draftly-agent-backend/src/draftly/agents/prompts.py`
- Modify: `draftly-agent-backend/src/draftly/skills/support-delivery/SKILL.md`
- Modify: `draftly-agent-backend/src/draftly/workflows/support/support_resolution.py`
- Modify: `draftly-agent-backend/src/draftly/workflows/content/content_generation.py`
- Test: `draftly-agent-backend/tests/graph/test_support_delivery_routing.py`
- Test: `draftly-agent-backend/tests/workflows/test_support_to_github_delivery.py`

**Interfaces:**
- Direct-answer support runs remain restricted to the originating platform delivery tool.
- `update`/`create` support outcomes must emit a typed `DocumentationGapRequest` containing `org_id`, `repository`, `base_branch`, source event IDs, evidence, and the generated change plan.
- Add an explicit `support_to_github` delivery path that uses `github_delivery` tools only when a repository target is present and the review gate approves.
- Never let the language model choose Slack/Discord for a GitHub-only documentation event without an explicit support delivery target.
- Define `DocumentationGapRequest` in `workflows/support/models.py` and `route_support_outcome(request) -> Literal["slack", "discord", "github"]` in `support_resolution.py`.
- Define `_delivery_tools_for_source(source, registry)` in `support_graph.py`; direct Slack answers receive only Slack posting tools, and direct Discord answers receive only Discord posting tools.

- [x] **Step 1: Write failing routing tests**

```python
def tool_names(tools):
    return {
        getattr(tool, "name", None)
        or getattr(getattr(tool, "fn", None), "__name__", None)
        or getattr(tool, "__name__", None)
        for tool in tools
    }

def test_direct_support_answer_exposes_only_origin_platform_delivery():
    tools = build_tools()
    assert tool_names(_delivery_tools_for_source("slack", tools)) == {"slack_post_message"}
    assert tool_names(_delivery_tools_for_source("discord", tools)) == {"discord_post_message"}

def test_documentation_gap_routes_to_github_delivery():
    request = DocumentationGapRequest(
        org_id="org-1", repository="acme/docs", base_branch="main", source_event_ids=["evt-1"]
    )
    assert route_support_outcome(request) == "github"
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/graph/test_support_delivery_routing.py tests/workflows/test_support_to_github_delivery.py`

Expected: FAIL because the support graph currently exposes both platform delivery tools and has no explicit GitHub handoff.

- [x] **Step 3: Implement explicit delivery routing**

Use the normalized event’s source platform for direct answers. Route documentation changes through a typed handoff to the existing documentation/GitHub delivery path, preserving organization and repository identity.

- [x] **Step 4: Update skill and prompt contracts**

Document the exact distinction: answer → originating thread; documentation gap → reviewed GitHub PR. Include required receipt fields and forbid cross-platform posting without a target.

- [x] **Step 5: Run focused routing tests**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/graph/test_support_delivery_routing.py tests/workflows/test_support_to_github_delivery.py tests/graph/test_surface_graphs.py`

Expected: PASS.

- [ ] **Step 6: Commit** — SKIPPED (not a git repo)

```bash
git add src/draftly/orchestration/graphs/support_graph.py src/draftly/app/composition/tools.py src/draftly/agents/prompts.py src/draftly/skills/support-delivery/SKILL.md src/draftly/workflows/support/support_resolution.py src/draftly/workflows/content/content_generation.py tests/graph/test_support_delivery_routing.py tests/workflows/test_support_to_github_delivery.py
git commit -m "feat: route support documentation gaps to GitHub"
```

### Task 9: Add end-to-end verification and operational documentation

**Files:**
- Create: `draftly-agent-backend/tests/integration/test_slack_support_delivery.py`
- Create: `draftly-agent-backend/tests/integration/test_discord_support_delivery.py`
- Modify: `draftly-agent-backend/docs/workflows/support.md`
- Modify: `draftly-agent-backend/docs/api/routes.md`
- Modify: `draftly-agent-backend/docs/deployment/production.md`
- Modify: `SUPPORT_EVENT_WORKFLOW_ANALYSIS.md`

**Interfaces:**
- Integration tests use fake provider clients and a fake task queue; they must cover ingress, organization enrichment, queue dispatch, review resume, delivery, duplicate suppression, and final persistence.
- Production documentation must list Slack OAuth installation, Discord guild linking, required secrets, queue workers, and review callback behavior.
- Define `run_fake_slack_question(...)` and `run_fake_discord_question(...)` test fixtures in the respective integration test files; each fixture must execute the real normalizer, task handler, review-resume helper, and fake provider client.

- [x] **Step 1: Write the end-to-end tests**

```python
@pytest.mark.asyncio
async def test_slack_question_is_reviewed_and_replied_once():
    run = await run_fake_slack_question("T1", "C1", "1", review=True, approve=True)
    assert run.status == "delivered"
    assert fake_slack.sent == [{"channel": "C1", "thread_ts": "1"}]

@pytest.mark.asyncio
async def test_discord_duplicate_event_does_not_post_twice():
    await run_fake_discord_question("G1", "C1", "m1")
    await run_fake_discord_question("G1", "C1", "m1")
    assert len(fake_discord.sent) == 1
```

- [x] **Step 2: Run the integration tests to establish the missing behavior**

Run: `cd draftly-agent-backend && .venv/bin/pytest -q tests/integration/test_slack_support_delivery.py tests/integration/test_discord_support_delivery.py`

Expected: FAIL until Tasks 1–8 are complete.

- [x] **Step 3: Implement test fixtures and fake provider clients**

Keep network calls out of tests. Assert exact organization IDs, queue task names, thread targets, review transitions, email notification targets, and persisted receipt IDs.

- [x] **Step 4: Document the final operational contract**

Document that Slack/Discord support uses durable worker dispatch, installation/guild linking, organization-scoped delivery, explicit review resume, reviewer notification dispatch (Tasks 4 and 5), and receipt persistence.

- [x] **Step 5: Run the full verification suite**

Run:

```bash
cd draftly-agent-backend
.venv/bin/pytest -q
.venv/bin/ruff check src tests
.venv/bin/python -m compileall -q src
graphify update .
```

Expected: all tests pass, Ruff reports no errors, compilation succeeds, and graphify refreshes the modified code paths.

- [ ] **Step 6: Commit** — SKIPPED (not a git repo)

```bash
git add tests/integration/test_slack_support_delivery.py tests/integration/test_discord_support_delivery.py docs/workflows/support.md docs/api/routes.md docs/deployment/production.md ../SUPPORT_EVENT_WORKFLOW_ANALYSIS.md graphify-out
git commit -m "docs: verify Slack and Discord workflow wiring"
```

## Final Review Checklist

- [ ] Slack events resolve to the correct Clerk organization before workflow execution.
- [ ] Discord events resolve to the correct Clerk organization before workflow execution.
- [ ] Outbound Slack credentials are selected by workspace installation, not only environment fallback.
- [ ] Discord delivery validates guild ownership and configured target channels.
- [ ] Slack and Discord support jobs survive API process restarts through the worker queue.
- [ ] Platform approval actions resume the paused graph and preserve review state on failure.
- [ ] Delivery receipts prevent duplicate replies and expose provider message IDs.
- [ ] Direct answers return to the originating platform thread.
- [ ] Documentation-gap outcomes route explicitly to GitHub delivery.
- [ ] GitHub-only workflows cannot accidentally post to Slack or Discord.
- [ ] Reviewers with `notify_slack` / `notify_discord` prefs are notified when a review becomes pending.
- [ ] Reviewers with `notify_email` prefs and an email address are emailed when a review becomes pending.
- [ ] Each pending review/recipient/channel is notified at most once through the unique notification-delivery claim; Slack, Discord, and email failures remain independently retryable.
- [ ] Email notifications include the run summary and a dashboard pointer and embed no secrets.
- [ ] Full tests, Ruff, compilation, and graphify refresh pass.
