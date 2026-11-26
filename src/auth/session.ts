/**
 * Stateless encrypted session cookies and signed OAuth state tokens.
 *
 * Uses pure `node:crypto` (AES-256-GCM for session encryption and HMAC-SHA256
 * with constant-time comparison for OAuth CSRF state). Guardrail #2: session
 * payloads hold the user's OAuth token inside an authenticated ciphertext so
 * the token is never exposed in plaintext cookies or error objects.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const SESSION_COOKIE_NAME = 'diffprove_session';
export const OAUTH_STATE_COOKIE_NAME = 'diffprove_oauth_state';

const AES_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const OAUTH_STATE_NONCE_BYTES = 16;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface SessionUser {
  id: number;
  login: string;
  avatarUrl: string | null;
}

export interface SessionPayload {
  user: SessionUser;
  accessToken: string;
  /** Expiration timestamp in epoch milliseconds. */
  exp: number;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict';
  path?: string;
}

function deriveAesKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Encrypts a session payload with AES-256-GCM using a key derived from
 * `secret`. Returns `<iv>.<tag>.<ciphertext>` encoded as `base64url`.
 */
export function encryptSession(payload: SessionPayload, secret: string): string {
  const key = deriveAesKey(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

/**
 * Decrypts and validates a session cookie token. Never throws; returns `null`
 * on malformed input, authentication failure, invalid shape, or expiration.
 */
export function decryptSession(
  token: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): SessionPayload | null {
  try {
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      typeof secret !== 'string' ||
      typeof nowMs !== 'number' ||
      !Number.isFinite(nowMs)
    ) {
      return null;
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [ivPart, tagPart, ciphertextPart] = parts;
    if (!ivPart || !tagPart || !ciphertextPart) {
      return null;
    }

    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    const ciphertext = Buffer.from(ciphertextPart, 'base64url');

    if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) {
      return null;
    }

    const key = deriveAesKey(secret);
    const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');

    const parsed: unknown = JSON.parse(plaintext);
    if (!isPlainObject(parsed)) {
      return null;
    }

    const userRaw = parsed.user;
    if (!isPlainObject(userRaw)) {
      return null;
    }

    const { id, login, avatarUrl } = userRaw;
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      return null;
    }
    if (typeof login !== 'string' || login.length === 0) {
      return null;
    }
    if (avatarUrl !== null && typeof avatarUrl !== 'string') {
      return null;
    }

    const { accessToken, exp } = parsed;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return null;
    }
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowMs) {
      return null;
    }

    return {
      user: {
        id,
        login,
        avatarUrl,
      },
      accessToken,
      exp,
    };
  } catch {
    return null;
  }
}

/**
 * Creates a CSRF OAuth `state` nonce and a matching HMAC-signed cookie value
 * valid for 10 minutes.
 */
export function createOAuthState(
  secret: string,
  nowMs: number = Date.now(),
): { state: string; cookieValue: string } {
  const nonce = randomBytes(OAUTH_STATE_NONCE_BYTES).toString('base64url');
  const expiresAtMs = nowMs + OAUTH_STATE_TTL_MS;
  const hmacHex = createHmac('sha256', secret)
    .update(`${nonce}.${expiresAtMs}`, 'utf8')
    .digest('hex');

  return {
    state: nonce,
    cookieValue: `${nonce}.${expiresAtMs}.${hmacHex}`,
  };
}

/**
 * Verifies an OAuth callback's `state` query parameter against the signed
 * OAuth state cookie using constant-time comparisons. Never throws.
 */
export function verifyOAuthState(
  cookieValue: string | undefined,
  queryState: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  try {
    if (
      typeof cookieValue !== 'string' ||
      cookieValue.length === 0 ||
      typeof queryState !== 'string' ||
      queryState.length === 0 ||
      typeof secret !== 'string' ||
      typeof nowMs !== 'number' ||
      !Number.isFinite(nowMs)
    ) {
      return false;
    }

    const parts = cookieValue.split('.');
    if (parts.length !== 3) {
      return false;
    }

    const [nonce, expiresAtStr, providedHmacHex] = parts;
    if (!nonce || !expiresAtStr || !providedHmacHex) {
      return false;
    }

    if (!/^\d+$/.test(expiresAtStr)) {
      return false;
    }

    const expiresAtMs = Number(expiresAtStr);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      return false;
    }

    if (!/^[0-9a-f]{64}$/i.test(providedHmacHex)) {
      return false;
    }

    const expectedHmac = createHmac('sha256', secret)
      .update(`${nonce}.${expiresAtStr}`, 'utf8')
      .digest();
    const providedHmac = Buffer.from(providedHmacHex, 'hex');

    if (
      providedHmac.length !== expectedHmac.length ||
      !timingSafeEqual(providedHmac, expectedHmac)
    ) {
      return false;
    }

    const nonceBuf = Buffer.from(nonce, 'utf8');
    const queryBuf = Buffer.from(queryState, 'utf8');
    if (nonceBuf.length !== queryBuf.length) {
      return false;
    }

    return timingSafeEqual(nonceBuf, queryBuf);
  } catch {
    return false;
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parses an HTTP `Cookie` header into a plain `{ name: value }` map, safely
 * decoding URI components without throwing on malformed percent-encoding.
 */
export function parseCookies(
  cookieHeader: string | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (typeof cookieHeader !== 'string' || cookieHeader.trim().length === 0) {
    return cookies;
  }

  for (const segment of cookieHeader.split(';')) {
    const eqIndex = segment.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const rawName = segment.slice(0, eqIndex).trim();
    if (!rawName) {
      continue;
    }

    const name = safeDecodeURIComponent(rawName);
    if (!name || name === '__proto__' || name === 'constructor' || name === 'prototype') {
      continue;
    }

    const rawValue = segment.slice(eqIndex + 1).trim();
    cookies[name] = safeDecodeURIComponent(rawValue);
  }

  return cookies;
}

/**
 * Formats a `Set-Cookie` header value with secure defaults (`Path=/`,
 * `HttpOnly`, `SameSite=Lax`).
 */
export function formatCookie(
  name: string,
  value: string,
  opts: CookieOptions = {},
): string {
  const path = opts.path ?? '/';
  const httpOnly = opts.httpOnly ?? true;
  const sameSite = opts.sameSite ?? 'Lax';

  const parts = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    `Path=${path}`,
  ];

  if (opts.maxAgeSeconds !== undefined && Number.isFinite(opts.maxAgeSeconds)) {
    parts.push(`Max-Age=${Math.floor(opts.maxAgeSeconds)}`);
  }

  if (httpOnly) {
    parts.push('HttpOnly');
  }

  if (opts.secure) {
    parts.push('Secure');
  }

  parts.push(`SameSite=${sameSite}`);

  return parts.join('; ');
}
