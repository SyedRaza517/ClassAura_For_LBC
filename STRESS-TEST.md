# Staff Hub — Load Data & Stress Test

Two helper scripts in `scripts/`:

| Script | What it does |
|---|---|
| `node scripts/seed-100.mjs [count]` | Logs in as admin and creates `count` (default 100) staff via the real `POST /api/staff` endpoint — exercises auth, validation, bcrypt, and DB writes. Emails are unique (`loadtest.<n>...`) so re-runs don't collide. |
| `node scripts/stress-test.mjs [concurrency] [seconds]` | Closed-loop load test: N concurrent workers hit a weighted read-heavy mix (staff/leave/checkins/health + occasional login) and report throughput, latency percentiles, and error rate. |
| `node scripts/cleanup-loadtest.mjs [--dry-run]` | Removes only the load-test staff (`loadtest.*@edtech.co.uk`), leaving the 6 original accounts intact. Use `--dry-run` to preview first. |

Prereq: API running on `http://localhost:4000` (`npm run dev`).

## Data load

`seed-100.mjs 100` → **100 staff created, 0 failures** in ~14s.
Database went from 6 → **106 staff** (persisted in `server/prisma/dev.db`).

> ~14s for 100 inserts is dominated by **bcrypt password hashing** (cost factor 10, synchronous) on each create.

## Stress test results

Run on the running dev server (SQLite, single Node process).

| Load | Throughput | Errors | p50 | p90 | p99 | max |
|---|---|---|---|---|---|---|
| 50 workers / 15s | 103 req/s | 0.00% | 408 ms | 964 ms | 1113 ms | 1128 ms |
| 150 workers / 15s | 111 req/s | 0.00% | 1224 ms | 1976 ms | 3069 ms | 3101 ms |

### Findings

1. **Throughput ceiling ≈ 110 req/s.** Tripling concurrency (50→150) did **not** raise throughput — it only tripled latency. Classic saturation: extra load just queues.
2. **Zero errors under load.** No 5xx, no dropped connections, no crash. The server degrades gracefully (slower), it doesn't fail.
3. **Bottleneck is the single Node event loop, not the DB per se.** Even `GET /health` (no DB, no auth) hit p99 2.1s at 150 workers. The two synchronous hot spots:
   - `bcrypt.compareSync` on every login and `bcrypt.hashSync` on every create — these block the event loop thread for ~80 ms each.
   - Every authenticated request runs a `prisma.staff.findUnique` in `requireAuth`, and SQLite serializes writes/reads through one connection.

### Recommended next steps (if higher throughput is needed)

- Use the **async** bcrypt APIs (`bcrypt.hash` / `bcrypt.compare`) so hashing doesn't block the event loop.
- Run multiple Node workers (Node `cluster` / PM2) behind a load balancer.
- For real concurrency, switch Prisma `provider` to **PostgreSQL** (the schema already supports a one-line swap — see README).
- Add login rate-limiting (also a security recommendation in the README).
