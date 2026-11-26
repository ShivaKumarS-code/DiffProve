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
 * `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`, `E2B_API_KEY`, `REDIS_URL`, or
 * `DATABASE_URL` (the last two may embed credentials). Only non-secret,
 * enumerated values such as `PORT`, `LOG_LEVEL`, `PUBLIC_URL`, and the E2B
 * timeouts are quoted back.
 */

/** Validated runtime configuration for the GitHub App server. */
export interface AppConfig {
  port: number;
  redisUrl: string;
  /**
   * PostgreSQL connection string, e.g.
   * `postgresql://diffprove:diffprove@127.0.0.1:5432/diffprove`.
   *
   * Null when unset: installations, repo config overrides, and run history are
   * then disabled — the API answers 503 and verification runs are not
   * persisted. May embed credentials — never echoed in errors or logs.
   */
  databaseUrl: string | null;
  /** Numeric GitHub App id, e.g. "123456" (kept as a string to avoid precision loss). */
  githubAppId: string;
  /** PEM text with real newlines, ready to hand to `@octokit/auth-app`. */
  githubPrivateKey: string;
  webhookSecret: string;
  /** GitHub App OAuth client id; null when OAuth login is disabled. */
  githubClientId: string | null;
  /**
   * GitHub App OAuth client secret; null when OAuth login is disabled.
   * Secret — never echoed in errors or logs.
   */
  githubClientSecret: string | null;
  /**
   * HMAC secret for signing dashboard session cookies (>= 16 chars when set);
   * null when OAuth login is disabled. Secret — never echoed in errors or logs.
   */
  sessionSecret: string | null;
  /**
   * Public HTTP(S) origin of the server (e.g. `https://diffprove.example.com`)
   * with trailing slashes stripped; null when unset.
   */
  publicUrl: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /**
   * E2B API key for the differential sandbox runner. Null when sandbox
   * execution is not configured: jobs with test changes then stay `queued`
   * instead of producing a verdict. Secret — never echoed in errors or logs.
   */
  e2bApiKey: string | null;
  /**
   * Optional custom E2B sandbox template id. Null means "use the SDK default
   * template", which is enough for most Python/Node repositories.
   */
  e2bTemplateId: string | null;
  /** Timeout for each targeted test command (Run A / Run B) inside the sandbox. */
  e2bTestTimeoutMs: number;
  /** Timeout for dependency installation before a snapshot is taken. */
  e2bInstallTimeoutMs: number;
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

/**
 * Sandbox timeouts (docs/architecture.md, "End-to-End Verification Pipeline"
 * step 3): installing dependencies is allowed to take longer than a single
 * targeted test command, and both stay within E2B's sandbox lifetime limits.
 */
const DEFAULT_E2B_TEST_TIMEOUT_MS = 120_000;
const DEFAULT_E2B_INSTALL_TIMEOUT_MS = 240_000;

const MIN_PORT = 1;
const MAX_PORT = 65535;
const MIN_SESSION_SECRET_LENGTH = 16;

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** Accepted Redis URI schemes (plaintext and TLS). */
const REDIS_URL_SCHEMES = ['redis://', 'rediss://'] as const;

/** Accepted PostgreSQL URI schemes. */
const DATABASE_URL_SCHEMES = ['postgres://', 'postgresql://'] as const;

/** Accepted public HTTP(S) origin schemes. */
const PUBLIC_URL_SCHEMES = ['http://', 'https://'] as const;

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

function parseDatabaseUrl(
  value: string | undefined,
  problems: string[],
): string | null {
  if (value === undefined) {
    return null;
  }
  if (!DATABASE_URL_SCHEMES.some((scheme) => value.startsWith(scheme))) {
    // Do not echo the value: a PostgreSQL URL usually embeds the password.
    problems.push(
      'DATABASE_URL: must start with "postgres://" or "postgresql://"',
    );
    return null;
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
 * Optional opaque text value (`E2B_API_KEY`, `E2B_TEMPLATE_ID`).
 *
 * Unset and blank both map to null. No format is imposed: the API key is a
 * token passed straight to the E2B SDK and the template id is provider-defined.
 * The value is never echoed in errors — for `E2B_API_KEY` that is a security
 * requirement, not a style choice.
 */
function parseOptionalText(value: string | undefined): string | null {
  return value ?? null;
}

/**
 * Parse a positive timeout in milliseconds, falling back to `defaultValue`
 * when unset.
 *
 * The digits-only gate matches `PORT`: it rejects "0", "-5", "1.5", "1e3", and
 * trailing garbage before `Number` can coerce a surprising value. Echoing the
 * value is safe — unlike an API key, a timeout is not a secret.
 */
function parseTimeoutMs(
  name: string,
  value: string | undefined,
  defaultValue: number,
  problems: string[],
): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = DIGITS_ONLY.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    problems.push(
      `${name}: must be a positive integer number of milliseconds (got ${JSON.stringify(value)})`,
    );
    return defaultValue;
  }
  return parsed;
}

/**
 * Parse GitHub App OAuth settings (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
 * `SESSION_SECRET`). Optional as a group: when all three are unset/blank,
 * OAuth login is disabled and all three resolve to null. If any one is set,
 * all three are required together.
 *
 * Security: `GITHUB_CLIENT_SECRET` and `SESSION_SECRET` are never echoed in
 * error messages.
 */
function parseOAuthConfig(
  env: Record<string, string | undefined>,
  problems: string[],
): {
  githubClientId: string | null;
  githubClientSecret: string | null;
  sessionSecret: string | null;
} {
  const githubClientId = readValue(env, 'GITHUB_CLIENT_ID');
  const githubClientSecret = readValue(env, 'GITHUB_CLIENT_SECRET');
  const sessionSecret = readValue(env, 'SESSION_SECRET');

  if (
    githubClientId === undefined &&
    githubClientSecret === undefined &&
    sessionSecret === undefined
  ) {
    return {
      githubClientId: null,
      githubClientSecret: null,
      sessionSecret: null,
    };
  }

  const entries: ReadonlyArray<readonly [string, string | undefined]> = [
    ['GITHUB_CLIENT_ID', githubClientId],
    ['GITHUB_CLIENT_SECRET', githubClientSecret],
    ['SESSION_SECRET', sessionSecret],
  ];

  for (const [name, value] of entries) {
    if (value === undefined) {
      problems.push(
        `${name}: is required when GitHub OAuth is enabled (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and SESSION_SECRET must all be set together)`,
      );
    }
  }

  if (sessionSecret !== undefined && sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    // Never echo the value: it is a secret, even when too short.
    problems.push(
      `SESSION_SECRET: must be at least ${MIN_SESSION_SECRET_LENGTH} characters long (the value is not shown because it is a secret)`,
    );
  }

  return {
    githubClientId: githubClientId ?? null,
    githubClientSecret: githubClientSecret ?? null,
    sessionSecret: sessionSecret ?? null,
  };
}

function parsePublicUrl(
  value: string | undefined,
  problems: string[],
): string | null {
  if (value === undefined) {
    return null;
  }
  if (!PUBLIC_URL_SCHEMES.some((scheme) => value.startsWith(scheme))) {
    problems.push(
      `PUBLIC_URL: must start with "http://" or "https://" (got ${JSON.stringify(value)})`,
    );
    return null;
  }
  return value.replace(/\/+$/, '');
}

/**
 * Validate an environment bag and return a frozen-by-convention `AppConfig`.
 *
 * Defaults: `PORT=3000`, `REDIS_URL=redis://127.0.0.1:6379` (matches
 * `docker compose up -d redis`), no `DATABASE_URL` (run history, repo config,
 * and installation persistence disabled), no GitHub OAuth or `PUBLIC_URL`
 * (dashboard OAuth login disabled), `LOG_LEVEL=info`, no E2B API key or
 * template (sandbox execution disabled), `E2B_TEST_TIMEOUT_MS=120000`,
 * `E2B_INSTALL_TIMEOUT_MS=240000`.
 *
 * @throws {ConfigError} listing every missing or invalid variable at once.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const problems: string[] = [];

  const port = parsePort(readValue(env, 'PORT'), problems);
  const redisUrl = parseRedisUrl(readValue(env, 'REDIS_URL'), problems);

  // Optional PostgreSQL connection (matches `docker compose up -d postgres`).
  // Absent means "persistence disabled", so the server still boots without a
  // database; the API then answers 503 and runs are not recorded.
  const databaseUrl = parseDatabaseUrl(readValue(env, 'DATABASE_URL'), problems);

  const githubAppId = parseGitHubAppId(readValue(env, 'GITHUB_APP_ID'), problems);
  const githubPrivateKey = parsePrivateKey(
    readValue(env, 'GITHUB_PRIVATE_KEY'),
    problems,
  );
  const webhookSecret = parseWebhookSecret(
    readValue(env, 'GITHUB_WEBHOOK_SECRET'),
    problems,
  );
  const { githubClientId, githubClientSecret, sessionSecret } = parseOAuthConfig(
    env,
    problems,
  );
  const publicUrl = parsePublicUrl(readValue(env, 'PUBLIC_URL'), problems);
  const logLevel = parseLogLevel(readValue(env, 'LOG_LEVEL'), problems);

  // Optional E2B sandbox settings: absent means "sandbox disabled", so the
  // server still boots (and PRs with test changes stay queued) without a key.
  const e2bApiKey = parseOptionalText(readValue(env, 'E2B_API_KEY'));
  const e2bTemplateId = parseOptionalText(readValue(env, 'E2B_TEMPLATE_ID'));
  const e2bTestTimeoutMs = parseTimeoutMs(
    'E2B_TEST_TIMEOUT_MS',
    readValue(env, 'E2B_TEST_TIMEOUT_MS'),
    DEFAULT_E2B_TEST_TIMEOUT_MS,
    problems,
  );
  const e2bInstallTimeoutMs = parseTimeoutMs(
    'E2B_INSTALL_TIMEOUT_MS',
    readValue(env, 'E2B_INSTALL_TIMEOUT_MS'),
    DEFAULT_E2B_INSTALL_TIMEOUT_MS,
    problems,
  );

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
    databaseUrl,
    githubAppId,
    githubPrivateKey,
    webhookSecret,
    githubClientId,
    githubClientSecret,
    sessionSecret,
    publicUrl,
    logLevel,
    e2bApiKey,
    e2bTemplateId,
    e2bTestTimeoutMs,
    e2bInstallTimeoutMs,
  };
}
