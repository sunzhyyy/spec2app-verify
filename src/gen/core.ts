import { z } from 'zod';

export const MAX_FILE_CHARS = 60_000;
export const MAX_STATE_BYTES = 100_000;
export const IFRAME_SANDBOX = 'allow-scripts';
export const FALLBACK_LABEL = 'Saved fallback example – no live model call';

const fileText = (name: string) =>
  z
    .string()
    .trim()
    .min(1, `${name} is empty`)
    .max(MAX_FILE_CHARS, `${name} is too large`);

const codeFile = (name: string) => fileText(name).refine((v) => !v.includes('```'), `${name} contains Markdown fences`);

export const GeneratedFilesSchema = z.object({
  indexHtml: codeFile('index.html').refine((v) => /<[a-zA-Z][^>]*>/.test(v), 'index.html has no HTML elements'),
  stylesCss: codeFile('styles.css'),
  scriptJs: codeFile('script.js'),
  readme: fileText('README.md'),
});
export type GeneratedFiles = z.infer<typeof GeneratedFilesSchema>;

export const GenerationResponseSchema = GeneratedFilesSchema.extend({
  title: z.string().trim().min(1).max(120),
  summary: z.string().max(600),
  generationNotes: z.string().max(1000),
  generationMode: z.literal('live'),
  providerInvoked: z.literal(true),
  provider: z.string().min(1).max(120),
  receivedPrompt: z.string(),
  requestId: z.string().max(64).optional(),
  durationMs: z.number().optional(),
});
export type GenerationResponse = z.infer<typeof GenerationResponseSchema>;

export const PageResourceSchema = GeneratedFilesSchema.extend({
  id: z.string().min(1).max(64),
  projectId: z.string().min(1).max(64),
  version: z.number().int().positive(),
  prompt: z.string(),
  title: z.string(),
  summary: z.string(),
  generationNotes: z.string(),
  previewHtml: z.string(),
  createdAt: z.string(),
  generationMode: z.enum(['live', 'fallback']),
  provider: z.string(),
  kind: z.enum(['initial', 'followup']),
  parentVersionId: z.string().nullable(),
  renderVerified: z.boolean(),
});
export type PageResource = z.infer<typeof PageResourceSchema>;

