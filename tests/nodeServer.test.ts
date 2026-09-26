import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, resolvePort } from '../server/index';
import { resolveTarget } from '../src/gen/api-target';
import { unwrapGenerationBody } from '../src/gen/provider';
import { validateLiveResponse } from '../src/gen/core';

const KEY = 'sk-test-NODE-abcdef1234567890';
const ENV = { AI_API_KEY: KEY, AI_BASE_URL: 'https://p.example/v1', AI_MODEL: 'm' };
const PROMPT = 'Create a todo board with priorities.';
const GEN = { title: 'Todo', summary: 's', generationNotes: 'n', readme: '# r', indexHtml: '<main></main>', stylesCss: 'b{}', scriptJs: 'void 0;' };

let providerMode: 'ok' | 'quota' | 'down' | 'bad' = 'ok';
let seenAuth = '';
const fakeFetch = (async (_u: string, init: RequestInit) => {
  seenAuth = (init.headers as Record<string, string>).authorization;
  if (providerMode === 'down') throw new TypeError('fetch failed');
  if (providerMode === 'quota') return new Response('', { status: 429 });
  const content = providerMode === 'bad' ? 'not json' : JSON.stringify(GEN);
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

const dist = mkdtempSync(join(tmpdir(), 'dist-'));
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root">SPA</div>');
writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');

let server: Server;
let base = '';
beforeAll(async () => {
  server = createApp({ distDir: dist, env: ENV, fetchImpl: fakeFetch });
  await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
const gen = (body: unknown = { prompt: PROMPT }) => fetch(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('Node production server', () => {
  it('health and root routes', async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('SPA');
  });
  it('listens on 0.0.0.0', () => { expect((server.address() as AddressInfo).address).toBe('0.0.0.0'); });
  it('PORT handling uses the platform value', () => {
    expect(resolvePort({ PORT: '8080' })).toBe(8080);
    expect(resolvePort({ PORT: 'abc' })).toBe(3000);
    expect(resolvePort({})).toBe(3000);
  });
  it('POST /api/generate returns the shared contract, validated by the frontend schema', async () => {
    providerMode = 'ok';
    const res = await gen();
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(seenAuth).toBe(`Bearer ${KEY}`);
    expect(text).not.toContain(KEY);
    const body = JSON.parse(text);
    expect(typeof body.response).toBe('object');
    expect(validateLiveResponse(unwrapGenerationBody(body), PROMPT).ok).toBe(true);
  });
  it('node target calls same-origin /api/generate', () => {
    expect(resolveTarget('node', 'myapp.zeabur.app')).toBe('serverless');
    expect(resolveTarget('atoms', 'x.zeabur.app')).toBe('atoms');
  });
  it('SPA fallback serves index.html; assets served; API 404 stays JSON', async () => {
    expect(await (await fetch(`${base}/projects/abc`)).text()).toContain('SPA');
    expect(await (await fetch(`${base}/assets/app.js`)).text()).toContain('console.log');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    const api = await fetch(`${base}/api/unknown`);
    expect(api.status).toBe(404);
    expect(await (await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).text()).toContain('SPA');
    expect((await fetch(`${base}/api/generate`)).status).toBe(405);
  });
  it('maps provider errors with no credential exposure', async () => {
    const cases: [typeof providerMode, number, string][] = [['quota', 429, 'quota_exhausted'], ['down', 502, 'provider_unavailable'], ['bad', 502, 'schema_invalid']];
    for (const [mode, status, code] of cases) {
      providerMode = mode;
      const res = await gen();
      const text = await res.text();
      expect(res.status).toBe(status);
      expect(JSON.parse(text).detail.code).toBe(code);
      expect(text).not.toContain(KEY);
    }
    const inv = await gen({ prompt: '' });
    expect(inv.status).toBe(422);
  });
  it('unconfigured server does not claim invocation', async () => {
    const s = createApp({ distDir: dist, env: {}, fetchImpl: fakeFetch });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/generate`, { method: 'POST', body: JSON.stringify({ prompt: 'x' }) });
    const b = await r.json();
    await new Promise<void>((d) => s.close(() => d()));
    expect(r.status).toBe(503);
    expect(b.detail).toMatchObject({ code: 'not_configured', providerInvoked: false });
  });
});
