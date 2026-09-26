# Spec2App Verify

Turn a natural-language requirement into a test-defined, interactive mini application with deterministic verification and bounded repair.

**Principle: tests define what done means.**

- Public demo: `<PUBLIC_DEMO_URL>` (to be added)
- **The public Demo requires no login and no API key.** It runs in *Deterministic Demo Mode – no model call*, using an embedded AI benchmark example so you can review the whole workflow without calling an external model.

## Workflow
Define requirement → Review acceptance tests → Generate application → Verify behavior → Repair within limits → Promote a stable version

1. **Define requirement.** Write the requirement, then analyze it into purpose, user, fields, rules and actions.
2. **Review acceptance tests.** Edit the proposed tests, then approve them. Once approved, tests are locked.
3. **Generate application.** A Zod-validated app definition is created and drawn by a bounded renderer. It becomes a `candidate` version.
4. **Verify behavior.** Deterministic checks run against the candidate. Each check records its expected result, observed result and evidence.
5. **Repair within limits.** If verification fails, you review a proposed repair before it is applied as a new candidate.
6. **Promote a stable version.** Only a candidate that passes every required check becomes `stable`.

## Demo instructions (for reviewers)
1. Open the app and click **New project**. The benchmark tracker requirement is pre-filled.
2. Click **Analyze requirement**, review the tests, then **Approve test set**.
3. **Generate application**, try out the tracker (add, edit, delete, filter), then **Run verification**.
4. Look at the verification report and the Current/Stable version badges. **Export JSON** downloads the validated evidence.
5. The repair flow appears after a failed verification. The fault scenarios that lead to repair are covered by the automated tests (see below).

## Core capabilities
- Requirement analysis and editable acceptance tests with an approval gate
- Schema-validated app definition drawn by trusted, bounded components (no generated code is executed)
- Deterministic verification with passed, failed or blocked results and evidence
- Version history with parent links and separate candidate and stable lifecycles
- Bounded, user-reviewed repair
- Validated JSON export with an allow-list

## Verification model
`src/engine/verify.ts` runs deterministic checks (VC-01 … VC-22). These cover fields, validation rules, create/update/delete, filters, metrics, empty and no-results states, acceptance-test references and required capabilities (VC-22). A result can be passed, failed or blocked (a prerequisite failed). A failed candidate never replaces the stable version.

## Bounded-repair rules
- Repairs require user review, are limited to **two applied attempts** per approved baseline and can never overwrite the last stable version unless all required checks pass.
- A proposal is rejected before it is applied if it is malformed, changes approved tests or their references, touches paths outside the failing scope, contains executable content, removes required capabilities or fails schema validation.
- Reverification re-runs the failed checks, the checks mapped to the changed paths and a mandatory core regression set.
- A candidate is promoted only if it passes schema validation, has no missing capabilities (`missingCapabilities()` is empty) and passes all selected checks.
- Results are `repaired`, `improved`, `no_improvement`, `repeated_failure`, `regression` or `limit_reached`. A stop report lists the reason, remaining failed and blocked checks, the last stable version and a suggested next action.
- The Demo uses deterministic repair with no model call.

## Technology stack
React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, Zod, Vitest and GitHub Actions CI. The app is a static, client-side-only single-page app.

## Local setup
```bash
pnpm install --frozen-lockfile
cp .env.example .env   # optional; leave VITE_AI_ENDPOINT empty for Demo Mode
pnpm dev               # http://localhost:5173
```

## Test and build
| Purpose | Command |
|---|---|
| Lint | `pnpm lint` |
| Type check | `pnpm typecheck` |
| Test | `pnpm test` |
| Build | `pnpm build` (output in `dist/`) |
| Preview build | `pnpm preview` |

Any static host can serve `dist/`.

## Security boundaries
- No secrets are stored in the repository or in the browser. The Demo needs no key.
- Generated definitions are data, not code. Only trusted renderer components are used.
- Exports are schema-validated and allow-listed, and are blocked if they would contain credentials or endpoints.
- `Reset Spec2App data` removes only this app's localStorage keys.

## Persistence limitation
Projects are stored in this browser using versioned localStorage (`spec2app-verify:v1:store`, validated with Zod when loaded). Cross-device synchronization is not supported. If stored data is corrupted or uses a newer version, the app starts safely and shows a warning.

## Known limitations
- Demo Mode covers one embedded benchmark domain. No live AI provider is configured in the public Demo.
- Repair scenarios are covered by deterministic automated tests (`tests/repair.test.ts`, `tests/repairSafety.test.ts`). The repair interaction has not been manually tested end-to-end in a browser.
- Single user, single browser. There is no authentication or collaboration.
- This is a review demo, not a production-hardened service.

## Structure
`src/domain` (schemas and workflow), `src/engine` (generation, verification, repair, export), `src/renderer` (bounded UI), `src/store` (persistence), `src/ai` (mode selection), `src/pages`, `tests`, `.github/workflows/ci.yml`.
