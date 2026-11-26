# Plan: Obsidian-Cobalt Aurora & Bottom Dock UI Redesign (`apps/web`)

## Aesthetic Direction (from user reference image)
- **Atmospheric Backdrop:** Deep pitch-black upper canvas (`#04040a`) transitioning smoothly into an electric cobalt, indigo, and violet-periwinkle bottom horizon glow with soft vertical volumetric light rays.
- **Surfaces:** Translucent smoked-glass cards (`rgba(13, 16, 32, 0.72)` with `backdrop-filter: blur(22px)` and subtle top/edge hairline highlights).
- **Navigation Chrome:** Minimal transparent top masthead (`DiffProve` brand mark left, active dot-marked mode switcher center, dark-glass auth status right) paired with a fixed bottom dock bar (active section label left, centered circular icon buttons with bright white active circle, right-side quick config link & user account pill).
- **Data-Driven Overview Panel:** Hero smoked-glass score panel pairing a large light tabular metric (`Weak-test catch rate` / `% enabled`), clean right-aligned metric rows, and a segmented vertical-tick spectrum bar driven strictly by real repo/run data.

## Architecture Mapping (`docs/architecture.md`)
All edits stay inside **Phase 4 (Web Dashboard)** (`apps/web/src/`). API contracts in `apps/web/src/lib/api.ts`, proxy routes in `apps/web/src/app/api/[...path]/route.ts`, and backend services remain untouched.

## Independent Pieces
1. **Atmosphere, Tokens, Header & Bottom Dock (`apps/web/src/app/globals.css`, `apps/web/src/app/layout.tsx`)**
   - Define dark-mode tokens, fixed `.obsidian-aurora` layered background gradients + vertical light beams, and `.glass-panel` / `.glass-control` classes.
   - Replace light header/footer with transparent top masthead and fixed bottom dock bar integrating auth state (`getAuthSession`, `logout`) and interactive dock navigation.
   - Verify: `.\apps\web\node_modules\.bin\tsc --noEmit -p apps/web/tsconfig.json`
2. **Repositories Index Page (`apps/web/src/app/page.tsx`)**
   - Redesign `/` with the smoked-glass repo coverage overview card (real enabled coverage + segmented tick bar), dark-glass search/status controls, glass repository table, and dark-glass SignInGate / ErrorBanner / Skeleton.
   - Verify: `.\apps\web\node_modules\.bin\tsc --noEmit -p apps/web/tsconfig.json`
3. **Repository Detail & Configuration (`apps/web/src/app/repos/[id]/page.tsx`, `apps/web/src/components/RepoConfigForm.tsx`)**
   - Redesign `/repos/[id]` with the featured Weak-Test Catch Rate smoked-glass overview panel (large catch-rate KPI, real-run segmented outcome tick bar, right-side metric rows), dark-glass verdict history & filter, and dark-glass `RepoConfigForm`.
   - Verify: `.\apps\web\node_modules\.bin\tsc --noEmit -p apps/web/tsconfig.json`
4. **Verification Run Ledger Cards & Verdict Badges (`apps/web/src/components/RunCard.tsx`, `apps/web/src/components/VerdictBadge.tsx`)**
   - Restyle `VerdictBadge` with dark-surface high-contrast translucent status pills and `RunCard` with dark frosted `<details>` log drawers, crisp tabular metadata, and legible monospace logs.
   - Verify: `.\apps\web\node_modules\.bin\tsc --noEmit -p apps/web/tsconfig.json`
