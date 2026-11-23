# Differential PR Verifier (GitHub App)

## Overview
- **Goal:** Deploy a hosted GitHub App that validates AI-authored (and human) pull requests using **differential verification**. Instead of trusting an agent's self-reported passing tests, it runs the PR's new/modified tests in an isolated cloud sandbox against both the **reverted base commit** (must fail) and the **patched head commit** (must pass)—catching weak, tautological, or hallucinated tests before human code review.
- **Research Basis:** *Teaching Agents to Code Reliably* (Oct 2026) and *SWE-Judge* (May 2026).
- **Primary Deliverable:** Hosted GitHub App + durable job worker + isolated Firecracker sandbox runner + verification dashboard.

---

## End-to-End Verification Pipeline

1. **Webhook Intake:** GitHub sends a `pull_request` (`opened`, `synchronize`, `reopened`) webhook. The API verifies the `X-Hub-Signature-256` HMAC, immediately posts a `queued` GitHub Check Run on the PR's `head_sha`, and enqueues a verification job.
2. **Diff Fetching & Splitting:** The worker pulls the unified PR diff via GitHub API and splits changed files into two patches using repo-configured test globs (`test_*.py`, `*_test.py`, `*.test.ts`, `*.spec.ts`):
   - **Test-Only Patch:** Only additions/edits to test files.
   - **Full PR Patch:** Complete implementation + test changes.
   - *Short-Circuit:* If no test files were added or modified, the Check Run completes immediately with a `neutral` status (*"No test changes detected to verify"*).
3. **Sandbox Provisioning:** The worker boots an ephemeral Firecracker microVM (via E2B) from a cached environment snapshot keyed by the repo's lockfile hash (`uv.lock`, `poetry.lock`, `requirements.txt`, `package-lock.json`, `pnpm-lock.yaml`). Outbound network egress is disabled before executing untrusted repo code.
4. **Run A — Base State Verification (Reverted Implementation):**
   - Check out `base_sha`.
   - Apply **only** the Test-Only Patch.
   - Execute the targeted test files (`pytest <changed_tests>` or `vitest run <changed_tests>`).
   - **Expected outcome:** `FAIL` (confirming the test actually reproduces the bug or asserts the new feature).
5. **Run B — Head State Verification (Patched Implementation):**
   - Reset working tree and apply the **Full PR Patch** (or check out `head_sha`).
   - Execute the exact same targeted test command.
   - **Expected outcome:** `PASS`.
6. **Verdict Matrix & GitHub Check Report:**

| Run A (Base + New Tests) | Run B (Head + New Tests) | Verdict | GitHub Check Status |
| :--- | :--- | :--- | :--- |
| **FAIL** | **PASS** | Verified Fix / Valid Test | `success` (Green) |
| **PASS** | **PASS** | Weak / Non-Reproducing Test | `failure` (Red) |
| **FAIL** | **FAIL** | Broken Implementation / Failing Test | `failure` (Red) |
| **SYNTAX / IMPORT ERROR** | **PASS** | New Symbol Test (Feature Addition) | `neutral` or `success` (Annotated) |
| **ERROR / TIMEOUT** | **ERROR / TIMEOUT** | Sandbox / Env Setup Failure | `neutral` (Warning) |

The worker updates the GitHub Check Run with a structured Markdown summary, clipped stdout/stderr excerpts from Run A and Run B, and saves the record to PostgreSQL.

---

## Component Architecture & Stack

| Component | Responsibility | Recommended Stack |
| :--- | :--- | :--- |
| **GitHub App Server** | Webhook HMAC verification, Octokit Check Runs API, installation config | TypeScript (Next.js API / Fastify) or Python (FastAPI) |
| **Job Orchestrator** | Durable queuing, per-repo concurrency caps, retry policies | BullMQ (Redis) or Inngest |
| **Sandbox Runner** | Isolated Firecracker microVMs with egress blocking & snapshot forking | E2B (`@e2b/code-interpreter` or `e2b-code-interpreter`) |
| **Env Snapshot Cache** | Pre-built dependency snapshots keyed by `(repo_id, lockfile_sha256)` | E2B Templates / Snapshots + Redis metadata |
| **Run History DB** | Installations, repo test configs, verification verdicts, log excerpts | PostgreSQL |
| **Web Dashboard** | Repo onboarding, custom test commands, PR verification history & logs | Next.js + Tailwind CSS |

---

## Core Data Model

### PostgreSQL Tables
- **`installations`**: `id (uuid, pk)`, `github_installation_id (bigint, unique)`, `account_login (text)`, `created_at (timestamptz)`
- **`repositories`**: `id (uuid, pk)`, `installation_id (uuid, fk)`, `repo_full_name (text, unique)`, `language (enum: python, node)`, `test_command (text)`, `test_file_globs (text[])`, `enabled (bool)`
- **`env_snapshots`**: `id (uuid, pk)`, `repository_id (uuid, fk)`, `lockfile_hash (text)`, `sandbox_template_id (text)`, `last_used_at (timestamptz)`
- **`verification_runs`**: `id (uuid, pk)`, `repository_id (uuid, fk)`, `pr_number (int)`, `base_sha (text)`, `head_sha (text)`, `changed_test_files (text[])`, `run_a_status (text)`, `run_b_status (text)`, `verdict (text)`, `duration_ms (int)`, `run_a_log (text)`, `run_b_log (text)`, `created_at (timestamptz)`

---

## API & Interface Contracts

- **`POST /webhooks/github`** — Receives `pull_request` and `installation` events; verifies HMAC signature and dispatches queue jobs.
- **GitHub Check Run Output:** Uses `POST /repos/{owner}/{repo}/check-runs` and `PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}` with structured `output.title`, `output.summary`, and collapsible Run A / Run B logs.
- **`GET /api/repos/:id/runs`** — Returns verification history and weak-test catch rate for the dashboard.
- **`PATCH /api/repos/:id/config`** — Overrides auto-detected `test_command` or `test_file_globs`.

---

## Key Engineering Guardrails

1. **Strict Scope for v1:** Support only **Python (`pytest`)** and **TypeScript/JS (`vitest` / `jest`)** repositories with standard lockfiles. Auto-detect runner from `pyproject.toml` or `package.json`.
2. **Untrusted PR Security:** Disable outbound internet access inside the E2B sandbox *after* dependency installation and *before* running `pytest`/`vitest`, and never inject GitHub tokens or app secrets into the sandbox environment variables.
3. **Handle New-Feature `ImportError` Cleanly:** If a PR introduces a brand-new function or module, Run A (base commit + new test) will naturally fail with `ImportError` / `ModuleNotFoundError` / TS compile error. Classify that distinctly from an environment crash so valid feature PRs aren't falsely flagged.
4. **Lockfile Snapshot Caching:** Cache installed dependency environments by lockfile hash so repeat PR runs execute in under 30 seconds instead of reinstalling packages every run.

---

## MVP Build Phases (Orchestrator Task Breakdown)

- **Phase 1 (GitHub App & Webhook Ingestion):** Register GitHub App, verify webhook signatures, post `queued` Check Runs, and enqueue jobs via BullMQ/Inngest.
- **Phase 2 (Diff Splitter):** Build unified-diff parser that cleanly separates test-only hunks from implementation hunks and handles edge cases (deleted tests, pure-refactor PRs).
- **Phase 3 (E2B Differential Runner):** Implement Firecracker sandbox execution for Run A and Run B with network egress disabled during test execution and lockfile-keyed snapshot caching.
- **Phase 4 (Verdict Reporting & Dashboard):** Map Run A/B exit codes to rich GitHub Check Run reports and build the Next.js history/config UI.