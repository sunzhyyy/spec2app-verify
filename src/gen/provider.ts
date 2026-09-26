/**
 * Provider-side prompt and response parsing shared by the Vercel function (api/generate.ts).
 * Mirrors app/backend/services/page_generator.py, which serves the Atoms Cloud deployment.
 */
import { GeneratedFilesSchema, MAX_FILE_CHARS, type GeneratedFiles } from './core';

export const SYSTEM_PROMPT = `You are a senior front-end engineer who generates complete, runnable, single-page web applications from a natural-language idea.
Return ONLY one JSON object (no prose, no Markdown) with these string fields: title, summary, indexHtml, stylesCss, scriptJs, readme, generationNotes.
Rules:
- indexHtml: a complete HTML5 document. Include <link rel="stylesheet" href="styles.css"> in <head> and <script src="script.js"></script> at the end of <body>. Do not put inline <script> or <style> blocks in indexHtml.
- stylesCss: all CSS. scriptJs: all JavaScript as plain ES2020 (no modules, imports, frameworks, CDNs, external URLs or network requests).
- The page runs in a sandboxed iframe (sandbox="allow-scripts", opaque origin). localStorage, sessionStorage, cookies, alert, confirm, prompt, window.open and top-level navigation are unavailable. Show messages inline in the DOM.
- Persist user data ONLY through the host bridge: \`const saved = await window.AppStorage.load();\` returns the previously saved JSON value or null, and \`window.AppStorage.save(state)\` stores a JSON-serialisable value under 100 KB. Call save after every data change. Initialise inside an async function and render defaults when load returns null.
- Forms: listen for the 'submit' event and call event.preventDefault(); the host dispatches submit events for submit buttons and Enter key presses.
- Implement every requested interaction with real working logic (adding, editing, deleting, filtering, calculating, validation, visible UI updates). No placeholder content, lorem ipsum or TODOs.
- Responsive, accessible (labels, focus states, sufficient contrast) and visually polished.
- Never wrap any field value in Markdown code fences. readme is Markdown describing the page and how to use it. generationNotes is 1-3 sentences about key decisions.
- For a follow-up edit you receive the current files: return the COMPLETE updated files (not diffs) and keep existing working features unless the request changes them.
- Keep the total output compact (well under 12000 tokens).`;

export type GenerationErrorCode =
  | 'timeout'
  | 'provider_timeout'
  | 'quota_exhausted'
  | 'provider_unauthorized'
  | 'provider_payment_required'
  | 'provider_forbidden'
  | 'provider_not_found'
  | 'provider_rate_limited'
  | 'provider_http_error'
  | 'provider_unavailable'
  | 'malformed_json'
  | 'schema_invalid'
  | 'missing_files'
  | 'empty_content'
  | 'invalid_request'
  | 'network'
  | 'not_configured';

