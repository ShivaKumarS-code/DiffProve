import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, type AppConfig } from './config.js';

/**
 * A syntactically PEM-shaped but entirely fake RSA key. It is never used to
 * sign anything; tests only assert that the newlines survive configuration
 * loading.
 */
const FAKE_PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAexampleplaceholderkeymaterialnotarealkeystring',
  'aGVsbG8td29ybGQtdGhpcy1pcy1hLWZha2Uta2V5LWJvZHktZm9yLXRlc3Rz',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

/** Minimal valid environment: exactly the three required variables. */
function requiredEnv(): Record<string, string | undefined> {
  return {
    GITHUB_APP_ID: '123456',
    GITHUB_PRIVATE_KEY: FAKE_PEM,
    GITHUB_WEBHOOK_SECRET: 'placeholder-webhook-secret',
  };
}

/** A valid environment in which every variable is set explicitly. */
function fullEnv(): Record<string, string | undefined> {
  return {
    PORT: '8080',
    REDIS_URL: 'rediss://redis.internal:6380',
    DATABASE_URL: 'postgresql://diffprove:placeholder@db.internal:5432/diffprove',
    GITHUB_APP_ID: '987654',
    GITHUB_PRIVATE_KEY: FAKE_PEM,
    GITHUB_WEBHOOK_SECRET: 'placeholder-webhook-secret',
    GITHUB_CLIENT_ID: 'Iv1.placeholderclientid',
    GITHUB_CLIENT_SECRET: 'placeholder-oauth-client-secret',
    SESSION_SECRET: 'placeholder-session-secret-1234',
    PUBLIC_URL: 'https://diffprove.example.com',
    LOG_LEVEL: 'debug',
    E2B_API_KEY: 'e2b_placeholder_api_key',
    E2B_TEMPLATE_ID: 'diffprove-placeholder-template',
    E2B_TEST_TIMEOUT_MS: '90000',
    E2B_INSTALL_TIMEOUT_MS: '180000',
  };
}

/** Assert that `loadConfig` throws a `ConfigError` and return it for inspection. */
function captureConfigError(
  env: Record<string, string | undefined>,
): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected loadConfig to throw a ConfigError, but it returned a config');
}

