/**
 * GitHub App authentication wiring.
 *
 * Two concerns live here:
 *  - `createOctokit` returns a plain, auth-less Octokit transport. Installation
 *    tokens are attached per request (see `src/github/checks.ts`), so the
 *    transport itself never holds credentials.
 *  - `createAppAuthenticator` builds the App JWT / installation-token factory on
 *    top of `@octokit/auth-app`. Its optional third parameter exists so tests
 *    can fake the token endpoint instead of touching the network.
 *
 * Guardrail #2: never log the private key or any token produced here.
 */

import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/core';

/** Plain transport Octokit — no auth strategy; tokens are attached per request. */
export function createOctokit(): Octokit {
  return new Octokit();
}

/** Installation access token as returned by the GitHub App auth flow. */
export interface InstallationToken {
  token: string;
}

export type AppAuth = (options: { type: 'app' }) => Promise<{ token: string }>;

/**
 * Transport signature used by `@octokit/auth-app` to call the GitHub API.
 * Production uses the library default; tests inject a fake so no request ever
 * leaves the process.
 */
export type AppAuthRequest = (
  route: string,
  parameters?: Record<string, unknown>,
) => Promise<{ status: number; data: unknown }>;

/** Port: exchanges an installation id for an access token. */
export interface InstallationTokenSource {
  installation(installationId: number): Promise<InstallationToken>;
}

export type AppAuthenticator = AppAuth & InstallationTokenSource;

type CreateAppAuthOptions = Parameters<typeof createAppAuth>[0];

/**
 * Creates an `@octokit/auth-app` authenticator bound to the App credentials.
 *
 * `@octokit/auth-app` caches installation tokens internally until shortly
 * before they expire, so this wrapper deliberately adds no cache of its own.
 */
export function createAppAuthenticator(
  appId: string,
  privateKey: string,
  request?: AppAuthRequest,
): AppAuthenticator {
  const options: CreateAppAuthOptions = { appId, privateKey };
  if (request) {
    options.request = request as unknown as CreateAppAuthOptions['request'];
  }

  const auth = createAppAuth(options);

  return Object.assign(
    // App JWT (`{ type: 'app' }`). The token is a short-lived signed JWT, not a
    // secret in the installation-token sense, but it still must not be logged.
    async (appAuthOptions: { type: 'app' }): Promise<{ token: string }> => {
      const { token } = await auth(appAuthOptions);
      return { token };
    },
    {
      installation: async (installationId: number): Promise<InstallationToken> => {
        const { token } = await auth({ type: 'installation', installationId });
        return { token };
      },
    },
  );
}
