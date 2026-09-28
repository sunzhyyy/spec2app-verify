import { describe, expect, it, vi } from 'vitest';
import { handleGenerate } from '../api/generate';
import { COMPACT_RETRY_INSTRUCTION, SYSTEM_PROMPT } from '../src/gen/provider';

const env = { AI_API_KEY: 'sk-secretkey-123456789', AI_BASE_URL: 'https://api.deepseek.com', AI_MODEL: 'deepseek-chat' };
const files = { title: 'T', summary: 'S', indexHtml: '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main>x</main><script src="script.js"></script></body></html>', stylesCss: 'body{}', scriptJs: 'console.log(1)', readme: '# R', generationNotes: 'n' };
const TRUNCATED = '{"title":"T","indexHtml":"<!doctype html><html>TRUNCATED_MARKER';
const envelope = (content: string, finish: string) => JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] });
const req = () => new Request('https://x/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Build a todo page' }) });

function mockFetch(bodies: string[]) {
  const requests: Record<string, unknown>[] = [];
  const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(bodies[Math.min(requests.length - 1, bodies.length - 1)], { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { f: f as unknown as typeof fetch, calls: f, requests };
}
const msgs = (r: Record<string, unknown>) => (r.messages as { role: string; content: string }[]);

describe('webpage output budget', () => {
  it('explicitly disables thinking and sets max_tokens 16384', async () => {
    const m = mockFetch([envelope(JSON.stringify(files), 'stop')]);
    const res = await handleGenerate(req(), env, m.f);
    expect(res.status).toBe(200);
    expect(m.requests[0].thinking).toEqual({ reasoning_effort: 'none' });
    expect(m.requests[0].max_tokens).toBe(16384);
    expect(msgs(m.requests[0])[0].content).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).toMatch(/no Markdown fences, no indentation/);
    expect(SYSTEM_PROMPT).toMatch(/one main interactive workflow/);
  });

  it('length retry uses compact mode, keeps budget, excludes truncated output and succeeds', async () => {
    const m = mockFetch([envelope(TRUNCATED, 'length'), envelope(JSON.stringify(files), 'stop')]);
    const res = await handleGenerate(req(), env, m.f);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.response.indexHtml).toContain('<main>x</main>');
    expect(m.calls).toHaveBeenCalledTimes(2);
    const retry = m.requests[1];
    expect(retry.thinking).toEqual({ reasoning_effort: 'none' });
    expect(retry.max_tokens).toBe(16384);
    expect(msgs(retry).some((x) => x.content === COMPACT_RETRY_INSTRUCTION)).toBe(true);
    expect(JSON.stringify(retry)).not.toContain('TRUNCATED_MARKER');
    expect(JSON.stringify(retry)).not.toEqual(JSON.stringify(m.requests[0]));
  });

  it('never makes a third attempt when both replies are truncated', async () => {
    const m = mockFetch([envelope(TRUNCATED, 'length')]);
    const res = await handleGenerate(req(), env, m.f);
    const text = await res.text();
    expect(m.calls).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(502);
    const d = JSON.parse(text).detail;
    expect(d.code).toBe('provider_output_truncated');
    expect(d.diagnostic).toMatchObject({ attemptNumber: 2, retryPerformed: true, retrySucceeded: false, compactRetry: true });
    expect(text).not.toContain('TRUNCATED_MARKER');
    expect(text).not.toContain(env.AI_API_KEY);
  });
});
