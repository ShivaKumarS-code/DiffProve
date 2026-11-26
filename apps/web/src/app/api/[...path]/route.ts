import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'cookie',
  'x-forwarded-host',
  'x-forwarded-proto',
] as const;

const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'location',
  'cache-control',
] as const;

/**
 * Resolve the upstream DiffProve API base URL at request time.
 */
function resolveBackendBaseUrl(): string {
  const proxyUrl = process.env.API_PROXY_URL?.trim();
  if (proxyUrl) {
    return proxyUrl.replace(/\/+$/, '');
  }

  const hostPort = process.env.API_PROXY_HOSTPORT?.trim();
  if (hostPort) {
    return `http://${hostPort}`;
  }

  return 'http://localhost:3000';
}

/**
 * Forward same-origin `/api/*` requests to the upstream Fastify service at runtime,
 * preserving cookies and OAuth 302 redirects without caching.
 */
async function proxy(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const { path } = await context.params;
  const targetUrl = `${resolveBackendBaseUrl()}/api/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  if (!headers.has('x-forwarded-host')) {
    const host = request.headers.get('host');
    if (host) {
      headers.set('x-forwarded-host', host);
    }
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json(
      { message: 'upstream DiffProve API is unreachable' },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      responseHeaders.set(name, value);
    }
  }
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append('set-cookie', cookie);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PATCH,
  proxy as PUT,
  proxy as DELETE,
};
