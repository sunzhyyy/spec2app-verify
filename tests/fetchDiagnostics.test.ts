import { describe, expect, it } from 'vitest';
import { handleGenerate, providerUrl } from '../api/generate';

const KEY = 'sk-live-SECRETvalue1234567890abcdef';
const ENV = { AI_API_KEY: KEY, AI_BASE_URL: 'https://api.deepseek.com', AI_MODEL: 'deepseek-flash' };
const PROMPT = 'Build a private diary tracker.';
const call = (fetchImpl: typeof fetch) =>
  handleGenerate(new Request('http://x/api/generate', { method: 'POST', body: JSON.stringify({ prompt: PROMPT }) }), ENV, fetchImpl);

describe('provider URL normalization', () => {
  it.each(['https://api.deepseek.com', 'https://api.deepseek.com/', ' https://api.deepseek.com// ', 'https://api.deepseek.com/chat/completions'])('%s', (b) => {
    expect(providerUrl(b)).toBe('https://api.deepseek.com/chat/completions');
  });
});

describe('safe fetch diagnostics', () => {
  it('network exceptions return a sanitized diagnostic and never the key, Authorization, or prompt', async () => {
    let auth = '';
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).authorization;
      const err = new TypeError(`fetch failed for ${ENV.AI_BASE_URL}?k=${KEY} with ${auth} ${PROMPT}`);
      (err as { cause?: unknown }).cause = { code: 'ENOTFOUND' };
      throw err;
    }) as unknown as typeof fetch;
    const res = await call(fetchImpl);
    const text = await res.text();
    expect(res.status).toBe(502);
    for (const secret of [KEY, auth, 'Bearer sk', PROMPT, 'deepseek-flash']) expect(text).not.toContain(secret);
    const { detail } = JSON.parse(text);
    expect(detail).toMatchObject({ code: 'provider_unavailable', message: 'Could not reach the AI provider.', providerInvoked: true });
    expect(detail.diagnostic).toMatchObject({ providerHost: 'api.deepseek.com', providerPath: '/chat/completions', exceptionName: 'TypeError', constructorName: 'TypeError', causeCode: 'ENOTFOUND' });
    expect(typeof detail.diagnostic.elapsedMs).toBe('number');
    expect(detail.diagnostic.message).toContain('fetch failed');
  });

  it('causeCode is null when absent', async () => {
    const res = await call((async () => { throw new Error('boom'); }) as unknown as typeof fetch);
    expect((await res.json()).detail.diagnostic.causeCode).toBeNull();
  });

  it.each([[401, 'provider_unauthorized'], [402, 'provider_payment_required'], [403, 'provider_forbidden'], [404, 'provider_not_found'], [429, 'provider_rate_limited'], [500, 'provider_http_error']])(
    'upstream HTTP %i maps to %s, never provider_unavailable, with no body or diagnostic',
    async (status, code) => {
      const res = await call((async () => new Response(`upstream body ${KEY}`, { status })) as unknown as typeof fetch);
      const text = await res.text();
      const { detail } = JSON.parse(text);
      expect(detail.code).toBe(code);
      expect(detail.upstreamStatus).toBe(status);
      expect(detail.diagnostic).toBeUndefined();
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('upstream body');
    },
  );
});
