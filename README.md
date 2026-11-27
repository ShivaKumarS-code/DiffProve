# DiffProve — Differential PR Verifier

A GitHub App that validates AI-authored (and human) pull requests using **differential
verification**: a PR's new or modified tests should fail on the **merge base plus the test-only
patch** and pass on the **exact PR head**. The two runs use independent sandboxes.

## How it works

1. **Webhook intake** — verifies GitHub's `X-Hub-Signature-256` HMAC and accepts a PR event after
   it is durably enqueued in BullMQ. Once a worker claims the job, it creates or recovers the
   check on the PR head using a stable `external_id`, records the check ID in the job, and
   updates that exact check. Recovery and terminal delivery depend on GitHub and Redis.
2. **Diff split** — obtains GitHub's SHA-pinned three-dot comparison, selects test changes
   using configured globs, and fetches source archives on the trusted host. No GitHub token or
   app secret is passed to either sandbox.
3. **Run A / Run B** — Run A installs dependencies on the untouched merge base with outbound
   access restricted to approved registries, closes egress, and applies only the test patch.
   Run B uses the exact PR head archive in a separate E2B Firecracker microVM that is offline
   from boot, including dependency setup. Only trusted pre-test base snapshots may seed the
   dependency cache; a cold cache or dependencies unavailable offline can make Run B fail
   before it runs any tests. Neither sandbox exposes public ports.

   | Run A (merge base + test patch) | Run B (exact PR head) | Verdict | Check conclusion |
   | :--- | :--- | :--- | :--- |
   | FAIL | PASS | Verified fix / valid test, unless case evidence is mixed | `success` |
   | FAIL | PASS | Mixed test evidence (some cases fail/pass and others pass/pass) | `failure` |
   | PASS | PASS | Weak / non-reproducing test | `failure` |
   | FAIL | FAIL | Broken implementation | `failure` |
   | SYNTAX / IMPORT ERROR | PASS | New symbol test (annotated) | `neutral` |
   | ERROR / TIMEOUT in either run | | Sandbox / environment failure | `neutral` |

4. **Reporting & history** — the worker completes the check with a Markdown verdict, clipped
   logs and optional evidence from cases executed in the targeted changed test files, not an
   inventory of every edited case. Missing, ambiguous or skipped results are not pass/fail
   evidence; custom commands may have no collector. No-test, disabled and unavailable-runner
   paths report neutral. After verification exhausts its retries, an independent BullMQ job
   retries neutral check delivery. Redis and GitHub updates are not atomic, so delivery is
   not guaranteed. Completed comparisons are saved when PostgreSQL is configured.

## Components

| Component | Location | Stack |
|-----------|----------|-------|
| Webhook server, worker pipeline, JSON API | repo root (`src/`) | TypeScript, Fastify, BullMQ, Octokit |
| E2B sandbox runner + diff splitter | `src/runner/`, `src/diff/` | `e2b` SDK, pure diff parsing |
| Run history DB | PostgreSQL (migrations in `src/db/`) | `pg` |
| Verification dashboard | `apps/web` (npm workspace) | Next.js, Tailwind CSS |

The dashboard calls the service's `GET /api/repos`, `GET /api/repos/:id/runs`, and
`PATCH /api/repos/:id/config` endpoints through a same-origin proxy (see
`apps/web/.env.example`) — repo onboarding, run history with logs and case evidence, and
per-repo test config. The catch rate is `weak-test` runs divided by all recorded runs;
`mixed-test` is shown separately and does not contribute to the numerator.

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

Without `E2B_API_KEY` there is no sandbox run; the worker completes an unavailable check when
delivery is possible. Without `DATABASE_URL` the history API answers 503 and runs are not
persisted. Without Redis the webhook server cannot durably accept PR jobs.

## Documentation

- [docs/architecture.md](docs/architecture.md) — full system design, data model, and decisions.
- [docs/app-setup.md](docs/app-setup.md) — registering and smoke-testing the GitHub App.
- [docs/deploy-render.md](docs/deploy-render.md) — deployment and live weak, valid and mixed PR smoke tests.
- [PLAN.md](PLAN.md) — the execution plan for the current phase.
