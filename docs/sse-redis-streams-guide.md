# Real-Time Streaming with SSE: sse-starlette, EventSource, and Redis Streams

A comprehensive explanation of Server-Sent Events (SSE) and how to build a real-time
platform using **Python + FastAPI** (backend) and **Next.js + TypeScript** (frontend),
with **Redis Streams** as the durable message backbone.

---

## Table of Contents

1. [What problem does this solve?](#1-what-problem-does-this-solve)
2. [The three pieces at a glance](#2-the-three-pieces-at-a-glance)
3. [Server-Sent Events (SSE) — the protocol](#3-server-sent-events-sse--the-protocol)
4. [sse-starlette — the Python/FastAPI SSE server](#4-sse-starlette--the-pythonfastapi-sse-server)
5. [The EventSource interface — the browser/TypeScript client](#5-the-eventsource-interface--the-browsertypescript-client)
6. [Redis Streams — the durable message backbone](#6-redis-streams--the-durable-message-backbone)
7. [Putting it all together: architecture](#7-putting-it-all-together-architecture)
8. [Backend: FastAPI + sse-starlette + Redis Streams](#8-backend-fastapi--sse-starlette--redis-streams)
9. [Frontend: Next.js + TypeScript with EventSource](#9-frontend-nextjs--typescript-with-eventsource)
10. [Production considerations](#10-production-considerations)
11. [When to choose SSE vs WebSockets](#11-when-to-choose-sse-vs-websockets)

---

## 1. What problem does this solve?

Many applications need the server to **push updates to the client in real time**: live
notifications, progress bars, activity feeds, dashboards, AI token streaming, logs, and
price tickers. The classic options are:

- **Polling** — the client repeatedly asks "anything new?" (wasteful, high latency).
- **Long-polling** — the server holds the request open until data arrives (works, but clunky).
- **WebSockets** — full bidirectional socket (powerful, but more complex, needs special
  infra/proxy config, and is overkill for one-way server→client updates).
- **Server-Sent Events (SSE)** — a *native browser standard* for a one-way, server→client
  stream over plain HTTP.

This document focuses on the SSE stack, which is the simplest robust choice when you only
need the server to push to the client.

---

## 2. The three pieces at a glance

| Component | Role | Layer |
| --- | --- | --- |
| **SSE (spec)** | The wire format: `text/event-stream` HTTP responses with `data:`/`event:`/`id:` fields | Protocol |
| **sse-starlette** | A Python library that lets FastAPI/Starlette emit SSE streams from async generators | Backend (Python) |
| **EventSource** | The browser's built-in JavaScript/TypeScript API that consumes an SSE stream | Frontend (browser) |
| **Redis Streams** | A durable, append-only log that decouples producers from consumers and survives restarts | Backend (data) |

How they fit: **FastAPI + sse-starlette** reads from a **Redis Stream** (via a consumer
group) inside an async generator and emits each entry as an SSE event. The **Next.js /
TypeScript** client opens an `EventSource` against the FastAPI endpoint and renders updates.

---

## 3. Server-Sent Events (SSE) — the protocol

SSE is defined by the [W3C/WHATWG HTML specification](https://html.spec.whatwg.org/multipage/server-sent-events.html).
It is a simple, text-based streaming protocol:

- The client opens a normal HTTP `GET` request.
- The server responds with `Content-Type: text/event-stream` and keeps the connection open.
- The server sends **events** as UTF-8 text blocks separated by a blank line.
- The connection is **one-way** (server → client) and **persistent**.
- The browser **automatically reconnects** if the connection drops, and can resume via
  `Last-Event-ID`.

### The event stream format

Each event is a set of fields. Fields are `field: value` lines; events are separated by a
blank line (`\n\n`).

```
event: notification
id: 42
data: {"message": "Deployment finished", "status": "ok"}

data: just a plain message

event: progress
data: 30
```

Supported fields:

| Field | Meaning |
| --- | --- |
| `data:` | The payload. May repeat for multi-line data; the client joins lines with `\n`. |
| `event:` | A named event type (e.g. `notification`, `progress`). If absent, the event is `message`. |
| `id:` | An event ID. The browser tracks the last ID and sends it back as `Last-Event-ID` on reconnect. |
| `retry:` | Tells the client the reconnection time (ms) to use. |
| `:` (colon) | A comment line (e.g. `: ping`) — commonly used as a keep-alive heartbeat. |

### Why SSE over WebSockets

- Built on HTTP/1.1 — passes through proxies, load balancers, and CDNs without special config.
- Native browser API with **automatic reconnection** and **resume** — no client code needed.
- Simpler, text-only, one-way. Great for notifications, feeds, logs, and AI streaming.
- Downsides: server→client only (no client→server over the same connection), text-based
  (binary must be base64-encoded), and browsers cap ~6 simultaneous `EventSource`
  connections per domain.

---

## 4. sse-starlette — the Python/FastAPI SSE server

[`sse-starlette`](https://github.com/sysid/sse-starlette) is a production-ready SSE
implementation for **Starlette** and **FastAPI**, following the W3C SSE spec. It is the
de-facto standard way to emit SSE from a FastAPI backend.

### Installation

```shell
pip install sse-starlette
# or, with uv:
uv add sse-starlette
```

### Core idea: an async generator → `EventSourceResponse`

You write an **async generator** that `yield`s events (dicts, or `ServerSentEvent` objects).
`sse-starlette` serializes each yielded item and streams it as SSE.

```python
import asyncio
from fastapi import FastAPI, Request
from sse_starlette import EventSourceResponse

app = FastAPI()

async def generate_events():
    for i in range(10):
        yield {"data": f"Event {i}"}
        await asyncio.sleep(1)

@app.get("/events")
async def events(request: Request):
    return EventSourceResponse(generate_events())
```

### Key components

**`EventSourceResponse`** — the response class that streams SSE.

**`ServerSentEvent`** — structured event creation with full field control:

```python
from sse_starlette import ServerSentEvent

event = ServerSentEvent(
    data="Custom message",
    event="notification",   # named event type
    id="msg-123",           # for resume/reconnect
    retry=5000,             # client reconnect interval (ms)
)
```

**`JSONServerSentEvent`** — convenience wrapper that JSON-serializes a Python object:

```python
from sse_starlette import JSONServerSentEvent

event = JSONServerSentEvent(data={"field": "value"})  # json.dumps under the hood
```

### Configuration options (selected)

| Parameter | Default | Description |
| --- | --- | --- |
| `content` | required | Async generator or iterable of events |
| `ping` | `15` | Ping/heartbeat interval in seconds (`0` disables) |
| `sep` | `"\r\n"` | Line separator |
| `send_timeout` | `None` | Per-send operation timeout (detect dead connections) |
| `headers` | `None` | Extra HTTP headers (e.g. `X-Accel-Buffering: no`) |
| `ping_message_factory` | `None` | Custom heartbeat message factory |
| `shutdown_event` | `None` | `anyio.Event` set on server shutdown (for graceful farewell) |
| `shutdown_grace_period` | `0` | Seconds to wait before force-cancel on shutdown |

### Custom ping / keep-alive

Proxies and CDNs close idle connections. `sse-starlette` sends periodic comment pings to
keep the connection alive. You can customize them:

```python
from sse_starlette import ServerSentEvent

def custom_ping():
    return ServerSentEvent(comment="Custom ping message")

return EventSourceResponse(
    generate_events(),
    ping=10,                          # ping every 10s
    ping_message_factory=custom_ping,
)
```

### Client disconnect detection & cleanup

Always check `request.is_disconnected()` in long loops so you stop work when the client
goes away, and handle `asyncio.CancelledError` for clean shutdown:

```python
async def monitored_stream(request: Request):
    events_sent = 0
    try:
        while events_sent < 100:
            if await request.is_disconnected():
                print(f"Client disconnected after {events_sent} events")
                break
            yield {"data": f"Event {events_sent}"}
            events_sent += 1
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        # Client disconnected or server shutting down — perform cleanup
        raise
```

> **Tip (from sse-starlette docs):** create DB sessions *inside* the generator, not in a
> dependency, and always check `is_disconnected()` or set `send_timeout` to avoid hanging
> connections.

---

## 5. The EventSource interface — the browser/TypeScript client

The [`EventSource`](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)
interface is the browser's native API for receiving server-sent events. It is available in
all modern browsers (baseline "widely available" since 2020) and even in Web Workers.

### Basic usage

```ts
const evtSource = new EventSource("/api/events");

evtSource.onmessage = (e: MessageEvent) => {
  // Fired for events without an `event:` field (or `event: message`)
  console.log("message:", e.data);
};

evtSource.onerror = (e) => {
  // The browser auto-reconnects by default; handle fatal errors here
  console.error("SSE error", e);
};
```

### Listening to named events

If the server sends `event: notice`, listen to that specific type:

```ts
const sse = new EventSource("/api/v1/sse");

sse.addEventListener("notice", (e: MessageEvent) => {
  console.log("notice:", e.data);
});

sse.addEventListener("progress", (e: MessageEvent) => {
  console.log("progress:", e.data);
});

sse.addEventListener("message", (e: MessageEvent) => {
  // catches events with no `event:` field OR `event: message`
  console.log("message:", e.data);
});
```

### Properties & methods

| Member | Description |
| --- | --- |
| `EventSource.readyState` | `0` CONNECTING, `1` OPEN, `2` CLOSED (read-only) |
| `EventSource.url` | The resolved URL (read-only) |
| `EventSource.withCredentials` | Whether cookies are sent (read-only; set in constructor) |
| `EventSource.onopen` / `onmessage` / `onerror` | Event handlers |
| `EventSource.close()` | Closes the connection and stops reconnection |

### Automatic reconnection & resume

If the connection drops, the browser **automatically reconnects**. If the server sent
`id:` fields, the browser includes the last ID in a `Last-Event-ID` request header on
reconnect, so the server can resume from where it left off.

### Important limitations of `EventSource`

1. **GET only.** `EventSource` always uses `GET` — you cannot send a request body or
   custom headers (e.g. `Authorization: Bearer`).
   - **For auth:** use a cookie (`new EventSource(url, { withCredentials: true })`) or pass
     a token via the query string.
   - **For custom headers / POST:** use the Fetch API with `response.body.getReader()` and
     parse SSE manually (libraries like `fetch-event-source` help here).
2. **One-way.** Client→server messages must use a separate `fetch`/`POST`.
3. **Browser connection cap.** Roughly 6 simultaneous `EventSource`s per domain.

### A reusable TypeScript hook (Next.js / React)

```tsx
// hooks/useSSE.ts
import { useEffect, useRef, useState } from "react";

interface UseSSEOptions {
  url: string;
  withCredentials?: boolean;
  onMessage?: (data: unknown) => void;
  eventTypes?: string[];
  parseJson?: boolean;
}

export function useSSE({ url, withCredentials, onMessage, eventTypes = [], parseJson = true }: UseSSEOptions) {
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(url, { withCredentials });
    sourceRef.current = es;
    setStatus("connecting");

    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus("closed"); // browser will auto-reconnect

    const handler = (e: MessageEvent) => {
      onMessage?.(parseJson ? JSON.parse(e.data) : e.data);
    };

    if (eventTypes.length === 0) {
      es.onmessage = handler;
    } else {
      eventTypes.forEach((type) => es.addEventListener(type, handler as EventListener));
    }

    return () => es.close(); // cleanup on unmount
  }, [url, withCredentials, onMessage, parseJson, eventTypes.join(",")]);

  return { status, close: () => sourceRef.current?.close() };
}
```

---

## 6. Redis Streams — the durable message backbone

[Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/) is an
**append-only, persistent log** data type in Redis. It is the ideal buffer between your
event **producers** (backend workers, other services) and your SSE **consumers** (the
FastAPI endpoints). Benefits:

- **Durable** — entries survive server restarts (with AOF/RDB persistence).
- **Multiple consumers** — via **consumer groups**, messages are sharded across workers
  so each message is delivered to exactly one consumer (at-least-once).
- **Replayable** — you can read historical ranges with `XRANGE`.
- **Backpressure-friendly** — `XADD` with `MAXLEN ~` caps memory.

### Core commands

| Command | Purpose |
| --- | --- |
| `XADD key * field value ...` | Append an entry. `*` = auto ID (`<ms>-<seq>`). Returns the entry ID. |
| `XLEN key` | Number of entries. |
| `XRANGE key - +` | Read a range (here: all entries). |
| `XGROUP CREATE key group <id|$> MKSTREAM` | Create a consumer group. `$` = only new messages; `0` = from start. `MKSTREAM` creates the stream if missing. |
| `XREADGROUP GROUP g consumer STREAMS key >` | Read new (never-delivered) entries for this consumer. `>` = new; an explicit ID reads this consumer's pending list. |
| `XREADGROUP ... BLOCK 5000` | Block up to 5000ms waiting for new entries. |
| `XACK key group id [id ...]` | Acknowledge processed entries (removes them from the Pending Entries List). |
| `XPENDING key group` | Inspect unacknowledged (pending) entries. |
| `XCLAIM` / `XAUTOCLAIM` | Reassign/claim abandoned pending entries from a dead consumer. |

### Example session

```text
> XADD mystream * name Sara surname OConnor
"1759892439825-0"

> XGROUP CREATE mystream mygroup $ MKSTREAM
OK

> XREADGROUP GROUP mygroup alice STREAMS mystream >
1) 1) "mystream"
   2) 1) 1) "1759892439825-0"
         2) 1) "name"
            2) "Sara"
            3) "surname"
            4) "OConnor"

> XACK mystream mygroup 1759892439825-0
(integer) 1
```

### Consumer groups in 30 seconds

- A **stream** holds the log.
- A **consumer group** tracks delivery state (the **Pending Entries List**, PEL) so that
  multiple consumers can share the work without duplicates.
- `>` reads only entries never delivered to *any* consumer in the group; an explicit ID
  reads *this consumer's* pending (unacknowledged) entries — useful for crash recovery.
- `XACK` removes entries from the PEL once successfully processed → **at-least-once**
  delivery, with retry via `XAUTOCLAIM`.

---

## 7. Putting it all together: architecture

```
┌─────────────┐      XADD       ┌──────────────┐    XREADGROUP    ┌──────────────────┐
│  Producer   │ ──────────────▶ │  Redis Stream│ ◀──────────────  │  FastAPI worker  │
│ (backend/   │                 │  (durable    │                  │  (consumer group)│
│  other svc) │                 │   log)       │                  └────────┬─────────┘
└─────────────┘                 └──────────────┘                           │ EventSourceResponse
                                                                          │ (async generator)
                                                                          ▼
                                                                  ┌──────────────────┐
                                                                  │  text/event-stream│
                                                                  └────────┬─────────┘
                                                                           │ HTTP SSE
                                                                           ▼
                                                                  ┌──────────────────┐
                                                                  │  Next.js client  │
                                                                  │  (EventSource)   │
                                                                  └──────────────────┘
```

Why Redis Streams in the middle?

- The FastAPI SSE endpoint can read from the stream with `BLOCK`, so it only sends data
  when there is new data (no polling, no busy loop).
- If the SSE client disconnects and reconnects, the consumer group's PEL + `Last-Event-ID`
  let you resume without missing or duplicating messages.
- Multiple FastAPI instances / workers can share one stream via the consumer group.
- Producers don't need to know about connected clients — they just `XADD`.

---

## 8. Backend: FastAPI + sse-starlette + Redis Streams

Using the **async** `redis` client (`redis.asyncio`), we read from a stream inside an
async generator and emit each entry as an SSE event. We also support resume via
`Last-Event-ID`.

### `requirements.txt`

```text
fastapi
uvicorn[standard]
sse-starlette
redis
```

### `main.py`

```python
import asyncio
import json
from fastapi import FastAPI, Request, Header
from fastapi.responses import JSONResponse
from sse_starlette import EventSourceResponse, JSONServerSentEvent
import redis.asyncio as aioredis

app = FastAPI()

REDIS_URL = "redis://localhost:6379"
STREAM = "notifications"
GROUP = "sse-clients"

# Ensure the consumer group exists at startup
@app.on_event("startup")
async def startup():
    r = aioredis.from_url(REDIS_URL, decode_responses=True)
    try:
        await r.xgroup_create(STREAM, GROUP, id="0", mkstream=True)
    except Exception:
        pass  # group already exists
    app.state.redis = r

@app.on_event("shutdown")
async def shutdown():
    await app.state.redis.aclose()

# Producer endpoint (stand-in for your real event source)
@app.post("/notify")
async def notify(payload: dict):
    await app.state.redis.xadd(STREAM, {"data": json.dumps(payload)})
    return JSONResponse({"ok": True})

@app.get("/stream")
async def stream(request: Request, last_event_id: str | None = Header(default=None)):
    redis = app.state.redis

    # A unique consumer name per connection
    consumer = f"consumer-{id(request)}"

    async def event_generator():
        # Start reading from the beginning of the pending list (resume)
        # or from "now" if no Last-Event-ID
        start_id = last_event_id or ">"
        if start_id != ">":
            start_id = "0"  # re-read this consumer's pending entries

        last_id = start_id
        while True:
            if await request.is_disconnected():
                break

            # BLOCK for new messages; '>' = never-delivered to this group
            resp = await redis.xreadgroup(
                GROUP, consumer, {STREAM: last_id}, count=10, block=5000
            )
            if not resp:
                continue  # heartbeat/timeout; loop again

            for _stream, messages in resp:
                for msg_id, fields in messages:
                    data = fields.get("data", "")
                    yield JSONServerSentEvent(data=json.loads(data), id=msg_id)
                    last_id = msg_id
                    # Acknowledge so it leaves the pending list
                    await redis.xack(STREAM, GROUP, msg_id)

    return EventSourceResponse(
        event_generator(),
        ping=15,
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )
```

Key points:

- `xreadgroup(..., block=5000)` makes the generator **wait efficiently** for new data.
- Each emitted event includes `id=msg_id`, so the browser sends `Last-Event-ID` on
  reconnect and we can resume from the consumer's pending entries.
- `XACK` after successful send removes the entry from the PEL (prevents redelivery loops).
- `request.is_disconnected()` ends the loop when the client leaves.
- `X-Accel-Buffering: no` tells Nginx not to buffer the stream.

---

## 9. Frontend: Next.js + TypeScript with EventSource

In Next.js App Router, the SSE client must run in a **client component** (`'use client'`),
because `EventSource` is a browser API.

### `app/components/LiveFeed.tsx`

```tsx
"use client";

import { useEffect, useRef, useState } from "react";

interface Notification {
  id: string;
  message: string;
}

export default function LiveFeed() {
  const [items, setItems] = useState<Notification[]>([]);
  const [status, setStatus] = useState<string>("connecting");

  useEffect(() => {
    const token = "<JWT-or-session-token>"; // auth via query string (EventSource = GET only)
    const es = new EventSource(`/api/stream?token=${token}`);

    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus("reconnecting"); // browser auto-reconnects

    es.onmessage = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as Notification;
      setItems((prev) => [data, ...prev].slice(0, 50));
    };

    // named events example:
    // es.addEventListener("progress", (e) => { ... });

    return () => es.close(); // always close on unmount
  }, []);

  return (
    <div>
      <p>Status: {status}</p>
      <ul>
        {items.map((it) => (
          <li key={it.id}>{it.message}</li>
        ))}
      </ul>
    </div>
  );
}
```

### Optional: a Next.js Route Handler proxy

If you want to keep auth/cookies server-side and avoid CORS, you can expose the SSE route
through Next.js and proxy to FastAPI. Set `export const dynamic = "force-dynamic"` so the
route is never statically cached:

```ts
// app/api/stream/route.ts
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = req.headers.get("cookie"); // or read session
  const upstream = await fetch(`http://localhost:8000/stream`, {
    headers: { cookie: token ?? "" },
  });
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

> **Note:** For the proxy approach, the browser still uses `EventSource` against your
> Next.js route; Next.js forwards the stream to FastAPI. This also lets you attach cookies
> server-side, avoiding token-in-URL concerns.

---

## 10. Production considerations

### Proxy / CDN buffering (critical)

Reverse proxies and CDNs **buffer** responses, which delays or breaks SSE. Fix it:

- **Nginx:** add `proxy_buffering off;` and/or send the `X-Accel-Buffering: no` header
  from your app (sse-starlette supports `headers={"X-Accel-Buffering": "no"}`).
- **Cloudflare/Akamai:** these buffer by default; for true real-time you may need to
  disable proxying for the SSE route or use a non-proxied subdomain.
- **HAProxy:** ensure timeouts exceed your ping interval.

### Authentication

`EventSource` only does `GET` with no custom headers. Auth options:

1. **Cookies** — `new EventSource(url, { withCredentials: true })` + `SameSite=None; Secure`
   cookie. Cleanest for same-origin/browser auth.
2. **Query string token** — `new EventSource(\`/stream?token=...\`)` (avoid secrets in logs).
3. **Custom fetch client** — use `fetch()` + `ReadableStream` reader + manual SSE parsing
   if you need `Authorization` headers (e.g. the `fetch-event-source` library).

### Scaling & resilience

- **Redis persistence:** enable AOF (`appendonly yes`, `appendfsync everysec`) so stream
  entries survive restarts.
- **Consumer groups:** run multiple FastAPI workers/instances sharing one group for
  horizontal scale and crash recovery.
- **Dead-letter pattern:** route entries that exceed a delivery-count threshold to a
  `<stream>:dlq` stream for inspection.
- **Cap stream size:** `XADD ... MAXLEN ~ 1000000` to bound memory.
- **Pending Entries List hygiene:** run a recovery job with `XAUTOCLAIM` to reclaim
  entries from dead consumers.
- **Graceful shutdown:** use sse-starlette's `shutdown_event` / `shutdown_grace_period`
  so in-flight streams finish or send a farewell.

### Testing

- sse-starlette provides an `EventSourceResponse` that works with FastAPI's `TestClient`.
- Mock `EventSource` in frontend tests to simulate `onmessage` / `onerror`.

---

## 11. When to choose SSE vs WebSockets

| Need | SSE | WebSockets |
| --- | --- | --- |
| Server → client only | ✅ ideal | ⚙️ possible but heavier |
| Bidirectional (chat, games) | ❌ | ✅ |
| Binary data | ⚠️ base64 only | ✅ native |
| Auto-reconnect + resume | ✅ built-in | ❌ manual |
| Passes through HTTP infra | ✅ | ⚠️ needs WS-aware proxy |
| Client libraries | ✅ none (native) | library needed |

**Choose SSE + sse-starlette + Redis Streams** when you need reliable, resumable,
server-to-client real-time updates (notifications, feeds, logs, progress, AI streaming)
without the operational complexity of WebSockets.

---

## References

- sse-starlette: https://github.com/sysid/sse-starlette · PyPI: https://pypi.org/project/sse-starlette
- FastAPI SSE docs: https://fastapi.tiangolo.com/tutorial/server-sent-events/
- MDN EventSource: https://developer.mozilla.org/en-US/docs/Web/API/EventSource
- MDN Using SSE: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- Redis Streams: https://redis.io/docs/latest/develop/data-types/streams/
- Redis XREADGROUP: https://redis.io/docs/latest/commands/xreadgroup/
- WHATWG SSE spec: https://html.spec.whatwg.org/multipage/server-sent-events.html
