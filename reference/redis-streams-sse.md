Yes. Replacing CockroachDB with [Neon](https://neon.tech?utm_source=chatgpt.com) changes the **durable database layer**, but it does **not** fundamentally change the Redis Streams + SSE architecture.

For Draftly, I would recommend this architecture:

```text
                           ┌──────────────────────┐
                           │   Draftly Agents     │
                           │                      │
                           │ Research Agent       │
                           │ Documentation Agent │
                           │ Evaluation Agent     │
                           │ Memory Curator       │
                           └──────────┬───────────┘
                                      │
                                      │ Domain Events
                                      ▼
                            ┌─────────────────┐
                            │ Event Publisher │
                            └────────┬────────┘
                                     │
                  ┌──────────────────┴──────────────────┐
                  │                                     │
                  ▼                                     ▼
          Neon PostgreSQL                         Redis Streams
          Durable State                           Live Event Log
                  │                                     │
                  │                                     ▼
                  │                              FastAPI SSE
                  │                                     │
                  └──────────────────┬──────────────────┘
                                     ▼
                              Next.js Frontend
```

The fundamental separation is:

> **Neon remembers what Draftly's current state is. Redis Streams remembers what happened recently and delivers those events to connected users.**

Redis Streams are append-only logs with ordered IDs and support reading from a specific cursor with `XREAD`; this makes them a good match for SSE reconnection and event replay. ([Redis][1])

---

# 1. The responsibilities of Neon and Redis

## Neon PostgreSQL: durable application state

Neon should store things such as:

```text
Users
Organizations
Repositories
Documentation jobs
Workflow runs
Agent runs
Documents
Evaluations
Review requests
Knowledge/memory records
```

For example:

```text
documentation_jobs

id
organization_id
repository_id
status
progress
current_agent
started_at
completed_at
```

A row might look like:

```json
{
  "id": "job_123",
  "status": "running",
  "progress": 65,
  "current_agent": "documentation_agent"
}
```

---

## Redis Streams: event timeline and delivery

Redis receives events:

```text
workflow.started
agent.started
agent.progress
agent.completed
document.generated
evaluation.completed
review.required
workflow.completed
workflow.failed
```

For example:

```text
draftly:job:job_123:events
```

contains:

```text
1724720000000-0
workflow.started

1724720000100-0
agent.started

1724720005000-0
agent.progress

1724720010000-0
document.generated
```

Redis Streams automatically assign ordered IDs to entries, and clients can later read entries newer than a specific ID. ([Redis][1])

---

# 2. Recommended Draftly event flow

Suppose a GitHub PR triggers Draftly.

```text
GitHub PR
    │
    ▼
Webhook
    │
    ▼
Draftly Workflow
    │
    ▼
Research Agent
```

The agent starts.

The workflow should do two things:

```text
                 Event
                   │
          ┌────────┴────────┐
          │                 │
          ▼                 ▼
       Neon              Redis
     Update State         XADD
```

For example:

```text
Agent starts
      │
      ▼
Update Neon

status = running
current_agent = research_agent

      │
      ▼
Redis XADD

agent.started
```

The UI receives the Redis event immediately through SSE.

---

# 3. Create a standard Draftly event model

I recommend treating events as domain-level objects.

```python
# app/events/models.py

from datetime import datetime
from typing import Any

from pydantic import BaseModel


class DraftlyEvent(BaseModel):
    event_type: str
    job_id: str

    timestamp: datetime

    data: dict[str, Any]
```

For example:

```python
DraftlyEvent(
    event_type="agent.progress",
    job_id="job_123",
    timestamp=datetime.now(),
    data={
        "agent": "documentation_agent",
        "progress": 65,
        "message": "Generating API documentation",
    },
)
```

Notice something important:

The event does **not** know anything about:

```text
SSE
Next.js
React
Browser
```

This is intentional.

Your agents should emit:

```text
Domain Events
```

not:

```text
Frontend Messages
```

That keeps Draftly's architecture decoupled.

---

# 4. Redis Streams event publisher

Use the async Redis client with FastAPI.

The Redis Python client provides an asyncio-compatible API through `redis.asyncio`, which is suitable for async frameworks such as FastAPI. ([Redis][2])

```python
# app/events/publisher.py

import json

from redis.asyncio import Redis

from app.events.models import DraftlyEvent


class EventPublisher:

    def __init__(
        self,
        redis: Redis,
    ):
        self.redis = redis


    async def publish(
        self,
        event: DraftlyEvent,
    ) -> str:

        stream_key = (
            f"draftly:job:"
            f"{event.job_id}:events"
        )

        event_id = await self.redis.xadd(
            stream_key,
            {
                "event_type": event.event_type,
                "job_id": event.job_id,
                "timestamp": event.timestamp.isoformat(),
                "data": event.data.model_dump_json()
                if hasattr(event.data, "model_dump_json")
                else json.dumps(event.data),
            },
            maxlen=1000,
            approximate=True,
        )

        return event_id
```

Conceptually:

```text
Research Agent

    │
    │ agent.started
    ▼

EventPublisher

    │
    ▼

XADD draftly:job:job_123:events

    │
    ▼

1724720000000-0
```

The Redis Stream ID becomes the SSE event ID.

That relationship is extremely useful.

---

# 5. Update Neon and publish the event

You should centralize this rather than allowing every agent to directly manipulate Redis and Neon.

I would create a service such as:

```text
WorkflowService
        │
        ├── Neon Repository
        │
        └── Event Publisher
```

For example:

```python
# app/services/job_service.py

class JobService:

    def __init__(
        self,
        job_repository,
        event_publisher,
    ):
        self.job_repository = job_repository
        self.event_publisher = event_publisher


    async def update_progress(
        self,
        job_id: str,
        agent: str,
        progress: int,
        message: str,
    ):

        # 1. Persist durable state
        await self.job_repository.update(
            job_id=job_id,
            progress=progress,
            current_agent=agent,
        )

        # 2. Publish live event
        event = DraftlyEvent(
            event_type="agent.progress",
            job_id=job_id,
            timestamp=datetime.now(),
            data={
                "agent": agent,
                "progress": progress,
                "message": message,
            },
        )

        await self.event_publisher.publish(event)
```

Then your agents do this:

```python
await job_service.update_progress(
    job_id=job_id,
    agent="research_agent",
    progress=40,
    message="Analyzing repository structure",
)
```

The agent never directly calls:

```text
Redis
SSE
Neon
```

It interacts with the application service.

---

# 6. The FastAPI SSE endpoint

The SSE endpoint reads from Redis Streams.

The basic logic is:

```text
Browser connects
       │
       ▼
FastAPI receives Last-Event-ID
       │
       ▼
Read Redis Stream
       │
       ├── missed events
       │
       ▼
XREAD BLOCK
       │
       ▼
Wait for new events
       │
       ▼
Send to browser
```

FastAPI now has built-in SSE support via `EventSourceResponse` and `ServerSentEvent`, including support for SSE event IDs and reconnection through the `Last-Event-ID` header. ([FastAPI][3])

A production-oriented implementation could look like:

```python
# app/api/routes/events.py

from collections.abc import AsyncGenerator

from fastapi import APIRouter, Header
from fastapi.sse import (
    EventSourceResponse,
    ServerSentEvent,
)

from app.dependencies import get_redis


router = APIRouter()


@router.get(
    "/jobs/{job_id}/events",
    response_class=EventSourceResponse,
)
async def stream_job_events(
    job_id: str,
    last_event_id: str | None = Header(
        default=None,
    ),
):

    redis = get_redis()

    stream_key = (
        f"draftly:job:"
        f"{job_id}:events"
    )

    async def event_generator() -> AsyncGenerator:

        # If reconnecting, continue after the
        # last event received by the browser.
        last_id = last_event_id or "$"

        while True:

            response = await redis.xread(
                streams={
                    stream_key: last_id,
                },
                count=100,
                block=15000,
            )

            if not response:
                continue

            for _, messages in response:

                for event_id, fields in messages:

                    last_id = event_id

                    yield ServerSentEvent(
                        id=event_id,
                        event=fields["event_type"],
                        data={
                            "job_id": fields["job_id"],
                            "timestamp": fields["timestamp"],
                            "data": fields["data"],
                        },
                    )

    return EventSourceResponse(
        event_generator()
    )
```

Redis `XREAD` can block while waiting for new entries and can read only entries newer than a supplied stream ID, which is exactly the cursor behavior needed for a long-lived SSE connection. ([Redis][1])

---

# 7. Understanding `$` versus `Last-Event-ID`

This is an important detail.

When a user connects for the first time:

```text
Last-Event-ID = None
```

You probably don't want to replay the entire workflow history by default.

So:

```python
last_id = "$"
```

means:

```text
Start from the current end of the stream.

Only send NEW events.
```

But when the browser reconnects:

```text
Last-Event-ID: 1724720005000-0
```

You do:

```python
last_id = "1724720005000-0"
```

Redis then returns:

```text
1724720006000-0
1724720007000-0
1724720008000-0
```

The flow becomes:

```text
Browser

received event 1724720005000-0
          │
          ▼
Connection lost
          │
          ▼
New events added

6000-0
7000-0
8000-0
          │
          ▼
Browser reconnects
          │
          │ Last-Event-ID: 5000-0
          ▼
FastAPI
          │
          ▼
Redis XREAD
          │
          ▼
6000-0 ✓
7000-0 ✓
8000-0 ✓
```

---

# 8. Next.js frontend

Your frontend connects with `EventSource`.

```typescript
"use client";

import { useEffect, useState } from "react";

interface DraftlyEvent {
  id: string;
  type: string;

  job_id: string;

  timestamp: string;

  data: Record<string, unknown>;
}

export function useJobEvents(jobId: string) {
  const [connected, setConnected] = useState(false);

  const [events, setEvents] = useState<DraftlyEvent[]>([]);

  useEffect(() => {
    if (!jobId) {
      return;
    }

    const url = `${process.env.NEXT_PUBLIC_API_URL}` + `/jobs/${jobId}/events`;

    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      setConnected(true);
    };

    eventSource.onerror = () => {
      setConnected(false);
    };

    const eventTypes = [
      "workflow.started",
      "agent.started",
      "agent.progress",
      "agent.completed",
      "document.generated",
      "evaluation.completed",
      "review.required",
      "workflow.completed",
      "workflow.failed",
    ];

    eventTypes.forEach((eventType) => {
      eventSource.addEventListener(eventType, (event) => {
        const message = event as MessageEvent;

        const payload = JSON.parse(message.data);

        setEvents((current) => [
          ...current,
          {
            id: event.lastEventId,
            type: eventType,
            ...payload,
          },
        ]);
      });
    });

    return () => {
      eventSource.close();
    };
  }, [jobId]);

  return {
    events,
    connected,
  };
}
```

---

# 9. The frontend should still fetch Neon-backed state

This is one of the most important parts of the architecture.

Do not build your UI entirely from the event stream.

Instead:

```text
                  Neon
                    │
                    ▼
          GET /jobs/job_123
                    │
                    ▼
             Initial UI State


Redis Streams
      │
      ▼
SSE Events
      │
      ▼
Incremental UI Updates
```

When the page opens:

```typescript
const job = await fetchJob(jobId);
```

Then:

```typescript
const { events, connected } = useJobEvents(jobId);
```

This creates:

```text
             Neon

     Current Truth

          │
          ▼

    Initial UI State

          │
          │
          ▼

       Redis SSE

   Incremental Updates
```

---

# 10. Example Draftly workflow

Imagine the user clicks:

```text
Update Documentation
```

### Step 1

Next.js:

```text
POST /jobs
```

FastAPI creates:

```text
Neon

job_123

status = queued
```

---

### Step 2

The workflow starts:

```text
workflow.started
```

The service:

```text
UPDATE Neon

status = running
```

Then:

```text
XADD Redis

workflow.started
```

The frontend receives:

```text
● Documentation workflow started
```

---

### Step 3

Research Agent starts:

```text
UPDATE Neon

current_agent = research_agent
progress = 10
```

Redis:

```text
agent.started
```

Frontend:

```text
✓ Workflow started
● Researching repository
○ Generating documentation
○ Evaluating output
```

---

### Step 4

Documentation Agent completes:

```text
UPDATE Neon

progress = 75
current_agent = evaluation_agent
```

Redis:

```text
document.generated
```

Frontend updates instantly.

---

### Step 5

Human review is required:

```text
Neon:

status = awaiting_review
```

Redis:

```text
review.required
```

The UI immediately displays:

```text
┌────────────────────────────┐
│ Review Required            │
│                            │
│ Documentation is ready.    │
│                            │
│ [ Review Documentation ]   │
└────────────────────────────┘
```

---

# 11. One stream per job is my recommendation initially

For Draftly, I recommend:

```text
draftly:job:{job_id}:events
```

Example:

```text
draftly:job:job_123:events
draftly:job:job_456:events
draftly:job:job_789:events
```

This maps naturally to your SSE endpoint:

```text
/jobs/job_123/events
        │
        ▼
draftly:job:job_123:events
```

This is much simpler than:

```text
One Global Stream

draftly:events
```

where every SSE connection needs to filter events belonging to its job.

For your current Draftly architecture, I would optimize for **clarity and correctness first**.

---

# 12. Should you use Redis Consumer Groups for SSE?

**No, not directly.**

This is an important distinction.

Consumer groups are designed for distributed workers that share work.

For example:

```text
Redis Stream
      │
      ▼
Consumer Group
      │
 ┌────┼────┐
 ▼    ▼    ▼
W1    W2    W3
```

Each event goes to one worker.

But SSE requires fan-out:

```text
One Event
     │
     ├────► User A
     ├────► User B
     └────► User C
```

For SSE, each connected FastAPI instance should generally use its own `XREAD` cursor.

```text
Redis Stream
     │
     ├──────────────► FastAPI A
     │                  │
     │                  ├── User A
     │                  └── User B
     │
     └──────────────► FastAPI B
                        │
                        └── User C
```

Each SSE connection tracks its own last event ID.

Redis Streams naturally support multiple consumers independently reading the same entries. ([Redis][1])

---

# 13. Stream retention is essential

Without trimming:

```text
Redis Stream

Event
Event
Event
Event
Event

... forever
```

You should set retention.

For example:

```python
await redis.xadd(
    stream_key,
    fields,
    maxlen=1000,
    approximate=True,
)
```

Or use time-based trimming depending on your Redis deployment and retention requirements.

Remember:

> Redis Streams should not be Draftly's permanent audit log.

Your permanent data belongs in Neon.

Redis should contain:

```text
Recent events
Replay window
Live event transport
```

Neon should contain:

```text
Job history
Workflow history
Agent history
Documents
Reviews
Important business records
```

---

# 14. My recommended production structure

I would organize the backend approximately like this:

```text
app/
│
├── api/
│   └── routes/
│       ├── jobs.py
│       └── events.py
│
├── events/
│   ├── models.py
│   ├── publisher.py
│   ├── streams.py
│   └── types.py
│
├── infrastructure/
│   ├── neon/
│   │   ├── client.py
│   │   └── repositories/
│   │       └── jobs.py
│   │
│   └── redis/
│       └── client.py
│
├── services/
│   └── job_service.py
│
├── workflows/
│   └── documentation.py
│
└── agents/
    ├── research/
    ├── documentation/
    ├── evaluation/
    └── memory_curator/
```

The dependency direction should be:

```text
                    API
                     │
                     ▼
                  Services
                     │
          ┌──────────┴──────────┐
          │                     │
          ▼                     ▼
       Neon DB             Event System
                                  │
                                  ▼
                            Redis Streams


Agents / Workflows
        │
        ▼
     Services
```

---

# Final recommendation for Draftly

I would implement Draftly like this:

```text
┌───────────────────────────────────────────┐
│              Draftly Workflow             │
│                                           │
│ Research → Docs → Evaluation → Review     │
└───────────────────┬───────────────────────┘
                    │
                    ▼
             JobService
                    │
        ┌───────────┴────────────┐
        │                        │
        ▼                        ▼
  Neon PostgreSQL          Redis Streams
  ───────────────          ─────────────
  Durable State            Event Timeline
  Jobs                     Recent Replay
  Documents                Live Events
  Reviews
        │                        │
        │                        ▼
        │                  FastAPI SSE
        │                        │
        └────────────┬───────────┘
                     ▼
                Next.js UI
```

### The key rule I recommend

> **Neon is the source of truth. Redis Streams are the real-time event transport and short-term replay layer. SSE is only the delivery mechanism to the browser.**

This architecture is a strong fit for Draftly because your workflows are long-running and multi-agent, while users may disconnect, reconnect, open the same job in multiple tabs, or arrive after a workflow has already progressed. Redis Streams gives the frontend a recoverable event timeline, while Neon preserves the authoritative state.

[1]: https://redis.io/docs/latest/develop/data-types/streams/?utm_source=chatgpt.com "Redis Streams | Docs"
[2]: https://redis.io/docs/latest/develop/clients/redis-py/async/?utm_source=chatgpt.com "Asynchronous operations with redis-py | Docs"
[3]: https://fastapi.tiangolo.com/tutorial/server-sent-events/?utm_source=chatgpt.com "Server-Sent Events (SSE) - FastAPI"
