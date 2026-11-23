# DiffProve — Differential PR Verifier

A GitHub App that validates AI-authored (and human) pull requests using **differential
verification**: a PR's new/modified tests are executed in an isolated sandbox against both the
**reverted base commit** (they must fail there) and the **patched head commit** (they must pass
there). Weak, tautological, or hallucinated tests are caught before human review.

See [docs/architecture.md](docs/architecture.md) for the full system design and
[PLAN.md](PLAN.md) for the current execution plan.

## Build phases

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | GitHub App & webhook ingestion (HMAC verification, `queued` check runs, BullMQ queue) | complete |
| 2 | Diff splitter (test-only vs full patches) | pending |
| 3 | E2B differential sandbox runner (Run A / Run B) | pending |
| 4 | Verdict reporting & dashboard | pending |

## Development

```bash
npm install          # install dependencies
npm test             # run the unit test suite (no Redis required)
npm run typecheck    # strict TypeScript check
npm run lint         # eslint
npm run dev          # start the webhook server locally (needs .env, see below)
```

Local dependencies (optional, for live BullMQ integration tests and dev runs):

```bash
docker compose up -d redis
```

Configuration is loaded from environment variables (`.env` supported) — copy `.env.example`
to `.env`, and follow [docs/app-setup.md](docs/app-setup.md) to register the GitHub App itself
(App ID, private key, webhook secret, and a local smoke test).
