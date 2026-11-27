/**
 * Typed client for the DiffProve service API.
 *
 * docs/architecture.md, "API & Interface Contracts": the dashboard consumes
 * `GET /api/repos`, `GET /api/repos/:id/runs` (verification history + weak-test
 * catch rate) and `PATCH /api/repos/:id/config` (override `test_command` /
 * `test_file_globs`).
 *
 * The row types below mirror the service's JSON rather than importing from it:
 * the dashboard and the Fastify service are separate deployables and the
 * service modules are Node-only, so importing them would couple the two apps
 * and pull server code into the browser bundle.
 *
 * Error policy: every failure becomes an `ApiError` carrying an HTTP status and
 * a human-readable message — non-2xx responses keep the service's own
 * `message`, an unreachable service reports status 0, and an unexpected
 * payload reports 502. Pages render `error.message` verbatim, which is how the
 * service's 503 "database not configured" message reaches the setup hint.
 */

/**
 * Base URL of the DiffProve service.
 *
 * Defaults to SAME-ORIGIN (`''`): the dashboard's own Next.js server proxies
 * `/api/*` to the service via `next.config.mjs` rewrites (server-side
 * `API_PROXY_URL`), which needs no CORS and avoids port collisions. Set
 * `NEXT_PUBLIC_API_URL` only to call the service directly — that path is
 * cross-origin and then requires CORS on the service.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

/** Repository languages supported in v1 (architecture guardrail 1). */
export type RepoLanguage = 'python' | 'node';

/** A row from the `repositories` table, as serialised by the API. */
export interface RepoRow {
  id: string;
  installationId: string | null;
  repoFullName: string;
  language: RepoLanguage | null;
  testCommand: string | null;
  testFileGlobs: string[] | null;
  enabled: boolean;
  createdAt: string;
}

type CaseStatus = 'pass' | 'fail' | 'skipped' | 'unknown';

export interface CaseEvidence {
  reproducing: number;
  nonReproducing: number;
  totalCases: number;
  /** A bounded preview, not necessarily all cases counted in the totals. */
  cases: { id: string; base: CaseStatus; head: CaseStatus }[];
}

/** A row from the `verification_runs` table, as serialised by the API. */
export interface RunRow {
  id: string;
  repositoryId: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  changedTestFiles: string[];
  runAStatus: string;
  runBStatus: string;
  verdict: string;
  durationMs: number;
  runALog: string;
  runBLog: string;
  caseEvidence: CaseEvidence | null;
  createdAt: string;
}

/** Aggregate returned alongside a repository's run history. */
export interface RunHistorySummary {
  /** Newest first, as ordered by the service. */
  runs: RunRow[];
  totalRuns: number;
  weakTestCount: number;
  /** Whole-history count; null when talking to an older service. */
  mixedTestCount: number | null;
  /** Fraction flagged `weak-test` (not `mixed-test`); null when no runs exist. */
  catchRate: number | null;
}

/** Body of `GET /api/repos/:id/runs`. */
export interface RepoRunsResponse extends RunHistorySummary {
  repository: RepoRow;
}

/** Body of `PATCH /api/repos/:id/config`; `null` clears an override. */
export interface RepoConfigPatch {
  testCommand?: string | null;
  testFileGlobs?: string[] | null;
  enabled?: boolean;
}

/** Signed-in GitHub user returned by `GET /api/auth/session`. */
export interface AuthUser {
  id: number;
  login: string;
  avatarUrl: string | null;
}

/** Current OAuth configuration and signed-in session from `GET /api/auth/session`. */
export interface AuthSession {
  oauthEnabled: boolean;
  user: AuthUser | null;
}

/** Reported when the response body is not the shape this client expects. */
const BAD_GATEWAY_STATUS = 502;

/** Reported when the request never reached the service (DNS, refused, CORS). */
const UNREACHABLE_STATUS = 0;

const MAX_CASE_PREVIEW = 20;
const MAX_CASE_LABEL_LENGTH = 240;
/** The service currently stores at most 100 entries; allow some version skew. */
const MAX_CASE_ENTRIES = 200;

/**
 * Every failed API call surfaces as this error. `status` is the HTTP status, or
 * 0 when the service was unreachable; 404 lets pages render "not found".
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Normalises a thrown value into an `ApiError` so UI code can read `status`. */
export function toApiError(caught: unknown): ApiError {
  if (caught instanceof ApiError) {
    return caught;
  }
  if (caught instanceof Error && caught.message.trim().length > 0) {
    return new ApiError(UNREACHABLE_STATUS, caught.message);
  }
  return new ApiError(UNREACHABLE_STATUS, 'the DiffProve API request failed');
}

