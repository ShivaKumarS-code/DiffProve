import { createVerify, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createAppAuthenticator } from './octokit.js';

const APP_ID = '123456';

// One in-test keypair for both tests: no fixtures, no network, no key material
// committed to the repo.
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });

const PKCS1_PRIVATE_KEY_PEM = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const PKCS8_PRIVATE_KEY_PEM = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_KEY_PEM = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

interface JwtHeader {
  alg?: string;
}

interface JwtPayload {
  iss?: string;
  iat: number;
  exp: number;
}

let usablePrivateKeyPem: string | undefined;

/**
 * `@octokit/auth-app` signs through WebCrypto, which only accepts PKCS#8.
 * Current versions convert PKCS#1 for us, but this probe keeps the test honest
 * on both encodings and pins whichever one the installed version accepts.
 */
async function privateKeyPem(): Promise<string> {
  if (usablePrivateKeyPem) {
    return usablePrivateKeyPem;
  }

  let lastError: unknown;
  for (const candidate of [PKCS1_PRIVATE_KEY_PEM, PKCS8_PRIVATE_KEY_PEM]) {
    try {
      const authenticator = createAppAuthenticator(APP_ID, candidate);
      await authenticator({ type: 'app' });
      usablePrivateKeyPem = candidate;
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/** Decodes a JWT segment (base64url, unpadded) into a Buffer. */
function decodeSegment(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Resolves an Octokit-style route template against its parameters. */
function resolveRoute(route: string, parameters?: Record<string, unknown>): string {
  const [, path = ''] = route.split(' ');

  return Object.entries(parameters ?? {}).reduce(
    (url, [key, value]) => url.replace(`{${key}}`, String(value)),
    path,
  );
}

describe('createAppAuthenticator', () => {
  it('mints an RS256 App JWT signed with the App private key', async () => {
    const authenticator = createAppAuthenticator(APP_ID, await privateKeyPem());

    const { token } = await authenticator({ type: 'app' });

    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    const header = JSON.parse(decodeSegment(headerB64).toString('utf8')) as JwtHeader;
    const payload = JSON.parse(decodeSegment(payloadB64).toString('utf8')) as JwtPayload;

    expect(header.alg).toBe('RS256');
    expect(payload.iss).toBe(APP_ID);

    const verified = createVerify('RSA-SHA256')
      .update(`${headerB64}.${payloadB64}`)
      .verify(PUBLIC_KEY_PEM, signatureB64, 'base64');
    expect(verified).toBe(true);

    // GitHub App JWTs are valid for 10 minutes, backdated 30s for clock skew.
    const lifetime = payload.exp - payload.iat;
    expect(lifetime).toBeGreaterThanOrEqual(598);
    expect(lifetime).toBeLessThanOrEqual(602);

    const issuedAgo = Math.floor(Date.now() / 1000) - payload.iat;
    expect(issuedAgo).toBeGreaterThanOrEqual(0);
    expect(issuedAgo).toBeLessThanOrEqual(60);
  });

  it('exchanges an App JWT for an installation access token', async () => {
    // Stands in for the token endpoint: no network, and it asserts that the
    // requested installation id actually reaches the request URL.
    const fakeRequest = vi.fn(async (route: string, parameters?: Record<string, unknown>) => {
      expect(route).toContain('/app/installations/{installation_id}/access_tokens');
      expect(parameters?.installation_id).toBe(999);
      expect(resolveRoute(route, parameters)).toContain('/app/installations/999/access_tokens');

      return {
        status: 201,
        data: {
          token: 'ghs_test_token',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      };
    });

    const authenticator = createAppAuthenticator(APP_ID, await privateKeyPem(), fakeRequest);

    const installationToken = await authenticator.installation(999);

    expect(installationToken).toEqual({ token: 'ghs_test_token' });
    expect(fakeRequest).toHaveBeenCalledTimes(1);
  });
});
