'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import './globals.css';

/**
 * Root layout: static chrome only (no data access).
 *
 * It is a client component like the rest of the dashboard — the app never
 * renders on the server beyond the initial HTML pass — so navigation and
 * styling share one runtime. The document title is a React-rendered `<title>`
 * rather than the `metadata` export, which Next forbids in client components.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        {/* React 19 hoists document metadata to <head>, so client components
            can still title the page without the server-only metadata export. */}
        <title>DiffProve — verification dashboard</title>
        <meta
          name="description"
          content="Repository onboarding, PR verification history, and test configuration for the DiffProve GitHub App."
        />
        <header className="border-b border-neutral-800 bg-neutral-900/60">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-6 py-4">
            <Link
              href="/"
              className="text-lg font-semibold tracking-tight text-neutral-100 transition-colors hover:text-white"
            >
              DiffProve
            </Link>
            <span className="text-xs text-neutral-400">
              Differential PR verification
            </span>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>

        <footer className="mx-auto max-w-5xl px-6 pb-8 text-xs text-neutral-500">
          Each run executes the PR&apos;s changed tests twice: against the reverted
          base commit (Run A, expected to fail) and the patched head commit
          (Run B, expected to pass).
        </footer>
      </body>
    </html>
  );
}