/** JSON object as parsed from a response body; values stay `unknown` until checked. */
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows to `unknown[]`, avoiding `Array.isArray`'s broad element typing. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function unexpected(field: string): ApiError {
  return new ApiError(
    BAD_GATEWAY_STATUS,
    `the DiffProve API returned an unexpected value for "${field}"`,
  );
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new ApiError(
      BAD_GATEWAY_STATUS,
      `the DiffProve API returned an unexpected ${label}`,
    );
  }
  return value;
}

function requireArray(source: JsonObject, field: string): unknown[] {
  const value = source[field];
  if (!isUnknownArray(value)) {
    throw unexpected(field);
  }
  return value;
}

function readString(source: JsonObject, field: string): string {
  const value = source[field];
  if (typeof value !== 'string') {
    throw unexpected(field);
  }
  return value;
}

function readNullableString(source: JsonObject, field: string): string | null {
  const value = source[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw unexpected(field);
  }
  return value;
}

function readNumber(source: JsonObject, field: string): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw unexpected(field);
  }
  return value;
}

function readNullableNumber(source: JsonObject, field: string): number | null {
  const value = source[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw unexpected(field);
  }
  return value;
}

function readBoolean(source: JsonObject, field: string): boolean {
  const value = source[field];
  if (typeof value !== 'boolean') {
    throw unexpected(field);
  }
  return value;
}

function toStringArray(value: unknown[], field: string): string[] {
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw unexpected(field);
    }
    items.push(item);
  }
  return items;
}

function readStringArray(source: JsonObject, field: string): string[] {
  const value = source[field];
  if (!isUnknownArray(value)) {
    throw unexpected(field);
  }
  return toStringArray(value, field);
}

function readNullableStringArray(source: JsonObject, field: string): string[] | null {
  const value = source[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (!isUnknownArray(value)) {
    throw unexpected(field);
  }
  return toStringArray(value, field);
}

function readLanguage(value: unknown): RepoLanguage | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value === 'python' || value === 'node') {
    return value;
  }
  throw unexpected('language');
}

function parseRepoRow(value: unknown): RepoRow {
  const source = requireObject(value, 'repository row');
  return {
    id: readString(source, 'id'),
    installationId: readNullableString(source, 'installationId'),
    repoFullName: readString(source, 'repoFullName'),
    language: readLanguage(source['language']),
    testCommand: readNullableString(source, 'testCommand'),
    testFileGlobs: readNullableStringArray(source, 'testFileGlobs'),
    enabled: readBoolean(source, 'enabled'),
    createdAt: readString(source, 'createdAt'),
  };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCaseStatus(value: unknown): value is CaseStatus {
  return value === 'pass' || value === 'fail' || value === 'skipped' || value === 'unknown';
}

function selectCasePreview(cases: CaseEvidence['cases']): CaseEvidence['cases'] {
  if (cases.length <= MAX_CASE_PREVIEW) {
    return cases;
  }

  // Reserve one representative of each transition, then fill in original order.
  const selected = new Set<number>();
  for (const base of ['fail', 'pass'] as const) {
    const index = cases.findIndex((row) => row.base === base && row.head === 'pass');
    if (index !== -1) {
      selected.add(index);
    }
  }
  for (let index = 0; selected.size < MAX_CASE_PREVIEW; index += 1) {
    selected.add(index);
  }
  return cases.filter((_, index) => selected.has(index));
}

/** Older or malformed optional evidence should never break the history page. */
function parseCaseEvidence(value: unknown): CaseEvidence | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const { reproducing, nonReproducing, totalCases, cases } = value;
  if (
    !isCount(reproducing) ||
    !isCount(nonReproducing) ||
    !isCount(totalCases) ||
    reproducing + nonReproducing > totalCases ||
    !isUnknownArray(cases) ||
    cases.length > totalCases ||
    cases.length > MAX_CASE_ENTRIES
  ) {
    return null;
  }

  const decoded: CaseEvidence['cases'] = [];
  for (const item of cases) {
    if (!isJsonObject(item)) {
      return null;
    }
    const { id, base, head } = item;
    if (typeof id !== 'string' || id.length === 0 || !isCaseStatus(base) || !isCaseStatus(head)) {
      return null;
    }
    const label =
      id.length > MAX_CASE_LABEL_LENGTH ? `${id.slice(0, MAX_CASE_LABEL_LENGTH - 1)}…` : id;
    decoded.push({ id: label, base, head });
  }
  return { reproducing, nonReproducing, totalCases, cases: selectCasePreview(decoded) };
}

