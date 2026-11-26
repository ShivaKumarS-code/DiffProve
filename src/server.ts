/**
 * Entrypoint for the DiffProve GitHub App server.
 *
 * This is the composition root: the only module that reads environment
 * configuration and the only one that constructs real infrastructure (Redis
 * clients, the Octokit transport, Fastify). `src/app.ts` stays injected so it
 * can be tested without any of it.
 *
 * Phase 1-4 scope (architecture, "End-to-End Verification Pipeline" steps 1-6):
 * accept verified webhooks, post a `queued` check run, split each PR's diff,
 * run the differential (Run A base + Test-Only Patch, Run B head + Full PR
 * Patch) in an E2B sandbox with egress locked down, complete the check run
 * with the rich Markdown verdict report, and persist runs + repo config to
 * PostgreSQL for the dashboard. PRs without test changes short-circuit to
 * `neutral` as before.
 */

import 'dotenv/config';

import { type AuthDeps } from './api/auth-routes.js';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { createInstallationStore } from './db/installations.js';
import { runMigrations } from './db/migrate.js';
import { createPgPool } from './db/pool.js';
import { createRepoConfigLookup, createRepositoryStore } from './db/repositories.js';
import type { InstallationStore, RepositoryStore, VerificationRunStore } from './db/types.js';
import { createVerificationRunStore } from './db/verification-runs.js';
import { createCheckRunPoster } from './github/checks.js';
import { createCheckRunReporter } from './github/check-runs.js';
import { createAppAuthenticator, createOctokit } from './github/octokit.js';
import { createPrDiffClient } from './github/pulls.js';
import { createRepoContentClient } from './github/repo-content.js';
import { createRepoTarballClient } from './github/repo-tarball.js';
import { createGitHubOAuthClient } from './github/user-auth.js';
import { createVerdictReporter } from './github/verdict-report.js';
import { createDifferentialHandler } from './queue/differential-handler.js';
import { createEnqueuer } from './queue/enqueuer.js';
import { startWorker } from './queue/worker.js';
import { createE2bDifferentialRunner } from './runner/e2b-runner.js';
import { createE2bSandboxFactory } from './runner/e2b-sandbox.js';
import { createRedisKeyValueStore, createSnapshotCache } from './runner/snapshot-cache.js';

/** Signals that start the graceful shutdown sequence. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Reads and validates configuration, exiting with status 1 when it is invalid.
 *
 * The non-zero exit is intentional and expected: a misconfigured deployment must
 * fail fast (CI asserts this) instead of starting a server that cannot verify
 * webhooks. `ConfigError` already aggregates every problem into one message and
 * never echoes secret values, so printing it is safe.
 */
function readConfig(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const config = readConfig();

  // Real ports. Nothing below logs a config value.
  const enqueuer = createEnqueuer(config.redisUrl);

  // Phase 4 run-history database (optional): without DATABASE_URL the API
  // answers 503, installation events are only logged, and verification runs
  // are not persisted. With it, migrations run at boot — a reachable database
  // is a hard requirement then, and an outage fails fast like any other
  // invalid configuration.
  const dbPool = config.databaseUrl === null ? null : createPgPool(config.databaseUrl);
  let repositories: RepositoryStore | null = null;
  let runsStore: VerificationRunStore | null = null;
  let installationStore: InstallationStore | null = null;
  if (dbPool !== null) {
    await runMigrations(dbPool);
    repositories = createRepositoryStore(dbPool);
    runsStore = createVerificationRunStore(dbPool, repositories);
    installationStore = createInstallationStore(dbPool);
  }
  const repoConfig = repositories === null ? null : createRepoConfigLookup(repositories);

  // One shared auth-less transport + authenticator backs every GitHub call:
  // the queued-check-run poster, the diff/report clients, and the Phase 3
  // repo-content, tarball, and verdict reporters.
  const octokit = createOctokit();
  const authenticator = createAppAuthenticator(config.githubAppId, config.githubPrivateKey);
  const checkPoster = createCheckRunPoster(octokit, authenticator);

  const auth: AuthDeps | null =
    config.githubClientId !== null &&
    config.githubClientSecret !== null &&
    config.sessionSecret !== null
      ? {
          sessionSecret: config.sessionSecret,
          githubOAuth: createGitHubOAuthClient({
            clientId: config.githubClientId,
            clientSecret: config.githubClientSecret,
          }),
          publicUrl: config.publicUrl,
        }
      : null;

  const app = buildApp({
    webhookSecret: config.webhookSecret,
    enqueuer,
    checkPoster,
    logLevel: config.logLevel,
    api: repositories !== null && runsStore !== null ? { repositories, runs: runsStore } : null,
    installations: installationStore,
    auth,
  });

  // Phase 3 differential runner. Without an E2B_API_KEY there is no sandbox, so
  // the runner port is null: the handler logs a warning per job and leaves the
  // check run queued instead of pretending a verification happened.
  const e2bApiKey = config.e2bApiKey;
  const snapshotKv = e2bApiKey === null ? null : createRedisKeyValueStore(config.redisUrl);
  const runner =
    e2bApiKey === null || snapshotKv === null
      ? null
      : createE2bDifferentialRunner({
          sandboxFactory: createE2bSandboxFactory(),
          apiKey: e2bApiKey,
          defaultTemplateId: config.e2bTemplateId ?? undefined,
          snapshotCache: createSnapshotCache(snapshotKv),
          logger: app.log,
          installTimeoutMs: config.e2bInstallTimeoutMs,
          testTimeoutMs: config.e2bTestTimeoutMs,
        });

  // Phase 3 handler: split the diff, short-circuit PRs without test changes,
  // and otherwise provision + execute the differential and report the verdict.
  const worker = startWorker(
    config.redisUrl,
    createDifferentialHandler({
      prDiff: createPrDiffClient(octokit, authenticator),
      checkRuns: createCheckRunReporter(octokit, authenticator),
      repoContent: createRepoContentClient(octokit, authenticator),
      repoTarball: createRepoTarballClient(octokit, authenticator),
      repoConfig,
      runs: runsStore,
      runner,
      verdicts: createVerdictReporter(octokit, authenticator),
      logger: app.log,
    }),
    { logger: app.log },
  );

  await app.listen({ port: config.port, host: '0.0.0.0' });
  // The single startup line. Host and port are not secrets; everything else is.
  app.log.info(`DiffProve GitHub App listening on port ${config.port}`);

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // A second signal while teardown is running must not start a second one.
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info(`received ${signal}, shutting down`);

    // Order matters: stop consuming jobs first so no handler starts mid-teardown,
    // then release the snapshot-cache Redis client (worker side only), then the
    // enqueuer's, then close the HTTP server, and finally the database pool
    // (nothing queries it once the API routes are gone).
    await worker.close();
    if (snapshotKv !== null) {
      await snapshotKv.close();
    }
    await enqueuer.close();
    await app.close();
    if (dbPool !== null) {
      await dbPool.close();
    }

    // Forced exit guarantees no lingering handle keeps the process alive even if
    // a library connection is left behind; the queue's own close() already quit
    // its Redis clients.
    process.exit(0);
  };

  const handleSignal = (signal: string): void => {
    void shutdown(signal).catch((error: unknown) => {
      // Message only: ioredis/BullMQ errors can embed connection details.
      app.log.error(
        `shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    });
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      handleSignal(signal);
    });
  }
}

main().catch((error: unknown) => {
  // Message only: Octokit/Redis error objects can retain request configuration
  // (including tokens), which must never reach logs.
  console.error(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
