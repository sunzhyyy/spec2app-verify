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
