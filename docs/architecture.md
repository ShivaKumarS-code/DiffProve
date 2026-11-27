# Differential PR Verifier (GitHub App)

## Overview
- **Goal:** Deploy a hosted GitHub App that validates AI-authored (and human) pull requests using **differential verification**. Tests should fail on the **merge base plus the test-only patch** and pass on the **exact PR head**. Independent cloud sandboxes let DiffProve catch weak or non-reproducing tests before human review.
- **Research Basis:** *Teaching Agents to Code Reliably* (Oct 2026) and *SWE-Judge* (May 2026).
- **Primary Deliverable:** Hosted GitHub App + durable job worker + isolated Firecracker sandbox runner + verification dashboard.

---

## End-to-End Verification Pipeline

1. **Webhook Intake:** GitHub sends a `pull_request` (`opened`, `synchronize`, `reopened`) webhook. The API verifies the `X-Hub-Signature-256` HMAC and acknowledges the event only after durable BullMQ intake. The worker creates or recovers the check on the pinned PR head after claiming the job.
2. **Diff Fetching & Splitting:** The worker obtains GitHub's SHA-pinned three-dot comparison and merge base. It extracts the **Test-Only Patch** using repo-configured test globs (`test_*.py`, `*_test.py`, `*.test.ts`, `*.spec.ts`). It fetches the merge-base and head archives on the trusted host; it does not replay the full PR patch to construct the head.
3. **Sandbox Provisioning:** Run A and Run B use independent Firecracker microVMs (via E2B). Only the untouched merge base may install with approved registry egress. Run B starts offline and must be able to set up its dependencies from local files or a trusted cache seed. A cold cache or a dependency change that cannot be resolved offline produces an environment failure.
4. **Run A — Base State Verification:**
   - Materialize the pinned merge-base archive and prepare dependencies before applying any changes.
   - Close egress, then apply **only** the Test-Only Patch.
   - Execute the targeted test files (`pytest <changed_tests>` or `vitest run <changed_tests>`).
   - **Expected outcome:** `FAIL` (confirming the test actually reproduces the bug or asserts the new feature).
5. **Run B — Head State Verification:**
   - Materialize the pinned head archive into a clean workspace, without copying the base working tree into it.
   - Execute the exact same targeted test command.
   - **Expected outcome:** `PASS`.
6. **Verdict Matrix & GitHub Check Report:**

| Run A (Merge Base + Test Patch) | Run B (Exact PR Head) | Verdict | GitHub Check Conclusion |
| :--- | :--- | :--- | :--- |
| **FAIL** | **PASS** | Verified Fix / Valid Test, unless case evidence is mixed | `success` (Green) |
| **FAIL** | **PASS** | Mixed Test Evidence (some fail/pass and others pass/pass) | `failure` (Red) |
| **PASS** | **PASS** | Weak / Non-Reproducing Test | `failure` (Red) |
| **FAIL** | **FAIL** | Broken Implementation / Failing Test | `failure` (Red) |
| **SYNTAX / IMPORT ERROR** | **PASS** | New Symbol Test (Feature Addition) | `neutral` (Annotated) |
| **ERROR / TIMEOUT in either run** | | Sandbox / Env Setup Failure | `neutral` (Warning) |

Where supported, native runner reports link executed cases from the targeted changed test files by identity: fail/pass reproduces the regression, and pass/pass does not. This is execution evidence, not an inventory of every edited case; it can include unchanged cases in those files and miss cases that did not run. Missing, skipped or ambiguous results are not pass/fail evidence. Without usable case evidence, including for custom commands without a collector, the aggregate matrix still applies.

The worker completes the exact check with a Markdown verdict, clipped logs, and optional case evidence, and persists completed comparisons when PostgreSQL is configured. No-test, disabled and unavailable-runner paths end with a neutral check. On verification retry exhaustion, an independent BullMQ finalization job delivers a neutral conclusion with its own bounded retry policy and does not rerun verification. Redis and GitHub updates are not atomic, and stalled verification relies on a fallback handoff. A crash during that fallback, a failed handoff, or exhausted finalization retries can still require operator reconciliation.

---

## Component Architecture & Stack

| Component | Responsibility | Recommended Stack |
| :--- | :--- | :--- |
| **GitHub App Server** | Webhook HMAC verification and installation config | TypeScript, Fastify, Octokit |
| **Job Orchestrator** | Durable queuing, retry policies and worker-owned Check Run lifecycle | BullMQ (Redis), Octokit |
| **Sandbox Runner** | Independent Firecracker microVMs with network isolation | E2B SDK |
| **Env Snapshot Cache** | Trusted, pre-test base snapshots used only to seed dependency caches | E2B Snapshots |
| **Run History DB** | Installations, repo test configs, verification verdicts, log excerpts and optional case evidence | PostgreSQL |
| **Web Dashboard** | Repo onboarding, custom test commands, PR verification history & logs | Next.js + Tailwind CSS |

