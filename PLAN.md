# Plan: Reliable differential verification

## Decisions

- Durable queue intake comes before GitHub side effects. A worker owns the check lifecycle: recover by a stable GitHub `external_id`, persist the check ID in BullMQ job data before running verification, and complete that exact check without replacing an existing conclusion. Checks begin when workers claim jobs, rather than during webhook intake. Exhaustion reporting uses a separately retried finalization job; Redis and GitHub still do not share an atomic transaction.
- GitHub's three-dot test patch is applied to its pinned merge base in Run A. Run B uses the exact archived PR head, not a replayed full patch.
- Independent microVMs. Only the untouched merge base may provision with a restricted registry allowlist. Close egress before patching or testing it. The head runs offline from creation, including dependency setup. Reuse a pre-test base snapshot only as a trusted dependency-cache seed, never a head snapshot, and do not merge old repo files into the head.
- Use native runner reports to compare individual test cases. Missing, skipped, ambiguous, or unsupported case evidence does not count as a pass/fail. Mixed evidence (both reproducing and non-reproducing cases) is a distinct failing check when the aggregate would otherwise verify the fix.

## Independent pieces

1. **Check lifecycle** — architecture “End-to-End Verification Pipeline” steps 1/6 and “API & Interface Contracts.” Own GitHub check adapters, queue worker/enqueuer, webhook/Fastify intake and server wiring. Verify deduplication, exact check completion, and retry exhaustion with targeted tests.
2. **Pinned source selection and pipeline integration** — architecture “End-to-End Verification Pipeline” steps 2/4/5/6. Own diff port, GitHub compare adapter, and differential handler. Verify merge-base and head archive refs, terminal skips, and mixed evidence integration with pipeline tests.
3. **Isolated sandbox execution** — architecture “End-to-End Verification Pipeline” steps 3–5 and “Key Engineering Guardrails.” Own runner/adapter/shared runner types and sandbox tests. Verify VM separation, provenance-aware cache use, and fail-closed network behavior with fakes.
4. **Case evidence and verdict policy** — architecture “End-to-End Verification Pipeline” step 6 and “Key Engineering Guardrails.” Own structured runner report normalization, differential case comparison, and Markdown/verdict policy. Verify with representative native report fixtures, including incomplete and hostile-shaped input.
5. **History, dashboard, and operator docs** — architecture “Core Data Model,” “API & Interface Contracts,” and “Key Engineering Guardrails.” Own the optional case-evidence DB migration/persistence/dashboard rendering and documentation. Verify backward compatibility and build the dashboard.

After reviewing each diff, run the full test suite, lint, typecheck, service build and dashboard build. Record which Redis/PostgreSQL and live GitHub/E2B checks were not exercised.
