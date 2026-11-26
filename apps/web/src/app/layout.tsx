'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

import { getAuthSession, logout, type AuthSession } from '../lib/api';
import './globals.css';

/**
 * Root layout: static chrome only (no data access).
 *
 * It is a client component like the rest of the dashboard (the app never
 * renders on the server beyond the initial HTML pass), so navigation and
 * styling share one runtime. The document title is a React-rendered `<title>`
 * rather than the `metadata` export, which Next forbids in client components.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getAuthSession()
      .then((data) => {
        if (!cancelled) {
          setSession(data);
        }
      })
      .catch(() => {
        // Ignore session check failures so offline API never breaks the masthead.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSignOut(): Promise<void> {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    try {
      await logout();
    } catch {
      // Navigate back to `/` even on failure so session state re-syncs cleanly.
    } finally {
      window.location.assign('/');
    }
  }

  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col bg-[var(--bg-canvas)] font-sans text-[var(--ink-primary)] antialiased">
        {/* React 19 hoists document metadata and font links to <head>, so client
            components can title the page and load stylesheets without build-time fetches. */}
        <title>DiffProve: Verification Dashboard</title>
        <meta
          name="description"
          content="Repository onboarding, PR verification history, and test configuration for the DiffProve GitHub App."
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap"
        />

        <header className="border-b border-[var(--border-hairline)] bg-[var(--bg-surface)]">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
            <Link
              href="/"
              className="flex shrink-0 items-center gap-2.5 text-lg font-bold tracking-tight text-[var(--ink-primary)] transition-colors hover:text-[var(--accent)]"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
                className="shrink-0"
              >
                <rect x="2" y="2" width="7" height="7" rx="1.5" fill="#94A3B8" />
                <rect x="2" y="11" width="7" height="7" rx="1.5" fill="#DC2626" />
                <rect x="11" y="2" width="7" height="16" rx="1.5" fill="#059669" />
              </svg>
              <span>DiffProve</span>
            </Link>
            <nav
              aria-label="Primary"
              className="flex shrink-0 items-center gap-4 text-[0.8125rem] sm:gap-5"
            >
              <Link
                href="/"
                className="font-medium text-[var(--ink-secondary)] transition-colors duration-150 hover:text-[var(--ink-primary)]"
              >
                Repositories
              </Link>
              {session?.oauthEnabled ? (
                session.user !== null ? (
                  <div className="flex items-center gap-3 sm:gap-4">
                    <span className="flex items-center gap-2 font-medium text-[var(--ink-primary)]">
                      {session.user.avatarUrl !== null ? (
                        <img
                          src={session.user.avatarUrl}
                          alt=""
                          width={20}
                          height={20}
                          className="h-5 w-5 rounded-full border border-[var(--border-hairline)] object-cover"
                        />
                      ) : null}
                      <span className="max-w-[140px] truncate sm:max-w-none">
                        @{session.user.login}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={signingOut}
                      onClick={() => void handleSignOut()}
                      className="text-[0.8125rem] font-medium text-[var(--ink-secondary)] transition-colors duration-150 hover:text-[var(--ink-primary)] disabled:opacity-50"
                    >
                      Sign out
                    </button>
                  </div>
                ) : (
                  <a
                    href="/api/auth/login"
                    className="font-medium text-[var(--accent)] transition-colors duration-150 hover:text-[var(--accent-hover)]"
                  >
                    Sign in with GitHub
                  </a>
                )
              ) : (
                <span className="hidden text-[var(--ink-muted)] sm:inline">
                  Base vs. head test proof
                </span>
              )}
            </nav>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>

        <footer className="border-t border-[var(--border-hairline)]">
          <div className="mx-auto max-w-6xl px-4 py-5 text-[0.8125rem] text-[var(--ink-muted)] sm:px-6">
            Each run executes changed PR tests twice: Run A applies the test patch to the base commit (expected fail), and Run B applies the full patch on head (expected pass).
          </div>
        </footer>
      </body>
    </html>
  );
}
