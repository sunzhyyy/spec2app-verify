import { describe, expect, it } from 'vitest';
import {
  FALLBACK_LABEL,
  IFRAME_SANDBOX,
  assemblePreviewHtml,
  createPageResource,
  modeLabel,
  validateBridgeMessage,
  validateLiveResponse,
} from '../src/gen/core';
import { GenerationFailure, buildMessages, parseProviderContent } from '../src/gen/provider';
import { FALLBACK_EXAMPLES } from '../src/gen/fallback';
import {
  STORAGE_KEY,
  addVersion,
  createProject,
  emptyWorkspace,
  getAppState,
  loadWorkspace,
  recordFailedPrompt,
  saveWorkspace,
  setAppState,
} from '../src/gen/store';
import { handleGenerate } from '../api/generate';

class MemStorage implements Storage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

const files = {
  title: 'Todo',
  summary: 's',
  generationNotes: 'n',
  indexHtml: '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"></head><body><ul id="l"></ul><script src="script.js"></script></body></html>',
  stylesCss: 'body{color:red}',
  scriptJs: 'document.getElementById("l").textContent="x";',
  readme: '# Todo',
};
const live = { ...files, generationMode: 'live', providerInvoked: true, provider: 'atoms-aihub:gpt-5.4', receivedPrompt: 'make todo' };

describe('generation response schema and live conditions', () => {
  it('accepts a valid live response for the same prompt', () => {
    expect(validateLiveResponse(live, 'make todo').ok).toBe(true);
  });
  it('rejects mismatched prompt, missing provider invocation, missing files, fenced code', () => {
    expect(validateLiveResponse(live, 'other').ok).toBe(false);
    expect(validateLiveResponse({ ...live, providerInvoked: false }, 'make todo').ok).toBe(false);
    expect(validateLiveResponse({ ...live, generationMode: 'fallback' }, 'make todo').ok).toBe(false);
    expect(validateLiveResponse({ ...live, scriptJs: '' }, 'make todo').ok).toBe(false);
    expect(validateLiveResponse({ ...live, scriptJs: '```js\nx\n```' }, 'make todo').ok).toBe(false);
  });
});

describe('malformed provider output', () => {
  it('parses JSON, strips fences, and rejects malformed/missing/empty', () => {
    expect(parseProviderContent('```json\n' + JSON.stringify(files) + '\n```').title).toBe('Todo');
    const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as GenerationFailure).code; } return 'ok'; };
    expect(code(() => parseProviderContent('not json'))).toBe('malformed_json');
    expect(code(() => parseProviderContent('{"title":'))).toBe('malformed_json');
    expect(code(() => parseProviderContent(''))).toBe('empty_content');
    const { scriptJs: _s, ...noScript } = files;
    expect(code(() => parseProviderContent(JSON.stringify(noScript)))).toBe('missing_files');
    expect(code(() => parseProviderContent(JSON.stringify({ ...files, stylesCss: '  ' })))).toBe('empty_content');
    expect(code(() => parseProviderContent(JSON.stringify({ ...files, title: 5 })))).toBe('schema_invalid');
  });
});

describe('PageResource and previewHtml', () => {
  it('creates a resource with inlined files and bridge, preserving original files', () => {
    const p = createPageResource({ projectId: 'p1', version: 1, prompt: 'make todo', kind: 'initial', parentVersionId: null, mode: 'live', provider: 'x', files });
    expect(p.indexHtml).toBe(files.indexHtml);
    expect(p.previewHtml).toContain('body{color:red}');
    expect(p.previewHtml).toContain('textContent="x"');
    expect(p.previewHtml).toContain('window.AppStorage');
    expect(p.previewHtml).not.toContain('href="styles.css"');
    expect(p.previewHtml).toContain("connect-src 'none'");
    expect(p.renderVerified).toBe(false);
  });
  it('escapes closing script tags inside generated JS', () => {
    const out = assemblePreviewHtml({ ...files, scriptJs: 'var s="</script><b>";' }, 'p', 'v');
    expect(out).toContain('<\\/script><b>');
  });
  it('sandbox is allow-scripts only', () => {
    expect(IFRAME_SANDBOX).toBe('allow-scripts');
    expect(IFRAME_SANDBOX).not.toContain('allow-same-origin');
  });
});

describe('fallback labeling', () => {
  it('fallback resources are labelled and carry no provider', () => {
    const p = createPageResource({ projectId: 'p', version: 1, prompt: 'x', kind: 'initial', parentVersionId: null, mode: 'fallback', provider: 'x', files: FALLBACK_EXAMPLES.todo });
    expect(p.generationMode).toBe('fallback');
    expect(p.provider).toBe('none');
    expect(modeLabel(p)).toBe(FALLBACK_LABEL);
    expect(FALLBACK_LABEL).toBe('Saved fallback example – no live model call');
  });
});

