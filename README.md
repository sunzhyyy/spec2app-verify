# Spec2App Verify (draft)

Spec2App Verify turns a natural-language requirement into a verified, data-driven mini app through a test-driven workflow. The principle is: tests define what done means.

**Status: Stage 2 engineering skeleton.** The core workflow is not implemented yet.

## Stack
React 18, TypeScript, Vite, Tailwind, shadcn/ui, Zod, Vitest. The app is static and client-side only. Data is stored in localStorage.

## Setup
```bash
pnpm install
cp .env.example .env   # optional; leave VITE_AI_ENDPOINT empty for Demo Mode
pnpm dev               # http://localhost:5173
```

## Commands
| Purpose | Command |
|---|---|
| Lint | `pnpm lint` |
| Type check | `pnpm typecheck` |
| Test | `pnpm test` |
| Build | `pnpm build` (output in `dist/`) |
| Preview build | `pnpm preview` |

## Structure
- `src/domain`: types and schemas
- `src/engine`: generators, verifier, repair, versioning (planned)
- `src/ai`: provider interface; Demo provider plus optional HTTP provider (planned)
- `src/renderer`: bounded components that draw the mini app (planned)
- `src/store`: persistence (planned)
- `src/pages`: routes
- `src/components/ui`: shadcn components
- `tests`: Vitest suites
- `.github/workflows/ci.yml`: CI (lint, typecheck, test, build)

## Security
No secrets are stored in the repo or the browser. Live AI is optional and goes through your own server endpoint.

## Deployment
Any static host (Vercel, Netlify, GitHub Pages) can serve `dist/`.

## Verification, persistence and export (Stage 3 §9–17)
- **Persistence**: projects are stored in `localStorage` under `spec2app-verify:v1:store`. The data is versioned (`schemaVersion: 1`), checked with Zod when loaded, and passed through a migration step first. If stored data is corrupted or uses a newer version, the app starts safely with a warning. **Reset Spec2App data** removes only this app's keys. Data stays in this browser only.
- **Versions**: each generation creates a `candidate` version with a parent link. Only a candidate that passes verification becomes `stable`. A failed candidate never replaces the stable version.
- **Verification**: `src/engine/verify.ts` runs 21 deterministic checks. Each result is passed, failed or blocked, with its expected result, observed result, evidence, version and timestamp. Automatic repair is not implemented.
- **Export**: **Export JSON** checks the export against `ExportSchema` and blocks it if it would include any credential or endpoint.

## Stage 4 – Bounded repair

After a failed verification, the workspace shows a **Bounded repair** panel. The default is Deterministic Repair Mode, which makes no model call.

1. **Propose repair.** This is available only when the latest report on the current candidate has failed or blocked checks, the approved tests are unchanged, the definition is valid, and fewer than 2 repairs have been applied.
2. **Review.** Before anything changes, the panel shows the diagnosed cause, the affected definition paths, the expected improvement and the risk.
3. **Apply as new candidate.** This creates a new version with `parentVersionId` pointing to the failed candidate. The stable version is never overwritten.
4. **Run repair reverification.** This runs a targeted set of checks: the ones that failed before the repair, checks mapped to the changed paths, the mandatory core regression set (`CORE_REGRESSION_IDS`), and their prerequisites. Checks that are not re-run are listed as carried forward.

Proposals are rejected before they are applied if any of the following is true: they are malformed, they change acceptance tests or their references, they touch paths unrelated to the failing checks or outside the repairable scope, they contain executable code, they remove required fields, actions, filters or metrics, or they fail schema validation.

After reverification, each repair gets one of these results: `repaired`, `improved`, `no_improvement`, `repeated_failure` (same failure signature), `regression`, or `limit_reached`. Every result except `repaired` and `improved` stops the workflow. Limits: 2 repair attempts per approved baseline generation and 5 AI-assisted calls per project. An optional HTTP provider (`requestHttpRepair`) sends only a compact context and no secrets. Repair history is saved to localStorage and included in the validated JSON export (schema v2, `repair` section).

Tests: `tests/repair.test.ts` covers scenarios A–E: constraint repair, bounded stop, regression, test immutability, and malformed or unavailable provider output.

### Stage 4.1 – Repair safety invariants

- Accepting a repair proposal only means it is within repair scope. It does **not** mean the candidate is valid or stable.
- Incremental repair candidates may remain incomplete or failing. They stay `candidate`, and `stableVersionId` does not change.
- Stable promotion requires all of the following: `AppDefinitionSchema` validity, complete capability invariants (`missingCapabilities()` is empty: fields, actions, filters, metrics, layout sections, test references, empty and no-results states), VC-22, and every selected affected and core-regression check passing.
- Each export attempt records `proposalAccepted`, `candidateStructurallyValid`, `candidateVerificationPassed` and `promotedToStable` separately. Stop reports also include the remaining failed and blocked checks, the last stable version and a suggested next action.
- A maximum of two repairs can be applied per approved baseline. The public Demo uses deterministic repair with no model call.
- The browser-level repair interaction has not been validated manually. Coverage comes from automated tests (`tests/repair.test.ts`, `tests/repairSafety.test.ts`).