describe('loadConfig with valid input', () => {
  it('returns the exact expected AppConfig for a fully valid environment', () => {
    const config: AppConfig = loadConfig(fullEnv());

    expect(config).toEqual({
      port: 8080,
      redisUrl: 'rediss://redis.internal:6380',
      databaseUrl: 'postgresql://diffprove:placeholder@db.internal:5432/diffprove',
      githubAppId: '987654',
      githubPrivateKey: FAKE_PEM,
      webhookSecret: 'placeholder-webhook-secret',
      githubClientId: 'Iv1.placeholderclientid',
      githubClientSecret: 'placeholder-oauth-client-secret',
      sessionSecret: 'placeholder-session-secret-1234',
      publicUrl: 'https://diffprove.example.com',
      logLevel: 'debug',
      e2bApiKey: 'e2b_placeholder_api_key',
      e2bTemplateId: 'diffprove-placeholder-template',
      e2bTestTimeoutMs: 90000,
      e2bInstallTimeoutMs: 180000,
    });
  });

  it('applies defaults for PORT, REDIS_URL, DATABASE_URL, OAuth, PUBLIC_URL and LOG_LEVEL when omitted', () => {
    const config = loadConfig(requiredEnv());

    expect(config.port).toBe(3000);
    expect(config.redisUrl).toBe('redis://127.0.0.1:6379');
    expect(config.databaseUrl).toBeNull();
    expect(config.githubClientId).toBeNull();
    expect(config.githubClientSecret).toBeNull();
    expect(config.sessionSecret).toBeNull();
    expect(config.publicUrl).toBeNull();
    expect(config.logLevel).toBe('info');
  });

  it('accepts a plaintext redis:// URL and the default port', () => {
    const config = loadConfig({
      ...requiredEnv(),
      REDIS_URL: 'redis://127.0.0.1:6379',
    });

    expect(config.redisUrl).toBe('redis://127.0.0.1:6379');
    expect(config.port).toBe(3000);
  });

  it('trims surrounding whitespace on values', () => {
    const config = loadConfig({
      ...requiredEnv(),
      PORT: '  4000  ',
      GITHUB_APP_ID: ' 123456 ',
      GITHUB_WEBHOOK_SECRET: ' placeholder-webhook-secret ',
      LOG_LEVEL: ' warn ',
    });

    expect(config.port).toBe(4000);
    expect(config.githubAppId).toBe('123456');
    expect(config.webhookSecret).toBe('placeholder-webhook-secret');
    expect(config.logLevel).toBe('warn');
  });

  it('accepts the default port boundary values', () => {
    expect(loadConfig({ ...requiredEnv(), PORT: '1' }).port).toBe(1);
    expect(loadConfig({ ...requiredEnv(), PORT: '65535' }).port).toBe(65535);
  });

  it('normalizes literal "\\n" escape sequences in a raw PEM private key', () => {
    const escaped = FAKE_PEM.replace(/\n/g, '\\n');
    expect(escaped).not.toContain('\n');

    const config = loadConfig({ ...requiredEnv(), GITHUB_PRIVATE_KEY: escaped });

    expect(config.githubPrivateKey).toBe(FAKE_PEM);
    expect(config.githubPrivateKey).toContain('\n');
    expect(config.githubPrivateKey.split('\n')).toHaveLength(4);
  });

  it('normalizes literal "\\r\\n" escape sequences in a raw PEM private key', () => {
    const escaped = FAKE_PEM.replace(/\n/g, '\\r\\n');

    const config = loadConfig({ ...requiredEnv(), GITHUB_PRIVATE_KEY: escaped });

    expect(config.githubPrivateKey).toBe(FAKE_PEM);
  });

  it('decodes a base64-encoded private key into PEM with real newlines', () => {
    const encoded = Buffer.from(FAKE_PEM, 'utf8').toString('base64');

    const config = loadConfig({ ...requiredEnv(), GITHUB_PRIVATE_KEY: encoded });

    expect(config.githubPrivateKey).toBe(FAKE_PEM);
    expect(config.githubPrivateKey).toContain('-----BEGIN');
    expect(config.githubPrivateKey.split('\n')).toHaveLength(4);
  });

  it('decodes a line-wrapped base64 private key, ignoring whitespace', () => {
    const encoded = Buffer.from(FAKE_PEM, 'utf8')
      .toString('base64')
      .replace(/(.{16})/g, '$1\n');

    const config = loadConfig({ ...requiredEnv(), GITHUB_PRIVATE_KEY: encoded });

    expect(config.githubPrivateKey).toBe(FAKE_PEM);
  });
});

