# PayFlow

A mini payments and wallet platform built with Node.js, PostgreSQL, Redis and BullMQ. Users hold wallet balances and send money to each other, merchants receive payments and get notified through signed webhooks, and anyone can export their full transaction history as a compressed CSV.

This is a learning project focused on senior-level backend concerns: correctness under concurrency, idempotency, background processing, streaming large datasets, and production observability.

## Features

- **Wallets and transfers** backed by a double-entry ledger, so money is never created or lost.
- **Idempotent payments** using an `Idempotency-Key` header, so a retried request never charges twice.
- **Concurrency-safe balances** using row-level locking, tested with 100 simultaneous transfers.
- **Risk scoring** for every transfer, computed in a worker thread pool so the API never blocks.
- **Webhook delivery** through a BullMQ queue with HMAC signatures, exponential backoff and a dead letter queue.
- **Statement export** that streams millions of rows from Postgres to a gzipped CSV in constant memory.
- **Caching and rate limiting** with Redis.
- **Request tracing** with a `traceId` on every log line, carried from the HTTP request into background jobs.
- **Graceful shutdown** that finishes in-flight work before exiting.

## Tech stack

| Concern | Tool |
| --- | --- |
| Runtime and HTTP | Node.js 20+, Express, TypeScript |
| Database | PostgreSQL 16 |
| ORM and migrations | Drizzle ORM, drizzle-kit |
| Cache, rate limiting, locks | Redis 7, ioredis |
| Background jobs | BullMQ |
| CPU-heavy work | Worker threads (piscina) |
| Validation | zod |
| Logging | Pino with AsyncLocalStorage context |
| Security | Helmet, CORS allow-list, JWT with rotating refresh tokens |
| Load testing | autocannon |
| Local infrastructure | Docker Compose |

## Architecture

```mermaid
flowchart LR
    C[Client] --> API[Express API]
    API -->|risk score| WP[Worker thread pool]
    API -->|transactions| PG[(PostgreSQL)]
    API -->|cache, rate limit, idempotency| R[(Redis)]
    API -->|enqueue event| Q[BullMQ queue]
    Q --> W[Webhook worker]
    W -->|signed POST| M[Merchant server]
    W -->|log attempts| PG
    Q -->|after 5 failures| DLQ[Dead letter queue]
```

The API process handles requests and never does slow or unreliable work inline. CPU-heavy risk scoring goes to a worker thread pool, and webhook delivery goes to a separate worker process through BullMQ, so a slow or failing merchant server never affects payment latency.

## Getting started

### Prerequisites

- Node.js 20 or newer
- Docker and Docker Compose

### Setup

```bash
git clone https://github.com/<your-username>/payflow.git
cd payflow
npm install
cp .env.example .env
docker compose up -d        # starts Postgres and Redis
npm run db:migrate          # applies the schema
npm run db:seed             # optional: seeds test users, merchants and transactions
```

### Running

```bash
npm run dev                 # API on http://localhost:3000
npm run worker              # webhook delivery worker (separate terminal)
npm run fake-merchant       # test merchant server that fails 50% of requests
```

Check everything is up with `curl http://localhost:3000/health`.

## Environment variables

| Variable | Description | Example |
| --- | --- | --- |
| `NODE_ENV` | `development`, `test` or `production` | `development` |
| `PORT` | API port | `3000` |
| `DATABASE_URL` | Postgres connection string | `postgres://payflow:payflow@localhost:5432/payflow` |
| `DB_POOL_SIZE` | Max Postgres connections per process | `10` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `JWT_ACCESS_SECRET` | Secret for access tokens | any long random string |
| `JWT_REFRESH_SECRET` | Secret for refresh tokens | any long random string |
| `WEBHOOK_SIGNING_SECRET` | Default HMAC secret for webhooks | any long random string |
| `RATE_LIMIT_TRANSFERS_PER_MIN` | Transfer rate limit per user | `10` |
| `LOG_LEVEL` | Pino log level | `info` |

## Project structure

