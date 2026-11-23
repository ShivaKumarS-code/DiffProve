/**
 * Environment configuration for the DiffProve GitHub App server.
 *
 * `loadConfig` is the single place where process environment variables are
 * read and validated. It collects *every* problem before throwing a single
 * `ConfigError`, so a misconfigured deployment fails once with the complete
 * list of missing/invalid variables instead of dribbling out one error per
 * restart.
 *
 * Security (architecture guardrail #2): secrets must never be logged or
 * leaked. Consequently the error messages below name the offending variable
 * but never echo its value for `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`,
 * or `REDIS_URL` (the latter may embed credentials). Only non-secret,
 * enumerated values such as `PORT` and `LOG_LEVEL` are quoted back.
 */

/** Validated runtime configuration for the GitHub App server. */
export interface AppConfig {
  port: number;
  redisUrl: string;
  /** Numeric GitHub App id, e.g. "123456" (kept as a string to avoid precision loss). */
  githubAppId: string;
  /** PEM text with real newlines, ready to hand to `@octokit/auth-app`. */
  githubPrivateKey: string;
  webhookSecret: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/** Thrown by {@link loadConfig} when the environment is missing or invalid. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_PORT = 3000;
const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
const DEFAULT_LOG_LEVEL: AppConfig['logLevel'] = 'info';

const MIN_PORT = 1;
const MAX_PORT = 65535;

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** Accepted Redis URI schemes (plaintext and TLS). */
const REDIS_URL_SCHEMES = ['redis://', 'rediss://'] as const;

const DIGITS_ONLY = /^\d+$/;

/**
 * Read an environment value, trimming surrounding whitespace.
 * Blank or whitespace-only values are treated as unset.
 */
function readValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parsePort(value: string | undefined, problems: string[]): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }
  // Reject "3000.5", "0x10", "3_000", "+3000" and trailing garbage up front so
  // `Number` cannot coerce a surprising value.
  const port = DIGITS_ONLY.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    problems.push(
      `PORT: must be an integer between ${MIN_PORT} and ${MAX_PORT} (got ${JSON.stringify(value)})`,
    );
    return DEFAULT_PORT;
  }
  return port;
}

function parseRedisUrl(value: string | undefined, problems: string[]): string {
  if (value === undefined) {
    return DEFAULT_REDIS_URL;
  }
  if (!REDIS_URL_SCHEMES.some((scheme) => value.startsWith(scheme))) {
    // Do not echo the value: a Redis URL may contain credentials.
    problems.push(
      'REDIS_URL: must start with "redis://" or "rediss://"',
    );
    return DEFAULT_REDIS_URL;
  }
  return value;
}

function parseGitHubAppId(
  value: string | undefined,
  problems: string[],
): string {
  if (value === undefined) {
    problems.push(
      'GITHUB_APP_ID: is required but is not set (it is the numeric App ID from the GitHub App settings page)',
    );
    return '';
  }
  if (!DIGITS_ONLY.test(value)) {
    problems.push(
      'GITHUB_APP_ID: must contain only digits (it is the numeric App ID from the GitHub App settings page)',
    );
    return '';
  }
  return value;
}

/**
 * Turn the raw `GITHUB_PRIVATE_KEY` value into PEM text with real newlines.
 *
 * Two encodings are accepted, matching how people actually configure this:
 *  (a) raw PEM text, optionally stored on one line with literal "\n" escapes
 *      (also tolerating "\\r\\n" escapes from Windows tooling);
 *  (b) base64 of the whole `.pem` file, detected by the absence of the string
 *      "PRIVATE KEY" (a base64 payload cannot contain it: no spaces in the
 *      base64 alphabet). Decoding ignores whitespace and is otherwise as
 *      forgiving as Node's `Buffer` decoder.
 *
 * The decoded body itself is never trimmed or rewritten, because PEM content
 * is newline-sensitive for parsers.
 */
function normalizePrivateKey(raw: string): string {
  if (raw.includes('PRIVATE KEY')) {
    return raw
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n');
  }
  const compact = raw.replace(/\s+/g, '');
  return Buffer.from(compact, 'base64').toString('utf8');
}

function parsePrivateKey(
  value: string | undefined,
  problems: string[],
): string {
  if (value === undefined) {
    problems.push(
      'GITHUB_PRIVATE_KEY: is required but is not set (paste the base64 of your GitHub App .pem file, or the raw PEM text)',
    );
    return '';
  }
  const pem = normalizePrivateKey(value);
  if (!pem.includes('-----BEGIN') || !pem.includes('PRIVATE KEY')) {
    // Never echo the value: it is a secret, even when malformed.
    problems.push(
      'GITHUB_PRIVATE_KEY: is not a PEM private key (expected base64-encoded PEM or raw PEM text containing "-----BEGIN ... PRIVATE KEY-----"; the value is not shown because it is a secret)',
    );
    return '';
  }
  return pem;
}

function parseWebhookSecret(
  value: string | undefined,
  problems: string[],
): string {
  if (value === undefined) {
    // Never echo the value: it is a secret.
    problems.push(
      'GITHUB_WEBHOOK_SECRET: is required but is not set (the secret you chose when registering the App webhook)',
    );
    return '';
  }
  return value;
}

function parseLogLevel(
  value: string | undefined,
  problems: string[],
): AppConfig['logLevel'] {
  if (value === undefined) {
    return DEFAULT_LOG_LEVEL;
  }
  if (!(LOG_LEVELS as readonly string[]).includes(value)) {
    problems.push(
      `LOG_LEVEL: must be one of ${LOG_LEVELS.join(', ')} (got ${JSON.stringify(value)})`,
    );
    return DEFAULT_LOG_LEVEL;
  }
  return value as AppConfig['logLevel'];
}

/**
 * Validate an environment bag and return a frozen-by-convention `AppConfig`.
 *
 * Defaults: `PORT=3000`, `REDIS_URL=redis://127.0.0.1:6379` (matches
 * `docker compose up -d redis`), `LOG_LEVEL=info`.
 *
 * @throws {ConfigError} listing every missing or invalid variable at once.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const problems: string[] = [];

  const port = parsePort(readValue(env, 'PORT'), problems);
  const redisUrl = parseRedisUrl(readValue(env, 'REDIS_URL'), problems);
  const githubAppId = parseGitHubAppId(readValue(env, 'GITHUB_APP_ID'), problems);
  const githubPrivateKey = parsePrivateKey(
    readValue(env, 'GITHUB_PRIVATE_KEY'),
    problems,
  );
  const webhookSecret = parseWebhookSecret(
    readValue(env, 'GITHUB_WEBHOOK_SECRET'),
    problems,
  );
  const logLevel = parseLogLevel(readValue(env, 'LOG_LEVEL'), problems);

  if (problems.length > 0) {
    throw new ConfigError(
      ['Invalid environment configuration:', ...problems.map((p) => `  - ${p}`)].join(
        '\n',
      ),
    );
  }

  return {
    port,
    redisUrl,
    githubAppId,
    githubPrivateKey,
    webhookSecret,
    logLevel,
  };
}