describe('loadConfig with missing or invalid input', () => {
  it('reports all three missing required variables in a single ConfigError', () => {
    const error = captureConfigError({});

    expect(error.name).toBe('ConfigError');
    expect(error.message).toContain('GITHUB_APP_ID');
    expect(error.message).toContain('GITHUB_PRIVATE_KEY');
    expect(error.message).toContain('GITHUB_WEBHOOK_SECRET');
    expect(error.message).toContain('Invalid environment configuration');
  });

  it('reports missing required variables alongside other invalid values at once', () => {
    const error = captureConfigError({
      PORT: 'nope',
      GITHUB_APP_ID: 'abc',
    });

    expect(error.message).toContain('PORT');
    expect(error.message).toContain('GITHUB_APP_ID');
    expect(error.message).toContain('GITHUB_PRIVATE_KEY');
    expect(error.message).toContain('GITHUB_WEBHOOK_SECRET');
  });

  it.each(['not-a-port', '0', '70000', '3000.5', '-1'])(
    'rejects invalid PORT value %j',
    (port) => {
      const error = captureConfigError({ ...requiredEnv(), PORT: port });

      expect(error.message).toContain('PORT');
      expect(error.message).not.toContain('GITHUB_APP_ID');
    },
  );

  it('rejects a REDIS_URL with the wrong scheme', () => {
    const error = captureConfigError({
      ...requiredEnv(),
      REDIS_URL: 'http://x',
    });

    expect(error.message).toContain('REDIS_URL');
    expect(error.message).not.toContain('GITHUB_PRIVATE_KEY');
  });

  it.each(['abc123', '123-456', '123456.0', '0x10'])(
    'rejects non-numeric GITHUB_APP_ID value %j',
    (appId) => {
      const error = captureConfigError({
        ...requiredEnv(),
        GITHUB_APP_ID: appId,
      });

      expect(error.message).toContain('GITHUB_APP_ID');
      expect(error.message).not.toContain('GITHUB_PRIVATE_KEY');
    },
  );

  it('rejects a GITHUB_PRIVATE_KEY that decodes to nothing PEM-like', () => {
    const error = captureConfigError({
      ...requiredEnv(),
      GITHUB_PRIVATE_KEY: 'definitely not a pem or valid base64 !!!',
    });

    expect(error.message).toContain('GITHUB_PRIVATE_KEY');
    expect(error.message).not.toContain('GITHUB_APP_ID');
  });

  it('rejects a GITHUB_PRIVATE_KEY that is base64 of non-PEM text', () => {
    const encoded = Buffer.from('hello world, no key here', 'utf8').toString(
      'base64',
    );
    const error = captureConfigError({
      ...requiredEnv(),
      GITHUB_PRIVATE_KEY: encoded,
    });

    expect(error.message).toContain('GITHUB_PRIVATE_KEY');
  });

  it.each(['verbose', 'INFO', 'trace', ''])(
    'rejects invalid LOG_LEVEL value %j',
    (level) => {
      // An empty value is treated as unset, so it must fall back to the default.
      if (level === '') {
        expect(loadConfig({ ...requiredEnv(), LOG_LEVEL: level }).logLevel).toBe(
          'info',
        );
        return;
      }

      const error = captureConfigError({ ...requiredEnv(), LOG_LEVEL: level });

      expect(error.message).toContain('LOG_LEVEL');
    },
  );

  it('never leaks secret-bearing values in the error message', () => {
    const error = captureConfigError({
      ...requiredEnv(),
      REDIS_URL: 'http://user:hunter2@redis.example:6379',
      GITHUB_PRIVATE_KEY: 'SUPER_SECRET_GARBAGE_VALUE',
      GITHUB_WEBHOOK_SECRET: undefined,
    });

    expect(error.message).toContain('REDIS_URL');
    expect(error.message).toContain('GITHUB_PRIVATE_KEY');
    expect(error.message).toContain('GITHUB_WEBHOOK_SECRET');
    expect(error.message).not.toContain('hunter2');
    expect(error.message).not.toContain('SUPER_SECRET_GARBAGE_VALUE');
  });
});

describe('loadConfig — E2B sandbox settings', () => {
  it('defaults to sandbox execution disabled with the documented timeouts', () => {
    const config = loadConfig(requiredEnv());

    expect(config.e2bApiKey).toBeNull();
    expect(config.e2bTemplateId).toBeNull();
    expect(config.e2bTestTimeoutMs).toBe(120000);
    expect(config.e2bInstallTimeoutMs).toBe(240000);
  });

  it('parses explicitly configured E2B values', () => {
    const config = loadConfig({
      ...requiredEnv(),
      E2B_API_KEY: 'e2b_placeholder_api_key',
      E2B_TEMPLATE_ID: 'diffprove-placeholder-template',
      E2B_TEST_TIMEOUT_MS: '45000',
      E2B_INSTALL_TIMEOUT_MS: '300000',
    });

    expect(config.e2bApiKey).toBe('e2b_placeholder_api_key');
    expect(config.e2bTemplateId).toBe('diffprove-placeholder-template');
    expect(config.e2bTestTimeoutMs).toBe(45000);
    expect(config.e2bInstallTimeoutMs).toBe(300000);
  });

  it('accepts any non-blank E2B_API_KEY: the value is opaque to the server', () => {
    const config = loadConfig({
      ...requiredEnv(),
      E2B_API_KEY: 'not-a-real-key-format',
    });

    expect(config.e2bApiKey).toBe('not-a-real-key-format');
  });

  it('trims surrounding whitespace on E2B values', () => {
    const config = loadConfig({
      ...requiredEnv(),
      E2B_API_KEY: '  e2b_placeholder_api_key  ',
      E2B_TEMPLATE_ID: '  diffprove-placeholder-template  ',
      E2B_TEST_TIMEOUT_MS: '  45000  ',
      E2B_INSTALL_TIMEOUT_MS: ' 300000 ',
    });

    expect(config.e2bApiKey).toBe('e2b_placeholder_api_key');
    expect(config.e2bTemplateId).toBe('diffprove-placeholder-template');
    expect(config.e2bTestTimeoutMs).toBe(45000);
    expect(config.e2bInstallTimeoutMs).toBe(300000);
  });

  it('treats blank E2B values as unset', () => {
    const config = loadConfig({
      ...requiredEnv(),
      E2B_API_KEY: '   ',
      E2B_TEMPLATE_ID: '',
      E2B_TEST_TIMEOUT_MS: '\t',
      E2B_INSTALL_TIMEOUT_MS: ' ',
    });

    expect(config.e2bApiKey).toBeNull();
    expect(config.e2bTemplateId).toBeNull();
    expect(config.e2bTestTimeoutMs).toBe(120000);
    expect(config.e2bInstallTimeoutMs).toBe(240000);
  });
});

