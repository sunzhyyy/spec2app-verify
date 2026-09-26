# AI Webpage Generator

A general AI webpage generator that turns a natural-language idea into runnable HTML, CSS and JavaScript, previews it in a sandboxed iframe and preserves projects and versions across refreshes.

- **Live Demo:** _<preview URL placeholder – set after publishing the brief-rebuild preview>_
- **GitHub Repository:** _<repository URL>_
- **Short Demo Guide:** open the app → click an example prompt → **Generate** (30–120 s) → interact with the page in the App Viewer → refresh the browser → the project, prompts, versions and in-app data are restored → type a follow-up change → **Apply change** creates v2 (v1 stays selectable).

## Workflow
Prompt → server endpoint → model writes `index.html`, `styles.css`, `script.js`, `README.md` as JSON → server validates → browser validates again → `PageResource` is created and saved → `previewHtml` runs in `<iframe sandbox="allow-scripts">`.

## Server-side generation
Two interchangeable endpoints share the same prompt and response schema:

| Deployment | Route | Code | Provider |
|---|---|---|---|
| Atoms Cloud (workspace validation only; not part of this repository or the public deployment) | `POST /api/v1/generate/page` | Atoms workspace environment only, returns the same validated response schema | OpenAI-compatible provider if `AI_API_KEY` + `AI_BASE_URL` are set, otherwise the Atoms AI Hub model (`AI_MODEL`, default `gpt-5.4`) |
| Vercel | `POST /api/generate` | `api/generate.ts`, `src/gen/provider.ts` | OpenAI-compatible (`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`) |

The request contains only `prompt`, compact `history` (earlier prompts) and `currentFiles` (for follow-ups). The response contains `title, summary, indexHtml, stylesCss, scriptJs, readme, generationNotes` plus `generationMode: "live"`, `providerInvoked: true`, `provider` and `receivedPrompt`. Malformed JSON, missing or empty files, Markdown fences and oversized files are rejected with a coded error (`timeout`, `quota_exhausted`, `provider_unavailable`, `malformed_json`, `schema_invalid`, `missing_files`, `empty_content`). No automatic retries are made.

## Live versus fallback
A version is `live` only when the server confirms that it invoked the provider for the exact prompt that was sent and the files passed validation. The viewer shows “awaiting render” until the iframe reports `PAGE_READY` for that exact version. Fallback examples (todo, mortgage, portfolio) appear only after a failure, require a click, are labelled **“Saved fallback example – no live model call”**, and are stored with `generationMode: "fallback"`.

## PageResource
`id, projectId, version, prompt, title, summary, indexHtml, stylesCss, scriptJs, readme, previewHtml, createdAt, generationMode, provider, kind (initial|followup), parentVersionId, renderVerified, generationNotes` — see `src/gen/core.ts`.

## Sandbox and persistence bridge
- The iframe uses `sandbox="allow-scripts"` only, with no `allow-same-origin`, so the generated page has an opaque origin and cannot read the parent DOM, host storage or credentials, and cannot navigate the parent. A CSP in `previewHtml` sets `connect-src 'none'`.
- The generated page uses `await window.AppStorage.load()` and `window.AppStorage.save(state)`. Under the hood these send `{type:"LOAD_STATE"|"SAVE_STATE", projectId, versionId, …}` messages to the parent. The host checks that `event.source` is the current iframe, validates the message with a strict Zod schema, rejects payloads over 100 KB, and stores or returns state only for that project and version. The host replies with `STATE_LOADED`.

## Host persistence
localStorage key `ai-webpage-generator.workspace`, `schemaVersion: 1`: `{ projects[{prompts, versions(PageResource), selectedVersionId, createdAt, updatedAt}], selectedProjectId, appState{"projectId:versionId": {data, savedAt}} }`. Corrupted or incompatible data is backed up under `…corrupt-<ts>` and a fresh workspace is started. Data is stored only in this browser; there is no cross-device sync.

## Follow-up editing
After v1 exists, the input sends the instruction together with the current files. The new PageResource becomes v(n+1) with `parentVersionId`, and earlier versions stay in the Version selector.

## Local setup
```
pnpm install --frozen-lockfile
pnpm run lint && npx tsc -p tsconfig.app.json --noEmit && pnpm test && pnpm run build
```

## Environment variables (server only; never `VITE_*`)
`AI_API_KEY`, `AI_BASE_URL` (for example `https://api.openai.com/v1`), `AI_MODEL`, and optionally `AI_TIMEOUT_MS` / `AI_TIMEOUT_SECONDS`. Frontend build switch (not a secret): `VITE_GENERATION_TARGET=vercel` makes the UI call `/api/generate`.

## Vercel deployment
Framework: Vite (React 18 + TS); functions: Node runtime (`api/generate.ts`). Install command: `pnpm install --frozen-lockfile`. Build command: `pnpm run build`. Output directory: `dist`. Set `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` and `VITE_GENERATION_TARGET=vercel` for the **Preview** environment and deploy the `brief-rebuild` branch as a preview. Production promotion is manual (“Promote to Production”) and should happen only after the P0 checks pass on the preview URL.

## Known limitations
- The Vercel path has only been tested with a mocked provider; it has not been deployed.
- Generation takes 30–120 s, and the output quality depends on the model.
- Generated pages cannot make network requests or load remote scripts.
- Persistence is per browser.