---

## Core Data Model

### PostgreSQL Tables
- **`installations`**: `id (uuid, pk)`, `github_installation_id (bigint, unique)`, `account_login (text)`, `created_at (timestamptz)`
- **`repositories`**: `id (uuid, pk)`, `installation_id (uuid, fk)`, `repo_full_name (text, unique)`, `language (enum: python, node)`, `test_command (text)`, `test_file_globs (text[])`, `enabled (bool)`
- **`env_snapshots`**: `id (uuid, pk)`, `repository_id (uuid, fk)`, `lockfile_hash (text)`, `sandbox_template_id (text)`, `last_used_at (timestamptz)`
- **`verification_runs`**: `id (uuid, pk)`, `repository_id (uuid, fk)`, `pr_number (int)`, `base_sha (text)`, `head_sha (text)`, `changed_test_files (text[])`, `run_a_status (text)`, `run_b_status (text)`, `verdict (text)`, `duration_ms (int)`, `run_a_log (text)`, `run_b_log (text)`, `case_evidence (nullable jsonb)`, `created_at (timestamptz)`. The additive migration leaves existing rows intact with no evidence.

---

## API & Interface Contracts

- **`POST /webhooks/github`** — Receives `pull_request` and `installation` events. Verified PR events are acknowledged after durable enqueue; intake does not create the check.
- **GitHub Check Run Output:** After claiming the durable job, the worker recovers or creates the check with a stable `external_id`, stores its ID in the job, and uses `PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}` for that exact ID. The summary includes the verdict, bounded case evidence when available, and collapsible logs. Stable IDs support retry recovery, not exactly-once delivery. Creation, lookup and terminal delivery depend on GitHub and Redis and require live smoke testing.
- **`GET /api/repos/:id/runs`** — Returns verification history with optional `caseEvidence` (`null` when unavailable): `reproducing`, `nonReproducing`, `totalCases`, and a preview of `{id, base, head}` results reported by the targeted runs. The whole-history `catchRate` remains `weakTestCount / totalRuns` (`null` for no runs); `mixedTestCount` is a separate total and mixed runs only count in the denominator.
- **`PATCH /api/repos/:id/config`** — Overrides auto-detected `test_command` or `test_file_globs`.

---

## Key Engineering Guardrails

1. **Strict Scope for v1:** Support only **Python (`pytest`)** and **TypeScript/JS (`vitest` / `jest`)** repositories with standard lockfiles. Auto-detect runner from `pyproject.toml` or `package.json`.
2. **Untrusted PR Security:** Keep Run A and Run B in independent VMs with public sandbox ports disabled. Allow only approved registry egress during dependency setup on the untouched merge base, then close egress before applying the patch or running tests. Run B has no outbound network access from boot, even during dependency setup. Never pass GitHub tokens or app secrets into either VM.
3. **Handle New-Feature `ImportError` Cleanly:** If a PR introduces a brand-new function or module, Run A (base commit + new test) will naturally fail with `ImportError` / `ModuleNotFoundError` / TS compile error. Classify that distinctly from an environment crash so valid feature PRs aren't falsely flagged.
4. **Snapshot Caching:** Only capture trusted base snapshots before applying the test patch or executing tests. Use them as dependency-cache seeds, never as a source of head files. Never snapshot a head run or reuse a post-test environment. The caches live under `/var/tmp/diffprove-packages`: npm, pnpm and Yarn data; pip, uv and Poetry caches; and, where available, a `wheels` directory for pip. The head still needs all required artifacts locally. A warmed pip HTTP cache is not a usable offline index on its own. Snapshot seeding requires E2B filesystem-only snapshot support on the project and a compatible template and envd. The runner never falls back to memory snapshots. If E2B returns `snapshot_filesystem_only_disabled`, enable that mode or supply the required offline dependencies through a trusted prewarmed template or local vendored artifacts.
5. **Optional Case Evidence:** Treat runner reports and case labels as untrusted input. Missing evidence cannot promote an individual case to pass or fail; displays bound case previews and render case labels as text.

---

## MVP Build Phases (Orchestrator Task Breakdown)

- **Phase 1 (GitHub App & Webhook Ingestion):** Register the GitHub App, verify webhook signatures, durably enqueue jobs and let the worker own Check Runs.
- **Phase 2 (Diff Splitter):** Build unified-diff parser that cleanly separates test-only hunks from implementation hunks and handles edge cases (deleted tests, pure-refactor PRs).
- **Phase 3 (E2B Differential Runner):** Run the merge base plus test patch and exact PR head in separate Firecracker VMs with pre-test base cache seeds and offline head execution.
- **Phase 4 (Verdict Reporting & Dashboard):** Map aggregate results and optional case evidence to GitHub Check Run reports and the Next.js history/config UI.
