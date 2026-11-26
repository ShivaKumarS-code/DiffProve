/**
 * GitHub App User-to-Server OAuth routes and stateless session cookie helpers.
 *
 * Implements `/api/auth/session`, `/api/auth/login`, `/api/auth/callback`, and
 * `/api/auth/logout`. Guardrail #2: `sessionSecret`, `clientSecret`, and user
 * OAuth `accessToken` values are never logged or exposed in error responses.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  createOAuthState,
  decryptSession,
  encryptSession,
  formatCookie,
  OAUTH_STATE_COOKIE_NAME,
  parseCookies,
  SESSION_COOKIE_NAME,
  verifyOAuthState,
  type SessionPayload,
} from '../auth/session.js';
import type { GitHubOAuthClient } from '../github/user-auth.js';

export interface AuthDeps {
  sessionSecret: string;
  githubOAuth: GitHubOAuthClient;
  publicUrl?: string | null;
}

const OAUTH_NOT_CONFIGURED_STATUS = 503;
const REDIRECT_STATUS = 302;
const OAUTH_STATE_MAX_AGE_SECONDS = 600;
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_MAX_AGE_SECONDS * 1000;

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const first = raw.split(',')[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

/**
 * Resolves the external origin (`scheme://host`) for OAuth callback redirects
 * and cookie `Secure` flags, preferring an explicit `PUBLIC_URL`.
 */
function resolveOrigin(
  request: FastifyRequest,
  publicUrl?: string | null,
): string {
  const trimmedPublicUrl = publicUrl?.trim();
  if (trimmedPublicUrl) {
    return trimmedPublicUrl.replace(/\/+$/, '');
  }

  const proto = (firstHeaderValue(request.headers['x-forwarded-proto']) ?? 'http').toLowerCase();
  const host =
    firstHeaderValue(request.headers['x-forwarded-host']) ??
    firstHeaderValue(request.headers.host) ??
    'localhost:3000';

  return `${proto}://${host}`;
}

function isSecureOrigin(origin: string): boolean {
  return origin.startsWith('https://');
}

/**
 * Reads and decrypts the authenticated session from the incoming `Cookie`
 * header. Returns `null` when missing, malformed, or expired.
 */
export function readSessionFromRequest(
  request: FastifyRequest,
  sessionSecret: string,
): SessionPayload | null {
  const cookies = parseCookies(request.headers.cookie);
  return decryptSession(cookies[SESSION_COOKIE_NAME], sessionSecret);
}

/**
 * Registers `/api/auth/*` endpoints on the Fastify instance.
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthDeps | null,
): void {
  app.get('/api/auth/session', async (request) => {
    if (auth === null) {
      return { oauthEnabled: false, user: null };
    }

    const session = readSessionFromRequest(request, auth.sessionSecret);
    return {
      oauthEnabled: true,
      user: session?.user ?? null,
    };
  });

  app.get('/api/auth/login', async (request, reply) => {
    if (auth === null) {
      return reply
        .code(OAUTH_NOT_CONFIGURED_STATUS)
        .send({ message: 'GitHub OAuth is not configured' });
    }

    const { state, cookieValue } = createOAuthState(auth.sessionSecret);
    const origin = resolveOrigin(request, auth.publicUrl);
    const redirectUri = `${origin}/api/auth/callback`;

    const stateCookie = formatCookie(OAUTH_STATE_COOKIE_NAME, cookieValue, {
      maxAgeSeconds: OAUTH_STATE_MAX_AGE_SECONDS,
      secure: isSecureOrigin(origin),
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    });

    const authorizeUrl = auth.githubOAuth.authorizeUrl({ state, redirectUri });
    return reply.header('set-cookie', stateCookie).redirect(authorizeUrl, REDIRECT_STATUS);
  });

  app.get<{ Querystring: CallbackQuery }>(
    '/api/auth/callback',
    async (request, reply) => {
      if (auth === null) {
        return reply
          .code(OAUTH_NOT_CONFIGURED_STATUS)
          .send({ message: 'GitHub OAuth is not configured' });
      }

      const origin = resolveOrigin(request, auth.publicUrl);
      const secure = isSecureOrigin(origin);
      const clearStateCookie = formatCookie(OAUTH_STATE_COOKIE_NAME, '', {
        maxAgeSeconds: 0,
        secure,
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
      });

      const query = request.query;
      if (query.error) {
        const message = query.error_description || query.error;
        return reply
          .header('set-cookie', clearStateCookie)
          .redirect(`/?authError=${encodeURIComponent(message)}`, REDIRECT_STATUS);
      }

      const cookies = parseCookies(request.headers.cookie);
      if (
        !verifyOAuthState(
          cookies[OAUTH_STATE_COOKIE_NAME],
          query.state,
          auth.sessionSecret,
        )
      ) {
        return reply
          .header('set-cookie', clearStateCookie)
          .redirect('/?authError=invalid_oauth_state', REDIRECT_STATUS);
      }

      if (typeof query.code !== 'string' || query.code.length === 0) {
        return reply
          .header('set-cookie', clearStateCookie)
          .redirect('/?authError=missing_code', REDIRECT_STATUS);
      }

      try {
        const redirectUri = `${origin}/api/auth/callback`;
        const accessToken = await auth.githubOAuth.exchangeCode(
          query.code,
          redirectUri,
        );
        const user = await auth.githubOAuth.fetchUser(accessToken);

        const sessionToken = encryptSession(
          {
            user,
            accessToken,
            exp: Date.now() + SESSION_TTL_MS,
          },
          auth.sessionSecret,
        );

        const sessionCookie = formatCookie(SESSION_COOKIE_NAME, sessionToken, {
          maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
          secure,
          httpOnly: true,
          sameSite: 'Lax',
          path: '/',
        });

        return reply
          .header('set-cookie', [clearStateCookie, sessionCookie])
          .redirect('/', REDIRECT_STATUS);
      } catch (error) {
        // Guardrail #2: log only the error message (never tokens or secrets).
        app.log.error(
          `GitHub OAuth callback failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        return reply
          .header('set-cookie', clearStateCookie)
          .redirect('/?authError=oauth_exchange_failed', REDIRECT_STATUS);
      }
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const origin = resolveOrigin(request, auth?.publicUrl);
    const clearSessionCookie = formatCookie(SESSION_COOKIE_NAME, '', {
      maxAgeSeconds: 0,
      secure: isSecureOrigin(origin),
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    });

    return reply.header('set-cookie', clearSessionCookie).send({ ok: true });
  });
}
