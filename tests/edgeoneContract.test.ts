import { describe, expect, it } from 'vitest';
import { handleGenerate } from '../api/generate';
import { onRequestPost } from '../functions/api/generate';
import { parseProviderContent } from '../src/gen/provider';

const KEY = 'sk-test-SECRET-1234567890abcdef';
const ENV = { AI_API_KEY: KEY, AI_BASE_URL: 'https://provider.example/v1', AI_MODEL: 'm' };
const PROMPT = 'Create a todo board with priorities and due dates. Users can add, complete and delete tasks.';
const GEN = {
  title: 'Todo', summary: 's', generationNotes: 'n', readme: '# Todo',
  indexHtml: '<main><form id="f"><input id="t"><button>Add</button></form><ul id="l"></ul></main>',
  stylesCss: 'body{margin:0}', scriptJs: 'document.getElementById("f").onsubmit=function(e){e.preventDefault();};',
};
const provider = (content: unknown) => (async () =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
const req = () => new Request('http://x/api/generate', { method: 'POST', body: JSON.stringify({ prompt: PROMPT, history: [] }) });

async function check(res: Response) {
  const text = await res.text();
  expect(text).not.toContain(KEY);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: JSON.parse(text) };
}

describe('provider content normalization', () => {
  it('accepts an object', () => expect(parseProviderContent(GEN).title).toBe('Todo'));
  it('accepts a JSON string', () => expect(parseProviderContent(JSON.stringify(GEN)).indexHtml).toContain('<form'));
  it('accepts a fenced JSON string', () => expect(parseProviderContent('```json\n' + JSON.stringify(GEN) + '\n```').scriptJs).toContain('onsubmit'));
  it('rejects malformed strings, arrays and primitives with schema_invalid', () => {
    for (const bad of ['{"title": oops', '[1,2]', '42']) expect(() => parseProviderContent(bad)).toThrow(expect.objectContaining({ code: 'schema_invalid' }));
  });
});

describe('endpoint response contract', () => {
  for (const [name, call] of [
    ['Vercel', (f: typeof fetch) => handleGenerate(req(), ENV, f)],
    ['EdgeOne', (f: typeof fetch) => onRequestPost({ request: req(), env: ENV, fetchImpl: f } as never)],
  ] as const) {
    it(`${name}: response.response is an object with live fields`, async () => {
      const { status, type, body } = await check(await call(provider(JSON.stringify(GEN))));
      expect(status).toBe(200);
      expect(type).toContain('application/json');
      expect(typeof body.response).toBe('object');
      expect(body.response).toMatchObject({ generationMode: 'live', providerInvoked: true, receivedPrompt: PROMPT });
      for (const k of ['title', 'indexHtml', 'stylesCss', 'scriptJs']) expect(typeof body.response[k]).toBe('string');
    });
    it(`${name}: malformed provider string returns schema_invalid without leaking the key`, async () => {
      const { status, body } = await check(await call(provider('{"title": broken')));
      expect(status).toBe(502);
      expect(body.detail.code).toBe('schema_invalid');
    });
  }
});
