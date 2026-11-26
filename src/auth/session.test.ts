import { createCipheriv, createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  OAUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  createOAuthState,
  decryptSession,
  encryptSession,
  formatCookie,
  parseCookies,
  verifyOAuthState,
  type SessionPayload,
} from './session.js';

const SECRET = 'super-secret-session-signing-key-32bytes';
const OTHER_SECRET = 'completely-different-secret-key-value';
const BASE_NOW_MS = 1_700_000_000_000;

const SAMPLE_PAYLOAD: SessionPayload = {
  user: {
    id: 42,
    login: 'octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4',
  },
  accessToken: 'ghu_secretUserAccessToken12345',
  exp: BASE_NOW_MS + 3_600_000,
};

function encryptRawJson(json: string, secret: string = SECRET): string {
  const key = createHash('sha256').update(secret, 'utf8').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(json, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

describe('session constants', () => {
  it('exports expected cookie names', () => {
    expect(SESSION_COOKIE_NAME).toBe('diffprove_session');
    expect(OAUTH_STATE_COOKIE_NAME).toBe('diffprove_oauth_state');
  });
});

describe('encryptSession / decryptSession', () => {
  it('round-trips a valid session payload', () => {
    const token = encryptSession(SAMPLE_PAYLOAD, SECRET);
    expect(token.split('.')).toHaveLength(3);
    expect(token).not.toContain(SAMPLE_PAYLOAD.accessToken);
    expect(token).not.toContain(SAMPLE_PAYLOAD.user.login);

    const decrypted = decryptSession(token, SECRET, BASE_NOW_MS);
    expect(decrypted).toEqual(SAMPLE_PAYLOAD);
  });

  it('supports null avatarUrl and uses a fresh random IV each time', () => {
    const payload: SessionPayload = {
      ...SAMPLE_PAYLOAD,
      user: { id: 7, login: 'hubot', avatarUrl: null },
    };

    const first = encryptSession(payload, SECRET);
    const second = encryptSession(payload, SECRET);
    expect(first).not.toBe(second);

    expect(decryptSession(first, SECRET, BASE_NOW_MS)).toEqual(payload);
    expect(decryptSession(second, SECRET, BASE_NOW_MS)).toEqual(payload);
  });

  it('rejects tampered ciphertext, auth tag, or IV', () => {
    const token = encryptSession(SAMPLE_PAYLOAD, SECRET);
    const [ivPart, tagPart, cipherPart] = token.split('.');

    const flipFirstChar = (segment: string): string => {
      const replacement = segment[0] === 'A' ? 'B' : 'A';
      return `${replacement}${segment.slice(1)}`;
    };

    expect(
      decryptSession(`${flipFirstChar(ivPart)}.${tagPart}.${cipherPart}`, SECRET, BASE_NOW_MS),
    ).toBeNull();
    expect(
      decryptSession(`${ivPart}.${flipFirstChar(tagPart)}.${cipherPart}`, SECRET, BASE_NOW_MS),
    ).toBeNull();
    expect(
      decryptSession(`${ivPart}.${tagPart}.${flipFirstChar(cipherPart)}`, SECRET, BASE_NOW_MS),
    ).toBeNull();
  });

  it('rejects a token decrypted with the wrong secret', () => {
    const token = encryptSession(SAMPLE_PAYLOAD, SECRET);
    expect(decryptSession(token, OTHER_SECRET, BASE_NOW_MS)).toBeNull();
  });

  it('rejects expired sessions including exact exp === nowMs boundary', () => {
    const token = encryptSession(SAMPLE_PAYLOAD, SECRET);

    expect(decryptSession(token, SECRET, SAMPLE_PAYLOAD.exp - 1)).toEqual(SAMPLE_PAYLOAD);
    expect(decryptSession(token, SECRET, SAMPLE_PAYLOAD.exp)).toBeNull();
    expect(decryptSession(token, SECRET, SAMPLE_PAYLOAD.exp + 1)).toBeNull();
  });

  it('never throws and returns null for malformed tokens or invalid payload shapes', () => {
    const malformedInputs: Array<string | undefined> = [
      undefined,
      '',
      'only-one-part',
      'two.parts',
      'a.b.c.d',
      'short.tag.cipher',
      `${Buffer.alloc(12).toString('base64url')}.${Buffer.alloc(15).toString('base64url')}.abc`,
      encryptRawJson('not-json'),
      encryptRawJson(JSON.stringify([])),
      encryptRawJson(JSON.stringify({ user: null, accessToken: 'tok', exp: BASE_NOW_MS + 1000 })),
      encryptRawJson(
        JSON.stringify({
          user: { id: '42', login: 'octocat', avatarUrl: null },
          accessToken: 'tok',
          exp: BASE_NOW_MS + 1000,
        }),
      ),
      encryptRawJson(
        JSON.stringify({
          user: { id: 42, login: '', avatarUrl: null },
          accessToken: 'tok',
          exp: BASE_NOW_MS + 1000,
        }),
      ),
      encryptRawJson(
        JSON.stringify({
          user: { id: 42, login: 'octocat', avatarUrl: 123 },
          accessToken: 'tok',
          exp: BASE_NOW_MS + 1000,
        }),
      ),
      encryptRawJson(
        JSON.stringify({
          user: { id: 42, login: 'octocat', avatarUrl: null },
          accessToken: '',
          exp: BASE_NOW_MS + 1000,
        }),
      ),
    ];

    for (const input of malformedInputs) {
      expect(() => decryptSession(input, SECRET, BASE_NOW_MS)).not.toThrow();
      expect(decryptSession(input, SECRET, BASE_NOW_MS)).toBeNull();
    }
  });
});

describe('createOAuthState / verifyOAuthState', () => {
  it('creates and verifies a valid state within the 10-minute TTL', () => {
    const { state, cookieValue } = createOAuthState(SECRET, BASE_NOW_MS);
    expect(state.length).toBeGreaterThan(10);
    expect(cookieValue.split('.')).toHaveLength(3);

    expect(verifyOAuthState(cookieValue, state, SECRET, BASE_NOW_MS)).toBe(true);
    expect(
      verifyOAuthState(cookieValue, state, SECRET, BASE_NOW_MS + 10 * 60 * 1000 - 1),
    ).toBe(true);
  });

  it('rejects expired state at and past the 10-minute TTL', () => {
    const { state, cookieValue } = createOAuthState(SECRET, BASE_NOW_MS);

    expect(
      verifyOAuthState(cookieValue, state, SECRET, BASE_NOW_MS + 10 * 60 * 1000),
    ).toBe(false);
    expect(
      verifyOAuthState(cookieValue, state, SECRET, BASE_NOW_MS + 10 * 60 * 1000 + 1),
    ).toBe(false);
  });

  it('rejects tampered cookie, mismatched query state, wrong secret, and malformed values', () => {
    const { state, cookieValue } = createOAuthState(SECRET, BASE_NOW_MS);
    const [nonce, expiresAt, hmac] = cookieValue.split('.');
    const badHmac = `${hmac[0] === 'a' ? 'b' : 'a'}${hmac.slice(1)}`;

    expect(verifyOAuthState(`${nonce}.${expiresAt}.${badHmac}`, state, SECRET, BASE_NOW_MS)).toBe(
      false,
    );
    expect(
      verifyOAuthState(`tampered.${expiresAt}.${hmac}`, 'tampered', SECRET, BASE_NOW_MS),
    ).toBe(false);
    expect(verifyOAuthState(cookieValue, `${state}x`, SECRET, BASE_NOW_MS)).toBe(false);
    expect(verifyOAuthState(cookieValue, 'different-nonce', SECRET, BASE_NOW_MS)).toBe(false);
    expect(verifyOAuthState(cookieValue, state, OTHER_SECRET, BASE_NOW_MS)).toBe(false);
    expect(verifyOAuthState(undefined, state, SECRET, BASE_NOW_MS)).toBe(false);
    expect(verifyOAuthState(cookieValue, undefined, SECRET, BASE_NOW_MS)).toBe(false);
    expect(verifyOAuthState('bad.cookie', state, SECRET, BASE_NOW_MS)).toBe(false);
    expect(
      verifyOAuthState(`${nonce}.notanumber.${hmac}`, state, SECRET, BASE_NOW_MS),
    ).toBe(false);
  });
});

describe('parseCookies / formatCookie', () => {
  it('parses cookies with trimming, equals signs in values, and safe URI decoding', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('   ')).toEqual({});

    const parsed = parseCookies(
      ' a=1 ; diffprove_session=abc%3D123%2Bxyz; malformed=%E0%A4%A; flag; =emptyName ',
    );
    expect(parsed).toEqual({
      a: '1',
      diffprove_session: 'abc=123+xyz',
      malformed: '%E0%A4%A',
    });
  });

  it('ignores prototype-polluting cookie names', () => {
    const parsed = parseCookies('__proto__=evil; constructor=bad; safe=ok');
    expect(parsed).toEqual({ safe: 'ok' });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it('formats Set-Cookie headers with secure defaults and custom options', () => {
    expect(formatCookie(SESSION_COOKIE_NAME, 'tok.123', {})).toBe(
      'diffprove_session=tok.123; Path=/; HttpOnly; SameSite=Lax',
    );

    expect(
      formatCookie(OAUTH_STATE_COOKIE_NAME, '', {
        maxAgeSeconds: 0,
        secure: true,
        httpOnly: false,
        sameSite: 'Strict',
        path: '/auth',
      }),
    ).toBe('diffprove_oauth_state=; Path=/auth; Max-Age=0; Secure; SameSite=Strict');
  });

  it('round-trips formatted cookie values through parseCookies', () => {
    const header = formatCookie('note', 'hello world=100%', { maxAgeSeconds: 600 });
    const cookiePair = header.split(';')[0];
    expect(parseCookies(cookiePair)).toEqual({ note: 'hello world=100%' });
  });
});