describe('loadConfig — invalid E2B settings', () => {
  it.each(['0', '-5', 'abc', '1.5', '1e3'])(
    'rejects invalid E2B_TEST_TIMEOUT_MS value %j',
    (timeout) => {
      const error = captureConfigError({
        ...requiredEnv(),
        E2B_TEST_TIMEOUT_MS: timeout,
      });

      expect(error.message).toContain('E2B_TEST_TIMEOUT_MS');
      expect(error.message).not.toContain('GITHUB_PRIVATE_KEY');
    },
  );

  it.each(['0', '-5', 'abc'])(
    'rejects invalid E2B_INSTALL_TIMEOUT_MS value %j',
    (timeout) => {
      const error = captureConfigError({
        ...requiredEnv(),
        E2B_INSTALL_TIMEOUT_MS: timeout,
      });

      expect(error.message).toContain('E2B_INSTALL_TIMEOUT_MS');
      expect(error.message).not.toContain('GITHUB_PRIVATE_KEY');
    },
  );

  it('aggregates both invalid timeouts into a single ConfigError', () => {
    const error = captureConfigError({
      ...requiredEnv(),
      E2B_TEST_TIMEOUT_MS: '0',
      E2B_INSTALL_TIMEOUT_MS: '-5',
    });

    expect(error.name).toBe('ConfigError');
    expect(error.message).toContain('Invalid environment configuration');
    expect(error.message).toContain('E2B_TEST_TIMEOUT_MS');
    expect(error.message).toContain('E2B_INSTALL_TIMEOUT_MS');
  });

  it('never leaks the E2B_API_KEY value in the error message', () => {
    const bogusApiKey = 'SUPER_SECRET_E2B_API_KEY_VALUE';
    const error = captureConfigError({
      ...requiredEnv(),
      E2B_API_KEY: bogusApiKey,
      E2B_TEST_TIMEOUT_MS: 'abc',
    });

    expect(error.message).toContain('E2B_TEST_TIMEOUT_MS');
    expect(error.message).not.toContain(bogusApiKey);
    expect(error.message).not.toContain('E2B_API_KEY');
  });
});

describe('loadConfig — DATABASE_URL', () => {
  it('defaults to null when unset (persistence disabled)', () => {
    expect(loadConfig(requiredEnv()).databaseUrl).toBeNull();
  });

  it('treats a blank value as unset', () => {
    expect(loadConfig({ ...requiredEnv(), DATABASE_URL: '   ' }).databaseUrl).toBeNull();
    expect(loadConfig({ ...requiredEnv(), DATABASE_URL: '' }).databaseUrl).toBeNull();
  });

  it.each(['postgres://user:pass@host:5432/db', 'postgresql://user:pass@host/db'])(
    'accepts the PostgreSQL URL %j',
    (url) => {
      expect(loadConfig({ ...requiredEnv(), DATABASE_URL: url }).databaseUrl).toBe(url);
    },
  );

  it('trims surrounding whitespace', () => {
    const url = 'postgresql://diffprove:diffprove@127.0.0.1:5432/diffprove';

    expect(loadConfig({ ...requiredEnv(), DATABASE_URL: `  ${url}  ` }).databaseUrl).toBe(url);
  });

  it('rejects a non-PostgreSQL URL and names DATABASE_URL', () => {
    const error = captureConfigError({ ...requiredEnv(), DATABASE_URL: 'mysql://x' });

    expect(error.name).toBe('ConfigError');
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).not.toContain('GITHUB_PRIVATE_KEY');
  });

  it('never leaks credentials embedded in an invalid DATABASE_URL', () => {
    const error = captureConfigError({
      ...requiredEnv(),
      DATABASE_URL: 'mysql://admin:hunter3@db.example:3306/app',
    });

    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).not.toContain('hunter3');
    expect(error.message).not.toContain('mysql://admin');
    expect(error.message).not.toContain('db.example');
  });

  it('aggregates a bad DATABASE_URL with other problems into one ConfigError', () => {
    const error = captureConfigError({
      ...requiredEnv(),
      DATABASE_URL: 'mysql://x',
      PORT: 'nope',
    });

    expect(error.message).toContain('Invalid environment configuration');
    expect(error.message).toContain('PORT');
    expect(error.message).toContain('DATABASE_URL');
  });
});

