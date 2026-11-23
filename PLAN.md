# Phase 1 Execution Plan — GitHub App & Webhook Ingestion

Scope source: `docs/architecture.md`, heading **"MVP Build Phases"**, Phase 1 line:

> **Phase 1 (GitHub App & Webhook Ingestion):** Register GitHub App, verify webhook signatures, post `queued` Check Runs, and enqueue jobs via BullMQ/Inngest.

Also touches these parts of `docs/architecture.md`:
- Heading **"End-to-End Verification Pipeline"** — step 1 (webhook intake: HMAC `X-Hub-Signature-256`, `queued` Check Run, enqueue).
- Heading **"Component Architecture & Stack"** — rows `GitHub App Server` and `Job Orchestrator`.
- Heading **"API & Interface Contracts"** — `POST /webhooks/github` and the Check Runs API bullet.
- Heading **"Key Engineering Guardrails"** — #2 (never leak/inject secrets; no secret logging).
- **NOT touched in Phase 1:** `Core Data Model` (PostgreSQL lands with a later phase), diff splitting (Phase 2), E2B runs (Phase 3), dashboard (Phase 4).

## Stack decision

Node 24 + TypeScript (ESM, `module: NodeNext` — relative imports use explicit `.js` suffixes), **Fastify** (webhook server), **@octokit/core + @octokit/auth-app** (App JWT → installation tokens → Check Runs), **BullMQ + ioredis** (durable queue), **zod** (env/payload validation), **vitest** (tests). Redis is optional at test time: BullMQ integration tests use `describe.skipIf(!process.env.REDIS_URL)` so the suite passes on machines without Redis.

## Pieces (one subagent per piece, disjoint files)

| # | Piece | Files owned | Architecture headings touched |
|---|-------|--------------|-------------------------------|
| 0 | Git init, keep `AGENTS.md` local-only, scaffold + shared domain types | `.gitignore`, `.gitattributes`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `eslint.config.js`, `docker-compose.yml`, `README.md`, `src/domain.ts` | all (glue) |
| 1 | Validated env config | `src/config.ts`, `src/config.test.ts`, `.env.example` | Component Architecture (server/queue rows), Guardrails #2 |
| 2 | Timing-safe webhook signature verification | `src/webhooks/verify-signature.ts`, `src/webhooks/verify-signature.test.ts` | Pipeline step 1 |
| 3 | GitHub App auth + queued check-run poster | `src/github/octokit.ts`, `src/github/checks.ts`, `src/github/octokit.test.ts`, `src/github/checks.test.ts` | Pipeline step 1, API & Interface Contracts (Check Runs) |
| 4 | Webhook event parsing + dispatch routing | `src/webhooks/events.ts`, `src/webhooks/handle-event.ts`, `src/webhooks/events.test.ts`, `src/webhooks/handle-event.test.ts` | Pipeline steps 1–2 (dispatch), API & Interface Contracts (`POST /webhooks/github`) |
| 5 | BullMQ verification queue + worker bootstrap | `src/queue/enqueuer.ts`, `src/queue/worker.ts`, `src/queue/enqueuer.test.ts` | Component Architecture (Job Orchestrator row) |
| 6 | Fastify app + server entrypoint (wave 2, after 1–5 land) | `src/app.ts`, `src/server.ts`, `src/app.test.ts` | API & Interface Contracts (`POST /webhooks/github`) |
| 7 | GitHub App registration guide + manifest | `docs/app-setup.md`, `.github/app-manifest.json` | Phase 1 line ("Register GitHub App") |
| 8 | CI workflow (lead, after code lands) | `.github/workflows/ci.yml` | all (verification) |

## Shared contracts (created in piece 0 as `src/domain.ts`; all pieces import from here)

```ts
export type RepoFullName = string; // "owner/repo"

export interface VerificationJob {
  repoFullName: RepoFullName;
  prNumber: number;
  installationId: number | null; // null when the event carried no installation context
  baseSha: string;
  headSha: string;
}

export interface CheckRunInput {
  repoFullName: RepoFullName;
  headSha: string;
  installationId: number | null;
}

export type CheckRunStatus = 'queued' | 'in_progress' | 'completed';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface EnqueueResult { jobId: string }
export interface Enqueuer { enqueue(job: VerificationJob): Promise<EnqueueResult> }
export interface CheckRunPoster { postQueuedCheckRun(input: CheckRunInput): Promise<void> }
export type VerificationJobHandler = (job: VerificationJob) => Promise<void>;
```

Piece 1 (`src/config.ts`): `loadConfig(env = process.env): AppConfig` throwing a single `ConfigError` that aggregates all problems. `AppConfig = { port, redisUrl, githubAppId, githubPrivateKey (real-newline PEM), webhookSecret, logLevel }`. Env names: `PORT` (default 3000), `REDIS_URL` (default `redis://127.0.0.1:6379`), `GITHUB_APP_ID` (numeric), `GITHUB_PRIVATE_KEY` (raw PEM **or** base64 of one), `GITHUB_WEBHOOK_SECRET`, `LOG_LEVEL` (default `info`).

Piece 2: `verifyWebhookSignature(rawBody: Buffer | string, signatureHeader: string | undefined, secret: string): boolean` — HMAC-SHA256, `sha256=<hex>` prefix, `crypto.timingSafeEqual`, length-guarded, no exceptions on malformed input.

Piece 3: `createOctokit(config): Octokit` (auth-app strategy) and `createCheckRunPoster(config, octokit?): CheckRunPoster` — posts `POST /repos/{owner}/{repo}/check-runs` with `status: 'queued'` and name `DiffProve: Differential Verification`.

Piece 4: `parseWebhookEvent(event, payload): ParsedWebhook` (zod-validated `pull_request` / `installation` / `ping`, plus `unhandled` / `invalid` kinds) and `handleWebhookEvent(parsed, deps): Promise<WebhookResult>` — on `opened|synchronize|reopened`: enqueue (durable record first) then post `queued` check run; either failure → HTTP 500 (GitHub retries, job-id dedupe makes retries safe); success → 202. No installation context → 200 ignore + warn.

Piece 5: `jobIdFor(job)` (`verify~<owner>~<repo>~<pr>~<headSha>`, `/` sanitized), `createEnqueuer(redisUrl): Enqueuer` (attempts 3, exponential backoff), `startWorker(redisUrl, handler)` + Phase-1 `logOnlyHandler`.

Piece 6: `buildApp(deps): FastifyInstance` — raw-body JSON parser, HMAC check (401), event routing, `/healthz`; `src/server.ts` composes real deps + graceful shutdown. Proof: `fastify.inject` full webhook flow.

## Branches & commits

- `main`: docs + (at the end) the merged Phase 1 branch.
- `feature/phase-1-webhook-ingestion`: all Phase 1 code. Meaningful commits per piece (not one blob): scaffold → config → signature verify → github client → event routing → queue → server → app-setup docs → CI. Merge to `main` with a `--no-ff` merge commit when the phase is verified.
- `AGENTS.md` stays **local-only** (listed in `.git/info/exclude`, never committed, never pushed).

## Verification

- Each subagent proves its piece with `npx vitest run <its test files>` (scoped — parallel-friendly) and reports status + real output.
- Orchestrator reviews the actual diff of every piece, then runs the full gate itself: `npm run typecheck && npm test && npm run lint` (plus `npm run build`). Failures go back to the owning subagent with the exact error.
- Unverified locally (no Docker/Redis on this machine, no live GitHub app): BullMQ end-to-end behavior against real Redis (`skipIf`-gated), real webhook delivery from GitHub, actual App registration (manual user step — guide provided in `docs/app-setup.md`).
