import { describe, expect, it } from 'vitest';
import { handleGenerate } from '../api/generate';

const KEY = 'sk-live-STRUCTsecret1234567890abcdef';
const PROMPT = 'Create a simple todo app with add, complete, and delete actions.';
const HTML = '<!doctype html><html><head><title>Todo</title></head><body><main id="app">UNIQUE_HTML_MARKER</main></body></html>';
const GEN = { title: 'Todo', summary: 'A todo app.', generationNotes: 'n', readme: '# Todo', indexHtml: HTML, stylesCss: 'body{margin:0}', scriptJs: 'void 0;' };
const ENV = { AI_API_KEY: KEY, AI_BASE_URL: 'https://api.deepseek.com', AI_MODEL: 'deepseek-flash' };

type Reply = { content?: unknown; finish?: string; envelope?: unknown };
function provider(replies: Reply[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    const r = replies[Math.min(bodies.length - 1, replies.length - 1)];
    const env = r.envelope ?? { choices: [{ message: { content: r.content }, finish_reason: r.finish ?? 'stop' }] };
    return new Response(JSON.stringify(env), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}
async function run(replies: Reply[]) {
  const p = provider(replies);
  const res = await handleGenerate(new Request('http://x/api/generate', { method: 'POST', body: JSON.stringify({ prompt: PROMPT }) }), ENV, p.fetchImpl);
  const text = await res.text();
  return { res, text, body: JSON.parse(text), calls: p.bodies };
}
const json = JSON.stringify(GEN);

describe('DeepSeek structured output', () => {
  it('sends response_format json_object, max_tokens and a json system prompt with the exact shape', async () => {
    const { calls } = await run([{ content: json }]);
    const req = calls[0] as { response_format: unknown; max_tokens: number; messages: { role: string; content: string }[] };
    expect(req.response_format).toEqual({ type: 'json_object' });
    expect(req.max_tokens).toBeGreaterThanOrEqual(8192);
    const system = req.messages[0].content;
    expect(system).toContain('json');
    expect(system).toContain('"indexHtml":"<!doctype html>');
    expect(system).toMatch(/Do not use Markdown code fences/);
  });

  it.each([['plain', json], ['json fence', '```json\n' + json + '\n```'], ['plain fence', '```\n' + json + '\n```']])('accepts %s content', async (_n, content) => {
    const { res, body } = await run([{ content }]);
    expect(res.status).toBe(200);
    expect(body.response.indexHtml).toContain('UNIQUE_HTML_MARKER');
  });

  it('missing choices -> provider_invalid_response, no retry', async () => {
    const { body, calls } = await run([{ envelope: { id: 'x' } }]);
    expect(body.detail.code).toBe('provider_invalid_response');
    expect(calls).toHaveLength(1);
  });

  it('empty content -> provider_empty_response after one retry', async () => {
    const { body, calls } = await run([{ content: '   ' }]);
    expect(body.detail.code).toBe('provider_empty_response');
    expect(calls).toHaveLength(2);
  });

  it('malformed content -> malformed_json with parseErrorName, retried once', async () => {
    const { body, calls } = await run([{ content: 'Here is your app: {oops' + HTML }]);
    expect(body.detail.code).toBe('malformed_json');
    expect(body.detail.diagnostic).toMatchObject({ upstreamStatus: 200, contentPresent: true, startsWithFence: false, finishReason: 'stop', parseErrorName: 'SyntaxError' });
    expect(calls).toHaveLength(2);
  });

  it('valid JSON with wrong schema -> provider_schema_mismatch, no retry', async () => {
    const { body, calls } = await run([{ content: JSON.stringify({ html: HTML, title: 'x' }) }]);
    expect(body.detail.code).toBe('provider_schema_mismatch');
    expect(calls).toHaveLength(1);
  });

  it('finish_reason length -> provider_output_truncated', async () => {
    const { body, calls } = await run([{ content: json.slice(0, 80), finish: 'length' }]);
    expect(body.detail.code).toBe('provider_output_truncated');
    expect(body.detail.diagnostic.finishReason).toBe('length');
    expect(calls).toHaveLength(2);
  });

  it('one successful retry after malformed JSON uses a stricter prompt', async () => {
    const { res, calls } = await run([{ content: 'not json' }, { content: json }]);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    const retryMsgs = (calls[1] as { messages: { role: string; content: string }[] }).messages;
    expect(retryMsgs.at(-1)?.content).toMatch(/could not be parsed/);
    expect((calls[0] as { messages: unknown[] }).messages).toHaveLength(2);
  });

  it('diagnostics never contain raw content, HTML, prompt or credentials', async () => {
    for (const reply of [{ content: 'broken ' + HTML + ' ' + KEY }, { content: JSON.stringify({ html: HTML, secret: KEY }) }, { content: '{"indexHtml":"' + HTML, finish: 'length' }]) {
      const { text } = await run([reply]);
      for (const leak of [HTML, 'UNIQUE_HTML_MARKER', PROMPT, KEY, 'Bearer', 'broken']) expect(text).not.toContain(leak);
    }
  });
});