/** A result may be labelled live only if the server confirms it invoked the provider for this exact prompt. */
export function validateLiveResponse(raw: unknown, sentPrompt: string): { ok: true; data: GenerationResponse } | { ok: false; message: string } {
  const parsed = GenerationResponseSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join('.') || 'response'}: ${i.message}`).join('; ') };
  if (parsed.data.receivedPrompt !== sentPrompt) return { ok: false, message: 'Server echoed a different prompt than the one sent.' };
  return { ok: true, data: parsed.data };
}

const escapeClosingTags = (code: string) => code.replace(/<\/(script|style)/gi, '<\\/$1');
const jsString = (v: string) => JSON.stringify(v).replace(/</g, '\\u003c');

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
  "img-src data: https:; font-src data: https://fonts.gstatic.com; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** Script injected before the generated script.js: the only host API exposed to generated code. */
export function bridgeScript(projectId: string, versionId: string): string {
  return `(function(){var P=${jsString(projectId)},V=${jsString(versionId)},pending={},n=0;
try{window.localStorage;}catch(e){var mem={};var s={getItem:function(k){return k in mem?mem[k]:null},setItem:function(k,v){mem[k]=String(v)},removeItem:function(k){delete mem[k]},clear:function(){mem={}}};try{Object.defineProperty(window,'localStorage',{value:s});}catch(_){}}
window.addEventListener('message',function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||d.type!=='STATE_LOADED'||d.projectId!==P||d.versionId!==V||!pending[d.requestId])return;var r=pending[d.requestId];delete pending[d.requestId];r(d.payload===undefined?null:d.payload);});
window.AppStorage=Object.freeze({projectId:P,versionId:V,load:function(){return new Promise(function(res){var id='r'+(++n);pending[id]=res;window.parent.postMessage({type:'LOAD_STATE',projectId:P,versionId:V,requestId:id},'*');setTimeout(function(){if(pending[id]){delete pending[id];res(null);}},3000);});},save:function(state){window.parent.postMessage({type:'SAVE_STATE',projectId:P,versionId:V,payload:state},'*');}});
function fire(f){if(!f)return;if(f.reportValidity&&!f.reportValidity())return;f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}
document.addEventListener('click',function(e){var b=e.target&&e.target.closest&&e.target.closest('button,input[type=submit]');if(!b||!b.form)return;var t=(b.getAttribute('type')||'submit').toLowerCase();if(t!=='submit')return;e.preventDefault();fire(b.form);},true);
document.addEventListener('keydown',function(e){var el=e.target;if(e.key!=='Enter'||!el||el.tagName!=='INPUT'||!el.form)return;e.preventDefault();fire(el.form);},true);
window.addEventListener('load',function(){window.parent.postMessage({type:'PAGE_READY',projectId:P,versionId:V},'*');});})();`;
}

/** Assemble a self-contained preview document from the generated files. */
export function assemblePreviewHtml(files: Pick<GeneratedFiles, 'indexHtml' | 'stylesCss' | 'scriptJs'>, projectId: string, versionId: string): string {
  let html = files.indexHtml
    .replace(/<link\b[^>]*href=["']?(?:\.\/)?styles\.css["']?[^>]*>/gi, '')
    .replace(/<script\b[^>]*src=["']?(?:\.\/)?script\.js["']?[^>]*>\s*<\/script>/gi, '');
  if (!/<html[\s>]/i.test(html)) {
    html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${html}</body></html>`;
  }
  if (!/<head[\s>]/i.test(html)) html = html.replace(/<html([^>]*)>/i, '<html$1><head></head>');
  if (!/<body[\s>]/i.test(html)) html = html.replace(/<\/head>/i, '</head><body>') + '</body>';

  const headStart = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><script data-bridge="atoms">${bridgeScript(projectId, versionId)}</script>`;
  const style = `<style data-file="styles.css">\n${escapeClosingTags(files.stylesCss)}\n</style>`;
  const script = `<script data-file="script.js">\n${escapeClosingTags(files.scriptJs)}\n</script>`;

  html = html.replace(/<head([^>]*)>/i, (_m, attrs) => `<head${attrs}>${headStart}`);
  html = html.replace(/<\/head>/i, `${style}</head>`);
  const bodyClose = html.toLowerCase().lastIndexOf('</body>');
  return bodyClose >= 0 ? `${html.slice(0, bodyClose)}${script}${html.slice(bodyClose)}` : `${html}${script}`;
}

export function newId(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function createPageResource(input: {
  projectId: string;
  version: number;
  prompt: string;
  kind: 'initial' | 'followup';
  parentVersionId: string | null;
  mode: 'live' | 'fallback';
  provider: string;
  files: Partial<GeneratedFiles> & { title?: string; summary?: string; generationNotes?: string };
}): PageResource {
  const files = GeneratedFilesSchema.parse(input.files);
  const id = newId('v');
  return PageResourceSchema.parse({
    ...files,
    id,
    projectId: input.projectId,
    version: input.version,
    prompt: input.prompt,
    title: input.files.title,
    summary: input.files.summary,
    generationNotes: input.files.generationNotes,
    previewHtml: assemblePreviewHtml(files, input.projectId, id),
    createdAt: new Date().toISOString(),
    generationMode: input.mode,
    provider: input.mode === 'fallback' ? 'none' : input.provider,
    kind: input.kind,
    parentVersionId: input.parentVersionId,
    renderVerified: false,
  });
}

export function modeLabel(page: PageResource): string {
  if (page.generationMode === 'fallback') return FALLBACK_LABEL;
  return page.renderVerified ? `Live AI generation · ${page.provider}` : `Live AI generation · awaiting render · ${page.provider}`;
}

/* ---------------- persistence bridge message validation ---------------- */

const ids = { projectId: z.string().min(1).max(64), versionId: z.string().min(1).max(64) };
const BridgeMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('LOAD_STATE'), requestId: z.string().min(1).max(32), ...ids }).strict(),
  z.object({ type: z.literal('SAVE_STATE'), payload: z.unknown(), ...ids }).strict(),
  z.object({ type: z.literal('PAGE_READY'), ...ids }).strict(),
]);
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

export function validateBridgeMessage(data: unknown, expected: { projectId: string; versionId: string }): BridgeMessage | null {
  const parsed = BridgeMessageSchema.safeParse(data);
  if (!parsed.success) return null;
  const msg = parsed.data;
  if (msg.projectId !== expected.projectId || msg.versionId !== expected.versionId) return null;
  if (msg.type === 'SAVE_STATE') {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(msg.payload);
    } catch {
      return null;
    }
    if (serialized === undefined || new Blob([serialized]).size > MAX_STATE_BYTES) return null;
    return { ...msg, payload: JSON.parse(serialized) };
  }
  return msg;
}
