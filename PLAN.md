# Render Deployment Preparation Plan

Scope source: `docs/architecture.md`, headings **"Component Architecture & Stack"** (`GitHub App Server`, `Job Orchestrator`, `Run History DB`, `Web Dashboard`), **"API & Interface Contracts"**, and **"Key Engineering Guardrails"** (#2: secrets never logged or exposed).

## Goal

Prepare the repository for one-click Blueprint deployment on Render (`diffprove-api` + `diffprove-web` + managed PostgreSQL + managed Key Value/Redis) as Step 1 of the guided deployment, then commit and push `main` so Render can deploy directly from GitHub.

## Design Decisions

- **Runtime `/api/[...path]` proxy in `apps/web`:** `next.config.mjs` `rewrites()` evaluates `API_PROXY_URL` at `next build` time, which risks baking `localhost:3000` when Render's internal `hostport` is injected at runtime. Replacing the static rewrite with an App Router route handler (`apps/web/src/app/api/[...path]/route.ts`, `dynamic = 'force-dynamic'`) resolves `API_PROXY_URL` or `http://${API_PROXY_HOSTPORT}` on every request, preserves `Cookie` and multiple `Set-Cookie` headers, and forwards `302` redirects (`redirect: 'manual'`) for `/api/auth/login` and `/api/auth/callback`.
- **`render.yaml` Blueprint:** Provisions `diffprove-db` (PostgreSQL), `diffprove-redis` (`type: keyvalue`, `maxmemoryPolicy: noeviction` for BullMQ), `diffprove-api` (`npm ci && npm run build` / `npm start`, `healthCheckPath: /healthz`), and `diffprove-web` (`npm ci && npm run build:web` / `npm run start -w apps/web`), wiring `REDIS_URL`, `DATABASE_URL`, `SESSION_SECRET`, and `API_PROXY_HOSTPORT` automatically while keeping secrets (`GITHUB_*`, `E2B_API_KEY`, `PUBLIC_URL`) `sync: false`.
- **Node 24 parity:** `.node-version` (`24`) matches `.github/workflows/ci.yml`.

## Pieces (disjoint files, parallel)

| # | Piece | Files owned | Architecture headings touched |
|---|-------|-------------|-------------------------------|
| 1 | Runtime `/api/[...path]` proxy in `apps/web` | `apps/web/src/app/api/[...path]/route.ts`, `apps/web/next.config.mjs` | Component Architecture & Stack (`Web Dashboard`) |
| 2 | Render Blueprint, Node version, and step-by-step deploy guide | `render.yaml`, `.node-version`, `docs/deploy-render.md` | Component Architecture & Stack, Guardrail #2 |

## Verification

- Orchestrator inspects every diff, runs `npm run typecheck`, `npm run lint`, `npm run build`, `.\apps\web\node_modules\.bin\tsc --noEmit -p apps/web/tsconfig.json`, `npm test`, and `npm run build:web`, then commits and pushes `main`.
