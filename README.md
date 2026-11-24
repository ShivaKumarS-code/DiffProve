# DiffProve — Differential PR Verifier

A GitHub App that validates AI-authored (and human) pull requests using **differential
verification**: a PR's new/modified tests are executed in an isolated sandbox against both the
**reverted base commit** (they must fail there) and the **patched head commit** (they must pass
there). Weak, tautological, or hallucinated tests are caught before human review.

## How it works

1. **Webhook intake** — verifies GitHub's `X-Hub-Signature-256` HMAC, posts a `queued` check run
   on the PR head, and enqueues a durable BullMQ job (deduplicated per repo/PR/head-sha).
2. **Diff split** — fetches the sha-pinned PR diff and splits it into a **Test-Only Patch** and
   the **Full PR Patch** using test-file globs. PRs that change no tests complete immediately
   with a `neutral` *"No test changes detected to verify"* check run.
3. **Sandbox** — an E2B Firecracker microVM: the base tree is downloaded on the trusted side
   (no GitHub token ever enters the sandbox), dependencies are installed, then outbound network
   egress is **disabled** before any untrusted code runs.
4. **Run A / Run B** — the targeted test command runs against base + Test-Only Patch
   (expected to fail) and against head + Full PR Patch (expected to pass).

   | Run A (base + new tests) | Run B (head + new tests) | Verdict | Check conclusion |
   | :--- | :--- | :--- | :--- |
   | FAIL | PASS | Verified fix / valid test | `success` |
   | PASS | PASS | Weak / non-reproducing test | `failure` |
   | FAIL | FAIL | Broken implementation | `failure` |
   | SYNTAX / IMPORT ERROR | PASS | New symbol test (annotated) | `neutral` |
   | ERROR / TIMEOUT | ANY | Sandbox / environment failure | `neutral` |

5. **Reporting & history** — the check run is completed with a rich Markdown summary (verdict,
   the fired matrix row, clipped Run A / Run B log excerpts), and every run is persisted to
   PostgreSQL. Repositories can override the auto-detected test command and globs, and can be
   disabled entirely.

## Components

| Component | Location | Stack |
|-----------|----------|-------|
| Webhook server, worker pipeline, JSON API | repo root (`src/`) | TypeScript, Fastify, BullMQ, Octokit |
| E2B sandbox runner + diff splitter | `src/runner/`, `src/diff/` | `e2b` SDK, pure diff parsing |
| Run history DB | PostgreSQL (migrations in `src/db/`) | `pg` |
| Verification dashboard | `apps/web` (npm workspace) | Next.js, Tailwind CSS |

The dashboard calls the service's `GET /api/repos`, `GET /api/repos/:id/runs`, and
`PATCH /api/repos/:id/config` endpoints through a same-origin proxy (see
`apps/web/.env.example`) — repo onboarding, run history with logs, weak-test catch rate, and
per-repo test config.

## Development

```bash
npm install            # install dependencies (root + apps/web workspace)
docker compose up -d   # optional: Redis + PostgreSQL for live runs and integration tests
cp .env.example .env   # then fill in the GitHub App credentials (see below)
```

Configuration is loaded from environment variables (`.env` supported) — see `.env.example` for
every variable, and [docs/app-setup.md](docs/app-setup.md) to register the GitHub App itself
(App ID, private key, webhook secret, and a local signed smoke test).

```bash
npm run dev        # Fastify webhook + worker server (needs .env)
npm run dev:web    # Next.js dashboard on its own port
npm test           # unit suite; Redis/Postgres integration tests skip unless configured
npm run typecheck  # strict TypeScript check
npm run lint       # eslint
npm run build      # compile the service
npm run build:web  # production build of the dashboard
```

Without `E2B_API_KEY` the sandbox stage is skipped (jobs stay queued with a warning); without
`DATABASE_URL` the API answers 503 and runs are not persisted; without Redis the webhook
server cannot enqueue jobs. Everything degrades gracefully and logs what it needs.

## Documentation

- [docs/architecture.md](docs/architecture.md) — full system design, data model, and decisions.
- [docs/app-setup.md](docs/app-setup.md) — registering and smoke-testing the GitHub App.
- [PLAN.md](PLAN.md) — the execution plan for the current phase.
