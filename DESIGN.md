# Design – AI Webpage Generator

## Product
You describe a webpage application in natural language. A server-side AI model writes `index.html`, `styles.css`, `script.js` and `README.md`. The result runs inside a sandboxed iframe in the App Viewer. Projects, prompts, versions and in-app data persist across browser refreshes. No login is required.

## Layout
Three columns on desktop:
- **Projects:** "+ New Project" and the saved project list.
- **Generator:** the prompt input, example prompts, progress, errors and prompt history.
- **App Viewer:** a version selector, the live/fallback label, file tabs, Refresh preview, Expand viewer, and the iframe.

On narrow screens the columns stack and the viewer is at least 80vh tall. Expand viewer hides the first two columns.

## Generation flow
1. Prompt: free text. Example buttons only prefill the input.
2. The request goes to `POST /api/v1/generate/page` (Atoms Cloud) or `POST /api/generate` (Vercel). It carries `{prompt, history, currentFiles?}`.
3. **Provider boundary:** only the server calls the model. On Atoms Cloud this is the AI Hub (`gpt-5.4`) or an OpenAI-compatible provider configured with `AI_API_KEY`, `AI_BASE_URL` and `AI_MODEL`. The Vercel function uses an OpenAI-compatible provider with the same variables. The key never reaches the client bundle, the response or the generated page.
4. The model returns JSON: `title, summary, indexHtml, stylesCss, scriptJs, readme, generationNotes`. The server rejects fences, malformed JSON, missing or empty files and oversized files. It returns a coded error (`timeout`, `quota_exhausted`, `provider_unavailable`, `malformed_json`, `schema_invalid`, `missing_files`, `empty_content`). The browser validates the response again with Zod.
5. A **PageResource** is created: `id, projectId, version, prompt, title, summary, indexHtml, stylesCss, scriptJs, readme, previewHtml, createdAt, generationMode, provider, kind, parentVersionId, renderVerified, generationNotes`. `previewHtml` combines the three files with a CSP and the storage bridge.

## Live versus fallback
A version is `live` only when the server reports `providerInvoked: true` for the exact prompt that was sent (`receivedPrompt`) and the files passed validation. The version is marked `renderVerified` when the iframe posts `PAGE_READY` for that version. After a failure, the user can explicitly choose a saved fallback example. It is labelled "Saved fallback example – no live model call" and stored as `fallback`.

## Follow-up editing and versions
After v1 exists, the input sends a follow-up instruction together with the current files. The result becomes v(n+1) with `parentVersionId`. Earlier versions stay available in the selector. A failed generation never replaces the last valid version.

## Sandbox and persistence bridge
- The iframe uses `sandbox="allow-scripts"` without `allow-same-origin`, so the generated page has an opaque origin. The CSP includes `connect-src 'none'`.
- Generated code calls `window.AppStorage.load()` and `save(state)`, which send `LOAD_STATE` and `SAVE_STATE` messages through postMessage.
- The host accepts a message only when it comes from the current iframe and passes the Zod schema, with a 100 KB limit. It replies `STATE_LOADED`. State is keyed by `projectId:versionId`.

## Workspace storage
localStorage key `ai-webpage-generator.workspace`, `schemaVersion: 1`. It holds projects, prompts, versions, the selected project and version, and appState. Corrupted data is backed up and reset.

## Security limitations
- Generated code is untrusted. It is isolated by the sandbox and CSP, but it can still use CPU or show misleading content inside the frame.
- Persistence is per browser and has no sync.
- There is no rate limiting on the endpoints beyond the provider's own quota.
