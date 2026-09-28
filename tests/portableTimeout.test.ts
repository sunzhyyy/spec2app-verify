import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleGenerate } from '../api/generate';

const KEY = 'sk-live-TIMEOUTsecret1234567890abcdef';
const PROMPT = 'Build a reading log with ratings.';
const GEN = { title: 'Log', summary: 's', generationNotes: 'n', readme: '# r', indexHtml: '<main></main>', stylesCss: 'b{}', scriptJs: 'void 0;' };
const env = (extra: Record<string, string> = {}) => ({ AI_API_KEY: KEY, AI_BASE_URL: 'https://api.deepseek.com', AI_MODEL: 'deepseek-flash', ...extra });
const call = (fetchImpl: typeof fetch, e = env()) =>
  handleGenerate(new Request('http://x/api/generate', { method: 'POST', body: JSON.stringify({ prompt: PROMPT }) }), e, fetchImpl);
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(GEN) } }] }), { headers: { 'content-type': 'application/json' } });

/** Tracks timers created/cleared by the handler. */
function trackTimers() {
  const created = new Set<unknown>();
  const cleared = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    const id = realSet(fn, ms);
    created.add(id);
    return id;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((id: Parameters<typeof clearTimeout>[0]) => {
    cleared.add(id);
    realClear(id);
  }) as typeof clearTimeout);
  return { allCleared: () => created.size > 0 && [...created].every((id) => cleared.has(id)) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('portable provider timeout', () => {
  it('works when AbortSignal.timeout is undefined and passes an AbortController signal', async () => {
    const original = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true });
    try {
      let signal: AbortSignal | undefined;
      const res = await call((async (_u: string, init: RequestInit) => { signal = init.signal ?? undefined; return ok(); }) as unknown as typeof fetch);
      expect(res.status).toBe(200);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', { value: original, configurable: true, writable: true });
    }
  });

  it('clears the timer after success', async () => {
    const t = trackTimers();
    expect((await call((async () => ok()) as unknown as typeof fetch)).status).toBe(200);
    expect(t.allCleared()).toBe(true);
  });

  it('clears the timer after an upstream HTTP error and keeps the mapping', async () => {
    const t = trackTimers();
    const res = await call((async () => new Response('nope', { status: 401 })) as unknown as typeof fetch);
    expect((await res.json()).detail.code).toBe('provider_unauthorized');
    expect(t.allCleared()).toBe(true);
  });

  it('clears the timer after a network error, which stays provider_unavailable', async () => {
    const t = trackTimers();
    const res = await call((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
    const { detail } = await res.json();
    expect(res.status).toBe(502);
    expect(detail.code).toBe('provider_unavailable');
    expect(detail.diagnostic.timeoutTriggered).toBe(false);
    expect(t.allCleared()).toBe(true);
  });

  it('clears the timer after a response parsing failure', async () => {
    const t = trackTimers();
    const res = await call((async () => new Response('not json', { status: 200 })) as unknown as typeof fetch);
    expect(res.status).toBe(502);
    expect(t.allCleared()).toBe(true);
  });

  it('maps a timer abort to provider_timeout with safe diagnostics', async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException(`aborted ${KEY} Bearer ${KEY}`, 'AbortError'))))) as unknown as typeof fetch;
    const res = await call(hang, env({ AI_TIMEOUT_MS: '20' }));
    const text = await res.text();
    const { detail } = JSON.parse(text);
    expect(res.status).toBe(504);
    expect(detail.code).toBe('provider_timeout');
    expect(detail.diagnostic).toMatchObject({ providerHost: 'api.deepseek.com', providerPath: '/chat/completions', exceptionName: 'AbortError', timeoutTriggered: true });
    for (const secret of [KEY, `Bearer ${KEY}`, PROMPT]) expect(text).not.toContain(secret);
  });
});