function parseRunRow(value: unknown): RunRow {
  const source = requireObject(value, 'verification run');
  return {
    id: readString(source, 'id'),
    repositoryId: readString(source, 'repositoryId'),
    prNumber: readNumber(source, 'prNumber'),
    baseSha: readString(source, 'baseSha'),
    headSha: readString(source, 'headSha'),
    changedTestFiles: readStringArray(source, 'changedTestFiles'),
    runAStatus: readString(source, 'runAStatus'),
    runBStatus: readString(source, 'runBStatus'),
    verdict: readString(source, 'verdict'),
    durationMs: readNumber(source, 'durationMs'),
    runALog: readString(source, 'runALog'),
    runBLog: readString(source, 'runBLog'),
    caseEvidence: parseCaseEvidence(source['caseEvidence']),
    createdAt: readString(source, 'createdAt'),
  };
}

function parseAuthUser(value: unknown): AuthUser | null {
  if (value === null) {
    return null;
  }
  const source = requireObject(value, 'auth user');
  return {
    id: readNumber(source, 'id'),
    login: readString(source, 'login'),
    avatarUrl: readNullableString(source, 'avatarUrl'),
  };
}

/** Response text, or `''` when the body could not be read at all. */
async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Parses a JSON body, returning `null` for empty or malformed payloads. */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed;
  } catch {
    return null;
  }
}

/** Prefers the service's `{ message }` body, falling back to the HTTP status. */
function messageFromBody(body: unknown, status: number): string {
  if (isJsonObject(body) && typeof body['message'] === 'string') {
    const message = body['message'].trim();
    if (message.length > 0) {
      return message;
    }
  }
  return `the DiffProve API responded with HTTP ${status}`;
}

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    // `cache: 'no-store'` keeps run history and config fresh after a save, and
    // `credentials: 'same-origin'` ensures session cookies are always sent.
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'same-origin',
      headers,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(
      UNREACHABLE_STATUS,
      `could not reach the DiffProve service at ${API_BASE || 'this origin'}: is it running?`,
    );
  }

  const body = parseJson(await readBodyText(response));

  if (!response.ok) {
    throw new ApiError(response.status, messageFromBody(body, response.status));
  }

  return body;
}

/** `GET /api/repos` — every repository the GitHub App is installed on. */
export async function getRepos(): Promise<RepoRow[]> {
  const body = requireObject(await requestJson('/api/repos'), 'repository list');
  return requireArray(body, 'repos').map(parseRepoRow);
}

/**
 * `GET /api/repos/:id/runs?limit=…` — history (newest first) plus the
 * weak-test catch rate. `limit` defaults to the dashboard's page size.
 */
export async function getRepoRuns(id: string, limit = 50): Promise<RepoRunsResponse> {
  const path = `/api/repos/${encodeURIComponent(id)}/runs?limit=${String(limit)}`;
  const body = requireObject(await requestJson(path), 'run history');
  const mixedTestCount = body['mixedTestCount'];

  return {
    repository: parseRepoRow(body['repository']),
    runs: requireArray(body, 'runs').map(parseRunRow),
    totalRuns: readNumber(body, 'totalRuns'),
    weakTestCount: readNumber(body, 'weakTestCount'),
    mixedTestCount: isCount(mixedTestCount) ? mixedTestCount : null,
    catchRate: readNullableNumber(body, 'catchRate'),
  };
}

/** `PATCH /api/repos/:id/config` — updates overrides and returns the fresh row. */
export async function patchRepoConfig(id: string, patch: RepoConfigPatch): Promise<RepoRow> {
  const body = requireObject(
    await requestJson(`/api/repos/${encodeURIComponent(id)}/config`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
    'updated repository row',
  );
  return parseRepoRow(body['repository']);
}

/** `GET /api/auth/session`: returns OAuth status and the signed-in user if any. */
export async function getAuthSession(): Promise<AuthSession> {
  const body = requireObject(await requestJson('/api/auth/session'), 'auth session');
  return {
    oauthEnabled: readBoolean(body, 'oauthEnabled'),
    user: parseAuthUser(body['user']),
  };
}

/** `POST /api/auth/logout`: clears the session cookie on the service. */
export async function logout(): Promise<void> {
  await requestJson('/api/auth/logout', { method: 'POST' });
}