```
payflow/
├── src/
│   ├── app.ts                 # Express app, middleware wiring
│   ├── server.ts              # HTTP server, graceful shutdown
│   ├── config/                # env parsing and validation
│   ├── db/
│   │   ├── schema.ts          # Drizzle schema
│   │   ├── migrations/
│   │   └── client.ts          # connection pool
│   ├── modules/
│   │   ├── auth/
│   │   ├── wallets/
│   │   ├── transfers/
│   │   ├── merchants/
│   │   ├── statements/        # streaming CSV export
│   │   └── admin/             # reporting queries
│   ├── lib/
│   │   ├── cache.ts           # cache-aside helper
│   │   ├── rateLimiter.ts
│   │   ├── idempotency.ts
│   │   ├── context.ts         # AsyncLocalStorage traceId
│   │   └── logger.ts
│   └── queues/
│       └── webhooks.ts        # queue definition and producer
├── workers/
│   ├── webhookWorker.ts       # BullMQ consumer
│   └── riskScore.worker.ts    # worker thread task
├── scripts/
│   ├── seed.ts
│   ├── loop-order.js          # event loop experiments
│   ├── fake-merchant.ts
│   └── race-test.ts           # concurrency acceptance test
├── postman/                   # Postman collection + local environment (import both)
├── docker-compose.yml
└── .env.example
```

## API overview

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/auth/register` | Create a user and wallet |
| `POST` | `/auth/login` | Get an access token and refresh cookie |
| `POST` | `/auth/refresh` | Rotate the refresh token |
| `GET` | `/wallets/me` | Current balance (cached) |
| `POST` | `/wallets/me/topup` | Add test funds |
| `POST` | `/transfers` | Send money (requires `Idempotency-Key`, rate limited) |
| `GET` | `/transactions` | Paginated transaction history |
| `GET` | `/statements/export` | Stream full history as `.csv.gz` |
| `POST` | `/merchants` | Register a merchant and webhook URL |
| `GET` | `/merchants/:id/payments` | Payments received, with customer details |
| `GET` | `/merchants/:id/webhooks` | Webhook delivery attempts and status |
| `GET` | `/admin/reports/daily-volume` | Daily transaction volume |
| `GET` | `/admin/reports/top-merchants` | Merchants ranked by volume |
| `GET` | `/health` | Liveness: process is up (no dependency checks) |
| `GET` | `/health/ready` | Readiness: dependencies reachable; 503 while down or shutting down |

### Example transfer

```bash
curl -X POST http://localhost:3000/transfers \
  -H "Authorization: Bearer <access-token>" \
  -H "Idempotency-Key: 6f1c2a9e-0b7d-4f43-9a51-3c2d8e7f1a20" \
  -H "Content-Type: application/json" \
  -d '{"toWalletId": "wal_123", "amount": 2500, "currency": "USD"}'
