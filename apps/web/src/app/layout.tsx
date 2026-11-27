'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { getAuthSession, logout, type AuthSession } from '../lib/api';
import './globals.css';

function GitHubGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

/**
 * Root layout: static chrome only (no data access).
 *
 * It is a client component like the rest of the dashboard (the app never
 * renders on the server beyond the initial HTML pass), so navigation and
 * styling share one runtime. The document title is a React-rendered `<title>`
 * rather than the `metadata` export, which Next forbids in client components.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const isRepoDetail = pathname.startsWith('/repos/');

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
      <body className="relative flex min-h-screen flex-col bg-[var(--bg-obsidian)] font-sans text-[var(--ink-primary)] antialiased">
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

        <div className="obsidian-aurora" aria-hidden="true" />

        <header className="relative z-20">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-5 sm:px-6">
            <Link
              href="/"
              className="flex shrink-0 items-center gap-2.5 text-[1.0625rem] font-bold tracking-tight text-white transition-colors duration-150 hover:text-slate-200"
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                className="shrink-0 text-white"
              >
                <path
                  d="M4 12h7m0 0l4-5h5m-9 5l4 5h5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M17.5 4.5L20 7l-2.5 2.5M17.5 14.5L20 17l-2.5 2.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>DiffProve</span>
            </Link>

            <nav
              aria-label="Primary"
              className="hidden items-center gap-5 text-[0.8125rem] sm:flex"
            >
              <Link
                href="/"
                className={`inline-flex items-center gap-1.5 font-medium transition-colors duration-150 ${
                  !isRepoDetail ? 'text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                {!isRepoDetail ? (
                  <span className="text-[0.625rem] text-white" aria-hidden="true">
                    •
                  </span>
                ) : null}
                <span>Overview</span>
              </Link>
              {isRepoDetail ? (
                <a
                  href="#history"
                  className="inline-flex items-center gap-1.5 font-medium text-white transition-colors duration-150"
                >
                  <span className="text-[0.625rem] text-white" aria-hidden="true">
                    •
                  </span>
                  <span>Verification</span>
                </a>
              ) : (
                <Link
                  href="/#repositories"
                  className="font-medium text-slate-400 transition-colors duration-150 hover:text-white"
                >
                  Repositories
                </Link>
              )}
            </nav>

            <div className="flex shrink-0 items-center gap-2.5 text-[0.8125rem]">
              {session?.oauthEnabled ? (
                session.user !== null ? (
                  <>
                    <span className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.06] p-1 font-medium text-white backdrop-blur-md sm:py-1 sm:pr-3 sm:pl-1.5">
                      {session.user.avatarUrl !== null ? (
                        <img
                          src={session.user.avatarUrl}
                          alt=""
                          width={22}
                          height={22}
                          className="h-[22px] w-[22px] rounded-full border border-white/20 object-cover"
                        />
                      ) : (
                        <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-white/15 text-[0.6875rem] font-semibold text-white">
                          {session.user.login.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span className="hidden max-w-[180px] truncate sm:inline">
                        @{session.user.login}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={signingOut}
                      onClick={() => void handleSignOut()}
                      className="rounded-full border border-white/12 bg-white/[0.06] px-3 py-1.5 font-medium text-slate-200 backdrop-blur-md transition-colors duration-150 hover:border-white/25 hover:bg-white/[0.14] hover:text-white disabled:opacity-50"
                    >
                      Sign out
                    </button>
                  </>
                ) : (
                  <a
                    href="/api/auth/login"
                    className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.08] px-3.5 py-1.5 font-medium text-white backdrop-blur-md transition-colors duration-150 hover:border-white/30 hover:bg-white/[0.14]"
                  >
                    <GitHubGlyph />
                    <span>Sign in with GitHub</span>
                  </a>
                )
              ) : (
                <span className="hidden rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[0.75rem] text-[var(--ink-muted)] sm:inline">
                  Base vs. head proof
                </span>
              )}
            </div>
          </div>
        </header>

        <main className="relative z-10 mx-auto w-full max-w-6xl flex-1 px-4 pt-4 pb-12 sm:px-6">
          {children}
        </main>
      </body>
    </html>
  );
}
