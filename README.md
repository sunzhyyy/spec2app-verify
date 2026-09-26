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
