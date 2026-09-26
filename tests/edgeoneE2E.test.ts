import { describe, expect, it } from 'vitest';
import { handleGenerate, assertSuccessContract } from '../api/generate';
import { onRequestPost } from '../functions/api/generate';
import { unwrapGenerationBody } from '../src/gen/provider';
import { validateLiveResponse } from '../src/gen/core';

const KEY = 'sk-test-E2E-abcdef1234567890';
const ENV = { AI_API_KEY: KEY, AI_BASE_URL: 'https://p.example/v1', AI_MODEL: 'm' };
const PROMPT = 'Create a todo board with priorities and due dates.';
const GEN = { title: 'Todo', summary: 's', generationNotes: 'n', readme: '# r', indexHtml: '<main></main>', stylesCss: 'b{}', scriptJs: 'void 0;' };
const provider = (content: unknown) => (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
const req = () => new Request('http://x/api/generate', { method: 'POST', body: JSON.stringify({ prompt: PROMPT }) });
const edge = (c: unknown) => onRequestPost({ request: req(), env: ENV, fetchImpl: provider(c) });

async function parse(res: Response) {
  const text = await res.text();
  expect(text).not.toContain(KEY);
  return { status: res.status, ct: res.headers.get('content-type'), body: JSON.parse(text) };
}
async function expectGood(res: Response) {
  const { status, ct, body } = await parse(res);
  expect(status).toBe(200);
  expect(ct).toContain('application/json');
  expect(typeof body.response).toBe('object');
  expect(Array.isArray(body.response)).toBe(false);
  for (const k of ['indexHtml', 'stylesCss', 'scriptJs', 'title', 'readme']) expect(typeof body.response[k]).toBe('string');
  expect(body.response.generationMode).toBe('live');
  expect(body.response.providerInvoked).toBe(true);
  expect(validateLiveResponse(unwrapGenerationBody(body), PROMPT).ok).toBe(true);
  return body;
}

describe('EdgeOne end-to-end response contract', () => {
  it('1/4-8 JSON text content', async () => { await expectGood(await edge(JSON.stringify(GEN))); });
  it('2 object content', async () => { await expectGood(await edge(GEN)); });
  it('3 fenced content', async () => { await expectGood(await edge('```json\n' + JSON.stringify(GEN) + '\n```')); });
  it('9 Vercel returns the same shape', async () => {
    const e = await expectGood(await edge(GEN));
    const v = await expectGood(await handleGenerate(req(), ENV, provider(GEN)));
    expect(Object.keys(v).sort()).toEqual(Object.keys(e).sort());
    expect(Object.keys(v.response).sort()).toEqual(Object.keys(e.response).sort());
  });
  it('10 double-serialized response is rejected by server assertion and frontend', () => {
    expect(() => assertSuccessContract({ response: JSON.stringify(GEN) })).toThrow();
    expect(() => assertSuccessContract({ response: null })).toThrow();
    expect(() => assertSuccessContract({ response: [] })).toThrow();
    expect(() => assertSuccessContract({ response: { ...GEN, generationMode: 'fallback', providerInvoked: true } })).toThrow();
    expect(() => unwrapGenerationBody({ response: JSON.stringify(GEN) })).toThrow(/double-serialized/);
  });
  it('10b double-encoded provider string is not recursively parsed', async () => {
    const { status, body } = await parse(await edge(JSON.stringify(JSON.stringify(GEN))));
    expect(status).toBe(502);
    expect(body.detail.code).toBe('schema_invalid');
  });
  it('11/12 malformed content -> schema_invalid without leaking content or key', async () => {
    const r = await edge('{"title": SECRET-CONTENT');
    const text = await r.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('SECRET-CONTENT');
    expect(JSON.parse(text).detail.code).toBe('schema_invalid');
  });
});