```

Amounts are stored as integers in minor units (cents) to avoid floating-point errors.

## Key design decisions

**Double-entry ledger.** Every transfer writes two rows to `ledger_entries`, a debit and a credit, inside one database transaction. The sum of all entries is always zero, which makes balances auditable and bugs easy to detect.

**Preventing double-spending.** Concurrent transfers from the same wallet lock the wallet row with `SELECT ... FOR UPDATE` before checking the balance. An optimistic version using a `version` column is also implemented for comparison; see `docs/locking.md` for the tradeoffs.

**Idempotency.** The response to each `Idempotency-Key` is stored in Redis for 24 hours. A retried request with the same key returns the stored response instead of running the transfer again.

**Asynchronous webhooks.** The transfer handler only enqueues a job and returns. The worker signs each payload with HMAC-SHA256 in an `X-PayFlow-Signature` header, retries with exponential backoff, and moves jobs to a dead letter queue after 5 failures. Each event has a unique ID so merchants can safely ignore duplicates.

**Constant-memory exports.** Statements are read with a Postgres cursor and piped through a CSV transform and gzip using `stream/promises` pipeline, which handles backpressure and cleans up the cursor if the client disconnects.

**Non-blocking risk scoring.** Scoring runs in a piscina worker pool, keeping event-loop lag low under load.

## Event loop notes

Where each callback in the current code runs. Node's loop goes through these phases in order: **timers → pending callbacks → poll → check → close callbacks**. After every callback, Node runs the `process.nextTick` queue and then the promise microtask queue, before moving on to the next callback or phase.

| Callback | Where it runs | Why |
| --- | --- | --- |
| Top-level code in `server.ts` (config parsing, `createApp()`, `startEventLoopMonitor()`, `app.listen()`) | Before the loop starts | The main module runs synchronously to completion before libuv starts turning the loop. |
| `app.listen(...)` callback | `nextTick` queue, before the first loop iteration | Binding the port is synchronous, but `net.Server` emits `'listening'` with `process.nextTick`. The callback therefore runs right after the main script finishes, before any timer or I/O. |
| Route handlers (`/health`, 404) and pino-http's `genReqId` | Poll phase | An incoming request is socket I/O. libuv reports readable data in the poll phase, the HTTP parser runs on it, and Express calls the middleware chain synchronously inside that callback. |
| Error handler | Poll phase, or the microtask queue | A synchronous `throw` is caught in the same poll-phase call. For an `async` handler that rejects, Express 5 calls `next(err)` from a promise reaction, so the error handler runs in the microtask queue right after it. |
| pino-http's `customLogLevel` (request-completed log) | `nextTick` queue, after the handler | It runs on the response's `'finish'` event. A small response is usually written to the socket synchronously, and Node defers the write-completion callback (and so `'finish'`) with `process.nextTick`. It runs in the same poll-phase turn, just after the handler returns. A large or backpressured response finishes in a later poll phase instead. |
| Event-loop monitor `setInterval` callback | Timers phase | `setInterval` callbacks always run in the timers phase once their delay has elapsed. They can run later than 10 s if earlier phases are busy, but never earlier. |
| `monitorEventLoopDelay` sampling | No JS callback | The histogram is fed by a native libuv timer, so sampling adds no JavaScript work. |
| `SIGINT` / `SIGTERM` handlers (`shutdown`) | Poll phase | libuv turns a signal into a write on an internal pipe, which is read during the poll phase like any other I/O. |
| `server.close(...)` callback | `nextTick` queue, or close-callbacks phase | It runs on the server's `'close'` event, which waits until every connection has closed. With no open connections, `'close'` is emitted with `process.nextTick` right after the signal handler. With keep-alive sockets still open, it fires after the last socket's handle closes, which happens in the close-callbacks phase. |
| Shutdown fallback `setTimeout` (10 s) | Timers phase | Same as any timer. It is `unref`'d, so it only fires if something else is still keeping the process alive. |
| `unhandledRejection` handler | After the microtask queue drains, in whatever phase the rejection happened | Node checks for unhandled rejections when it finishes processing the tick and microtask queues, so this handler has no phase of its own. |
| Pino log writes in development (`pino-pretty`) | Off the main loop | The transport runs in a worker thread. The main thread only copies the log line into a shared buffer, so formatting doesn't add event-loop lag. |

## Testing

```bash
npm test                    # unit and integration tests
npm run test:race           # 100 concurrent transfers against one wallet
npm run loadtest            # autocannon against /transfers
npm run test:api            # Postman collection via newman (server must be running)
```

The project is considered complete when these acceptance tests pass:

- [ ] 100 concurrent transfers from a wallet with balance 50 result in exactly 50 successes, and the ledger sums to zero.
- [ ] Retrying a request with the same `Idempotency-Key` produces exactly one charge.
- [ ] Killing the webhook worker mid-job still results in delivery after restart.
- [ ] Exporting 10 million rows keeps RSS memory under 50MB.
- [ ] API latency stays stable while risk scoring runs under load.

## Benchmarks

Fill these in as you measure them.

| Scenario | Before | After |
| --- | --- | --- |
| p99 latency with risk scoring on main thread vs worker pool | | |
| `EXPLAIN ANALYZE` time for wallet history, without vs with composite index | | |
| Query count for merchant payments, N+1 vs eager loading | | |
| Peak RSS during 10M-row export | | |

## Roadmap

- [ ] Scheduled merchant payouts protected by a Redlock distributed lock
- [ ] Transactional outbox so events survive a Redis outage
- [ ] Prometheus metrics and a Grafana dashboard
- [ ] Read replica for admin reports
- [ ] Minimal frontend for wallet, merchant and admin views

## License

MIT