describe('persistence bridge validation', () => {
  const exp = { projectId: 'p', versionId: 'v' };
  it('accepts only known, bounded messages for the current project/version', () => {
    expect(validateBridgeMessage({ type: 'SAVE_STATE', projectId: 'p', versionId: 'v', payload: [1] }, exp)?.type).toBe('SAVE_STATE');
    expect(validateBridgeMessage({ type: 'LOAD_STATE', projectId: 'p', versionId: 'v', requestId: 'r1' }, exp)?.type).toBe('LOAD_STATE');
    expect(validateBridgeMessage({ type: 'SAVE_STATE', projectId: 'q', versionId: 'v', payload: 1 }, exp)).toBeNull();
    expect(validateBridgeMessage({ type: 'EVAL', projectId: 'p', versionId: 'v' }, exp)).toBeNull();
    expect(validateBridgeMessage({ type: 'SAVE_STATE', projectId: 'p', versionId: 'v', payload: 'x'.repeat(200_000) }, exp)).toBeNull();
    expect(validateBridgeMessage({ type: 'SAVE_STATE', projectId: 'p', versionId: 'v', payload: 1, extra: 1 }, exp)).toBeNull();
  });
});

describe('host persistence, versions and follow-up', () => {
  it('round-trips projects, prompts, versions and app state; follow-up keeps old version', () => {
    const s = new MemStorage();
    let { ws, project } = createProject(emptyWorkspace());
    const v1 = createPageResource({ projectId: project.id, version: 1, prompt: 'a', kind: 'initial', parentVersionId: null, mode: 'live', provider: 'x', files });
    ws = addVersion(ws, v1);
    ws = setAppState(ws, project.id, v1.id, { tasks: ['t'] });
    const v2 = createPageResource({ projectId: project.id, version: 2, prompt: 'make blue', kind: 'followup', parentVersionId: v1.id, mode: 'live', provider: 'x', files: { ...files, stylesCss: 'body{color:blue}' } });
    ws = addVersion(ws, v2);
    ws = recordFailedPrompt(ws, project.id, 'bad', 'followup', 'timeout: x');
    saveWorkspace(ws, s);
    const back = loadWorkspace(s).workspace;
    const p = back.projects[0];
    expect(p.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(p.selectedVersionId).toBe(v2.id);
    expect(p.prompts.map((q) => q.status)).toEqual(['ok', 'ok', 'error']);
    expect(getAppState(back, project.id, v1.id)).toEqual({ tasks: ['t'] });
    expect(getAppState(back, project.id, v2.id)).toBeNull();
    expect(back.selectedProjectId).toBe(project.id);
  });
  it('recovers from corrupted storage with a backup', () => {
    const s = new MemStorage();
    s.setItem(STORAGE_KEY, '{broken');
    const r = loadWorkspace(s);
    expect(r.workspace.projects).toEqual([]);
    expect(r.warning).toBeTruthy();
    expect([...s.m.keys()].some((k) => k.includes('corrupt'))).toBe(true);
  });
  it('follow-up prompt includes current files', () => {
    const m = buildMessages({ prompt: 'add search', currentFiles: files });
    expect(m[1].content).toContain('<current-file name="script.js">');
    expect(m[1].content).toContain('Follow-up change request: add search');
  });
});

describe('Vercel endpoint and secret exclusion', () => {
  const req = (body: unknown) => new Request('http://x/api/generate', { method: 'POST', body: JSON.stringify(body) });
  it('invokes provider with server key and never returns it', async () => {
    let auth = '';
    const fake = (async (_u: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).authorization;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(files) } }] }));
    }) as unknown as typeof fetch;
    const res = await handleGenerate(req({ prompt: 'make todo' }), { AI_API_KEY: 'sk-test-secret', AI_BASE_URL: 'https://p', AI_MODEL: 'm' }, fake);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(auth).toBe('Bearer sk-test-secret');
    expect(text).not.toContain('sk-test-secret');
    expect(validateLiveResponse(JSON.parse(text), 'make todo').ok).toBe(true);
  });
  it('maps quota and malformed output to errors; unconfigured does not claim invocation', async () => {
    const q = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    expect((await handleGenerate(req({ prompt: 'x' }), { AI_API_KEY: 'k', AI_BASE_URL: 'https://p' }, q)).status).toBe(429);
    const bad = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'nope' } }] }))) as unknown as typeof fetch;
    expect((await handleGenerate(req({ prompt: 'x' }), { AI_API_KEY: 'k', AI_BASE_URL: 'https://p' }, bad)).status).toBe(502);
    const nc = await handleGenerate(req({ prompt: 'x' }), {}, q);
    expect(nc.status).toBe(503);
    expect((await nc.json()).detail.providerInvoked).toBe(false);
  });
  it('no VITE_ variable holds a provider key', () => {
    expect(Object.keys(import.meta.env).filter((k) => k.startsWith('VITE_') && /KEY|SECRET|TOKEN/.test(k))).toEqual([]);
  });
});
