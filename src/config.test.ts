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
    GITHUB_APP_ID: '987654',
    GITHUB_PRIVATE_KEY: FAKE_PEM,
    GITHUB_WEBHOOK_SECRET: 'placeholder-webhook-secret',
    LOG_LEVEL: 'debug',
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
      githubAppId: '987654',
      githubPrivateKey: FAKE_PEM,
      webhookSecret: 'placeholder-webhook-secret',
      logLevel: 'debug',
    });
  });

  it('applies defaults for PORT, REDIS_URL and LOG_LEVEL when omitted', () => {
    const config = loadConfig(requiredEnv());

    expect(config.port).toBe(3000);
    expect(config.redisUrl).toBe('redis://127.0.0.1:6379');
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