describe('loadConfig — GitHub OAuth & PUBLIC_URL', () => {
  it('resolves all OAuth fields and publicUrl to null when omitted or blank', () => {
    const omitted = loadConfig(requiredEnv());
    expect(omitted.githubClientId).toBeNull();
    expect(omitted.githubClientSecret).toBeNull();
    expect(omitted.sessionSecret).toBeNull();
    expect(omitted.publicUrl).toBeNull();

    const blank = loadConfig({
      ...requiredEnv(),
      GITHUB_CLIENT_ID: '   ',
      GITHUB_CLIENT_SECRET: '',
      SESSION_SECRET: '\t',
      PUBLIC_URL: '  ',
    });
    expect(blank.githubClientId).toBeNull();
    expect(blank.githubClientSecret).toBeNull();
    expect(blank.sessionSecret).toBeNull();
    expect(blank.publicUrl).toBeNull();
  });

  it('populates all OAuth fields when all three are valid and trims whitespace', () => {
    const config = loadConfig({
      ...requiredEnv(),
      GITHUB_CLIENT_ID: '  Iv1.client123  ',
      GITHUB_CLIENT_SECRET: '  super-secret-oauth-client  ',
      SESSION_SECRET: '  exactly-16-chars  ',
    });

    expect(config.githubClientId).toBe('Iv1.client123');
    expect(config.githubClientSecret).toBe('super-secret-oauth-client');
    expect(config.sessionSecret).toBe('exactly-16-chars');
  });

  it('rejects partial OAuth configuration, lists missing vars, and never echoes secrets', () => {
    const onlyClientId = captureConfigError({
      ...requiredEnv(),
      GITHUB_CLIENT_ID: 'Iv1.client123',
    });
    expect(onlyClientId.message).toContain('GITHUB_CLIENT_SECRET');
    expect(onlyClientId.message).toContain('SESSION_SECRET');
    expect(onlyClientId.message).not.toContain('GITHUB_CLIENT_ID: is required');

    const secretMarker = 'SUPER_SECRET_OAUTH_CLIENT_TOKEN';
    const sessionMarker = 'SUPER_SECRET_SESSION_SIGNING_KEY';
    const missingClientId = captureConfigError({
      ...requiredEnv(),
      GITHUB_CLIENT_SECRET: secretMarker,
      SESSION_SECRET: sessionMarker,
    });
    expect(missingClientId.message).toContain('GITHUB_CLIENT_ID');
    expect(missingClientId.message).toContain('required');
    expect(missingClientId.message).not.toContain(secretMarker);
    expect(missingClientId.message).not.toContain(sessionMarker);
  });

  it('rejects SESSION_SECRET shorter than 16 characters without echoing its value', () => {
    const shortSecret = 'too-short-15chr';
    expect(shortSecret).toHaveLength(15);

    const error = captureConfigError({
      ...requiredEnv(),
      GITHUB_CLIENT_ID: 'Iv1.client123',
      GITHUB_CLIENT_SECRET: 'placeholder-oauth-client-secret',
      SESSION_SECRET: shortSecret,
    });

    expect(error.message).toContain('SESSION_SECRET');
    expect(error.message).toContain('16');
    expect(error.message).not.toContain(shortSecret);
  });

  it('accepts http:// and https:// PUBLIC_URL and strips trailing slashes', () => {
    expect(
      loadConfig({ ...requiredEnv(), PUBLIC_URL: 'http://localhost:3000/' }).publicUrl,
    ).toBe('http://localhost:3000');

    expect(
      loadConfig({ ...requiredEnv(), PUBLIC_URL: '  https://diffprove.example.com///  ' })
        .publicUrl,
    ).toBe('https://diffprove.example.com');
  });

  it.each(['diffprove.example.com', 'ftp://diffprove.example.com', 'ws://localhost:3000'])(
    'rejects invalid PUBLIC_URL value %j',
    (publicUrl) => {
      const error = captureConfigError({
        ...requiredEnv(),
        PUBLIC_URL: publicUrl,
      });

      expect(error.name).toBe('ConfigError');
      expect(error.message).toContain('PUBLIC_URL');
    },
  );
});