export class GenerationFailure extends Error {
  constructor(
    public code: GenerationErrorCode,
    message: string,
    public providerInvoked: boolean,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const FILE_NAMES: Record<keyof GeneratedFiles, string> = { indexHtml: 'index.html', stylesCss: 'styles.css', scriptJs: 'script.js', readme: 'README.md' };

export interface GenerateRequestBody {
  prompt: string;
  history?: string[];
  currentFiles?: GeneratedFiles | null;
}

export function buildMessages(body: GenerateRequestBody) {
  const parts: string[] = [];
  const history = (body.history ?? []).slice(-6);
  if (history.length) parts.push(`Earlier prompts in this project (oldest first):\n${history.map((h) => `- ${h.slice(0, 500)}`).join('\n')}`);
  if (body.currentFiles) {
    for (const [field, name] of Object.entries(FILE_NAMES)) {
      parts.push(`<current-file name="${name}">\n${body.currentFiles[field as keyof GeneratedFiles]}\n</current-file>`);
    }
    parts.push(`Follow-up change request: ${body.prompt}`);
  } else {
    parts.push(`Webpage request: ${body.prompt}`);
  }
  return [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: parts.join('\n\n') },
  ];
}

const stripFence = (v: string) => {
  const t = v.trim();
  const m = t.match(/^```[\w-]*\s*\n([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : t;
};

export interface ParsedGeneration extends GeneratedFiles {
  title: string;
  summary: string;
  generationNotes: string;
}

/** Accepts provider content as an object, a JSON string or a fenced JSON string; parses at most once. */
/** Normalizes provider message.content exactly once: object -> validate; string -> strip one fence, JSON.parse once, validate. */
export function normalizeGeneratedContent(raw: unknown): ParsedGeneration {
  if (raw !== null && typeof raw !== 'object' && typeof raw !== 'string') throw new GenerationFailure('schema_invalid', 'The model response was not a JSON object.', true);
  return parseProviderContent(raw);
}

export function parseProviderContent(raw: unknown): ParsedGeneration {
  let data: unknown;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw)) throw new GenerationFailure('schema_invalid', 'The model response was not a JSON object.', true);
    data = raw;
  } else {
    const text = stripFence(typeof raw === 'string' ? raw : '');
    if (!text) throw new GenerationFailure('empty_content', 'The model returned an empty response.', true);
    if (!text.startsWith('{')) throw new GenerationFailure('schema_invalid', 'The model response was not a JSON object.', true);
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new GenerationFailure('schema_invalid', `The model returned malformed JSON (${(e as Error).message}).`, true);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GenerationFailure('schema_invalid', 'The model response was not a JSON object.', true);
  const obj = data as Record<string, unknown>;
  const missing = Object.entries(FILE_NAMES)
    .filter(([f]) => !(f in obj))
    .map(([, n]) => n);
  if (missing.length) throw new GenerationFailure('missing_files', `Missing generated files: ${missing.join(', ')}.`, true);
  for (const f of ['title', 'summary', 'generationNotes']) {
    if (typeof obj[f] !== 'string') throw new GenerationFailure('schema_invalid', `Field '${f}' must be a string.`, true);
  }
  const files: Record<string, string> = {};
  for (const f of Object.keys(FILE_NAMES)) {
    if (typeof obj[f] !== 'string') throw new GenerationFailure('schema_invalid', `Field '${f}' must be a string.`, true);
    files[f] = stripFence(obj[f] as string);
    if (!files[f]) throw new GenerationFailure('empty_content', `Generated ${FILE_NAMES[f as keyof GeneratedFiles]} is empty.`, true);
    if (files[f].length > MAX_FILE_CHARS) throw new GenerationFailure('schema_invalid', `Generated ${FILE_NAMES[f as keyof GeneratedFiles]} is too large.`, true);
  }
  const checked = GeneratedFilesSchema.safeParse(files);
  if (!checked.success) throw new GenerationFailure('schema_invalid', checked.error.issues.map((i) => i.message).join('; '), true);
  const title = (obj.title as string).trim().slice(0, 120);
  if (!title) throw new GenerationFailure('schema_invalid', 'Generated title is empty.', true);
  return {
    ...checked.data,
    title,
    summary: (obj.summary as string).trim().slice(0, 600),
    generationNotes: (obj.generationNotes as string).trim().slice(0, 1000),
  };
}

/** Unwraps the `{ response: {...} }` envelope. A string body means the route returned non-JSON (e.g. the SPA's HTML). */
export function unwrapGenerationBody(body: unknown): unknown {
  if (typeof body === 'string') throw new GenerationFailure('schema_invalid', 'The generation endpoint returned text instead of JSON. Check that /api/generate is deployed and VITE_GENERATION_TARGET is set.', true);
  if (body && typeof body === 'object' && 'response' in body) {
    const r = (body as { response: unknown }).response;
    if (typeof r === 'string') throw new GenerationFailure('schema_invalid', 'The generation endpoint double-serialized its response (response was a string).', true);
    return r;
  }
  return body;
}
