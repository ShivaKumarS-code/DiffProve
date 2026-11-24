/**
 * Entrypoint for the DiffProve GitHub App server.
 *
 * This is the composition root: the only module that reads environment
 * configuration and the only one that constructs real infrastructure (Redis
 * clients, the Octokit transport, Fastify). `src/app.ts` stays injected so it
 * can be tested without any of it.
 *
 * Phase 1 + 2 scope (architecture, "End-to-End Verification Pipeline" steps
 * 1-2): accept verified webhooks, post a `queued` check run, and consume each
 * job through the diff splitter — reporting the no-test-changes short-circuit
 * as `neutral`, and deferring real differential runs to the Phase 3 sandbox.
 */

import 'dotenv/config';

import { buildApp } from './app.js';
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { createCheckRunPoster } from './github/checks.js';
import { createCheckRunReporter } from './github/check-runs.js';
import { createAppAuthenticator, createOctokit } from './github/octokit.js';
import { createPrDiffClient } from './github/pulls.js';
import { createEnqueuer } from './queue/enqueuer.js';
import { createDiffSplittingHandler } from './queue/diff-handler.js';
import { startWorker } from './queue/worker.js';

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

  // One shared auth-less transport + authenticator backs every GitHub call:
  // the Phase 1 queued-check-run poster and the Phase 2 diff/report clients.
  const octokit = createOctokit();
  const authenticator = createAppAuthenticator(config.githubAppId, config.githubPrivateKey);
  const checkPoster = createCheckRunPoster(octokit, authenticator);

  const app = buildApp({
    webhookSecret: config.webhookSecret,
    enqueuer,
    checkPoster,
    logLevel: config.logLevel,
  });

  // Phase 2 handler: fetch the PR diff, split it, and either report the
  // no-test-changes short-circuit (neutral check run) or defer to the Phase 3
  // sandbox runner while the check run stays queued from Phase 1.
  const worker = startWorker(
    config.redisUrl,
    createDiffSplittingHandler({
      prDiff: createPrDiffClient(octokit, authenticator),
      checkRuns: createCheckRunReporter(octokit, authenticator),
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
    // then release the enqueuer's Redis client, then close the HTTP server.
    await worker.close();
    await enqueuer.close();
    await app.close();

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
