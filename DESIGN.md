# Spec2App Verify — Design

## Direction & Layout
An engineering workbench that is calm, dense and trustworthy, not a marketing page. It has three panes: a 240px project sidebar on the left, a fluid workflow column in the centre, and a 420px preview and evidence pane on the right. On screens narrower than 1024px the panes stack and the sidebar becomes a drawer. The maximum width is full-bleed with 24px gutters. Avoid gradients, 3D art, glassmorphism and fake charts.

## Tokens
- Background #F4F5F7, surface #FFFFFF, border #D9DCE1
- Text #1A1D23 / #4B5260 / #6B7280
- Active (blue) #1D5FD1; verified/stable (green) #1F8A4C; warning (amber) #B7791F; failure (red) #C53030
- Fonts: IBM Plex Sans (UI), IBM Plex Mono (IDs, JSON, evidence). Body 14/20, headings 20–24/600.
- Spacing on a 4px scale. Radii: inputs 6px, cards 8px. Borders 1px with no heavy shadows.

## Shared Patterns & States
- Status badges (pending, approved, rejected, pass, fail, blocked, stable, candidate), stepper, data table, form with inline errors, empty states, confirm dialog.
- Motion lasts 150ms ease-out and is limited to hover and focus.
- Focus ring is 2px #1D5FD1. Targets are at least 40px. Contrast meets WCAG AA.

## Media
No imagery. This is an operational tool.

## Verification & persistence design
Candidate → verify → stable (pass) or verification_failed (candidate kept, stable unchanged). Reports are append-only and evidence-based. Storage is versioned with a migration boundary; reset is project-scoped. Exports are Zod-validated and secret-free.

## Stage 4 – Bounded repair design

- Engine: `src/engine/repair.ts` (pure, deterministic). UI: `src/pages/RepairPanel.tsx`.
- Failure signature: `F:<failed ids>|B:<blocked ids>|P:<definition path categories>`. It contains no timestamps or IDs.
- Repair is always a deliberate review: propose → review → apply → reverify. Repairs are never applied automatically, and they never promote a version unless targeted reverification passes with no regressions.
- New check VC-22 checks that the required actions, filters, layout sections and empty/no-results states are present.
- Stage 4.1: proposal scope validation (no removal of existing capabilities) is separate from the promotion gate (full invariants on the final definition). VC-22 is part of the core regression set.
