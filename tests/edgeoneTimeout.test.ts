import { describe, expect, it, vi } from 'vitest';
import { onRequestPost, EDGEONE_TIMEOUT_SETTING } from '../functions/api/generate';
import { handleGenerate, POST } from '../api/generate';

const env = { AI_API_KEY: 'sk-secretkey-123456789', AI_BASE_URL: 'https://api.example.com/v1', AI_MODEL: 'deepseek-chat' };
const files = { title: 'T', summary: 'S', indexHtml: '<main>x</main>', stylesCss: 'body{}', scriptJs: 'console.log(1)', readme: '# R', generationNotes: 'n' };
const okBody = JSON.stringify({ choices: [{ message: { content: JSON.stringify(files) } }] });
const req = () => new Request('https://x/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Build a page' }) });
const okFetch = () => vi.fn(async () => new Response(okBody, { status: 200, headers: { 'content-type': 'application/json' } }));

describe('EdgeOne provider timeout settings', () => {
  it('EdgeOne passes the extended eo.timeoutSetting and preserves request fields', async () => {
    const f = okFetch();
    const res = await onRequestPost({ request: req(), env, fetchImpl: f as unknown as typeof fetch });
    expect(res.status).toBe(200);
    const init = (f.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(init.eo).toEqual({ timeoutSetting: { connectTimeout: 60000, readTimeout: 300000, writeTimeout: 60000 } });
    expect(EDGEONE_TIMEOUT_SETTING.readTimeout).toBe(300000);
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(typeof init.body).toBe('string');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${env.AI_API_KEY}`);
  });

  it('Vercel/Node handler does not receive the unsupported eo option', async () => {
    const f = okFetch();
    await handleGenerate(req(), env, f as unknown as typeof fetch);
    const init = (f.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect('eo' in init).toBe(false);
    const g = okFetch();
    vi.stubGlobal('fetch', g);
    const prev = { ...process.env };
    Object.assign(process.env, env);
    try {
      await POST(req());
    } finally {
      process.env = prev;
      vi.unstubAllGlobals();
    }
    if (g.mock.calls.length) expect('eo' in (((g.mock.calls[0] as unknown[])[1]) as object)).toBe(false);
  });

  it('maps net_exception_timeout to provider_timeout without retry and excludes credentials', async () => {
    const f = vi.fn(async () => { throw new Error(`net_exception_timeout Bearer ${env.AI_API_KEY}`); });
    const res = await onRequestPost({ request: req(), env, fetchImpl: f as unknown as typeof fetch });
    const text = await res.text();
    expect(res.status).toBe(504);
    expect(JSON.parse(text).detail.code).toBe('provider_timeout');
    expect(f).toHaveBeenCalledTimes(1);
    expect(text).not.toContain(env.AI_API_KEY);
    expect(text.toLowerCase()).not.toContain('authorization');
  });

  it('maps net_exception_timeout during body read to provider_timeout', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => { throw new Error('net_exception_timeout'); } }) as unknown as Response);
    const res = await onRequestPost({ request: req(), env, fetchImpl: f as unknown as typeof fetch });
    const text = await res.text();
    expect(JSON.parse(text).detail.code).toBe('provider_timeout');
    expect(text).not.toContain(env.AI_API_KEY);
  });
});
