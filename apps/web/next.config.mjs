/**
 * Next.js configuration for the DiffProve dashboard.
 *
 * The app is a pure client-side consumer of the Fastify service's `/api/*`
 * endpoints (docs/architecture.md, "API & Interface Contracts"), but it calls
 * them SAME-ORIGIN: the rewrite below proxies `/api/*` through this Next.js
 * server to the service. That avoids both browser CORS preflights and port
 * collisions (the dashboard and the service each bind their own port), and it
 * keeps the service URL server-side.
 *
 * `API_PROXY_URL` is read at Next BUILD/RUNTIME on the server (never exposed
 * to the browser); it defaults to the service's local default port. To call
 * the service directly from the browser instead, set NEXT_PUBLIC_API_URL —
 * that path is cross-origin and then requires CORS on the service.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    const serviceUrl = process.env.API_PROXY_URL ?? 'http://localhost:3000';
    return [
      {
        source: '/api/:path*',
        destination: `${serviceUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
