/**
 * Next.js configuration for the DiffProve dashboard.
 *
 * The app is a pure client-side consumer of the Fastify service's `/api/*`
 * endpoints (docs/architecture.md, "API & Interface Contracts"), and calls them
 * SAME-ORIGIN through the runtime App Router proxy at
 * `src/app/api/[...path]/route.ts`. That avoids both browser CORS preflights
 * and port collisions (the dashboard and the service each bind their own port),
 * and keeps the service URL server-side.
 *
 * `API_PROXY_URL` (or `API_PROXY_HOSTPORT`, e.g. from Render's `hostport`
 * service link) is read at Next RUNTIME on the server (never exposed to the
 * browser); it defaults to `http://localhost:3000`. To call the service
 * directly from the browser instead, set NEXT_PUBLIC_API_URL — that path is
 * cross-origin and then requires CORS on the service.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
