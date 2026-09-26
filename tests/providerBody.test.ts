import { describe, expect, it } from 'vitest';
import { handleGenerate } from '../api/generate';
import { normalizeGeneratedContent, unwrapGenerationBody } from '../src/gen/provider';

const KEY = 'sk-live-BODYsecret1234567890abcdef';
const PROMPT = 'Create a simple todo app with add, complete, and delete actions.';
const HTML = '<!doctype html><html><head><title>Todo</title></head><body><main id="app">BODY_HTML_MARKER</main></body></html>';
const GEN = { title: 'Todo', summary: 'A todo app.', generationNotes: 'n', readme: '# Todo', indexHtml: HTML, stylesCss: 'body{margin:0}', scriptJs: 'void 0;' };
const ENV = { AI_API_KEY: KEY, AI_BASE_URL: 'https://api.deepseek.com', AI_MODEL: 'deepseek-flash' };
const chat = (content: unknown) => JSON.stringify({ id: 'chatcmpl-XYZ789', object: 'chat.completion', model: 'deepseek-flash', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const OK = chat(JSON.stringify(GEN));

type Reply = { status?: number; body: string };
function provider(replies: Reply[]) {
  const requests: Record<string, unknown>[] = [];
  const reads = { text: 0, json: 0 };
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    const r = replies[Math.min(requests.length - 1, replies.length - 1)];
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => { reads.text += 1; return r.body; },
      json: async () => { reads.json += 1; throw new Error('json() must not be used'); },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, requests, reads };
}

async function run(replies: Reply[]) {
  const p = provider(replies);
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(JSON.stringify(a)); };
  try {
    const res = await handleGenerate(new Request('http://x/api/generate', { method: 'POST', body: JSON.stringify({ prompt: PROMPT }) }), ENV, p.fetchImpl);
    const text = await res.text();
    return { res, text, body: JSON.parse(text), ...p, logs: logs.join('\n') };
  } finally {
    console.log = orig;
  }
}

const LEAKS = [HTML, 'BODY_HTML_MARKER', PROMPT, KEY, 'Bearer', 'RAW_BODY_SECRET', 'chatcmpl-XYZ789'];
const expectNoLeak = (...t: string[]) => t.forEach((s) => LEAKS.forEach((l) => expect(s).not.toContain(l)));

describe('text-first provider body handling at the handler boundary', () => {
  it('1/7 normal Chat Completions body with valid content succeeds', async () => {
    const { res, body, requests } = await run([{ body: OK }]);
    expect(res.status).toBe(200);
    expect(body.response.indexHtml).toContain('BODY_HTML_MARKER');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ stream: false, max_tokens: 8192, response_format: { type: 'json_object' } });
  });

  it('2 empty body -> provider_empty_response with safe body metadata after one compatibility retry', async () => {
    const { body, requests, text, logs } = await run([{ body: '' }]);
    expect(body.detail.code).toBe('provider_empty_response');
    expect(body.detail.diagnostic).toMatchObject({ upstreamStatus: 200, upstreamContentType: 'application/json', bodyLength: 0, bodyIsEmpty: true, bodyIsLiteralNull: false, retryPerformed: true, retrySucceeded: false, firstFailureCode: 'provider_empty_response', attemptNumber: 2 });
    expect(requests).toHaveLength(2);
    expectNoLeak(text, logs);
  });

  it('3 literal null body (the reproduced EdgeOne case) -> provider_empty_response', async () => {
    const { body } = await run([{ body: ' null\n' }]);
    expect(body.detail.code).toBe('provider_empty_response');
    expect(body.detail.diagnostic).toMatchObject({ bodyIsLiteralNull: true, bodyIsEmpty: false, bodyTrimmedLength: 4 });
  });

  it('4 malformed outer JSON -> provider_invalid_json', async () => {
    const { body, text, logs } = await run([{ body: '{"choices": [RAW_BODY_SECRET ' + KEY }]);
    expect(body.detail.code).toBe('provider_invalid_json');
    expect(body.detail.diagnostic).toMatchObject({ parseErrorName: 'SyntaxError', bodyStartsWithBrace: true, bodyStartsWithBracket: false });
    expectNoLeak(text, logs);
  });

  it('5 empty choices -> provider_invalid_response', async () => {
    const { body, requests } = await run([{ body: JSON.stringify({ id: 'chatcmpl-XYZ789', choices: [] }) }]);
    expect(body.detail.code).toBe('provider_invalid_response');
    expect(body.detail.diagnostic).toMatchObject({ choicesCount: 0, bodyStartsWithBrace: true, retryPerformed: true });
    expect(requests).toHaveLength(2);
  });

  it('6 null message content -> provider_invalid_response', async () => {
    const { body } = await run([{ body: chat(null) }]);
    expect(body.detail.code).toBe('provider_invalid_response');
    expect(body.detail.diagnostic.contentType).toBe('null');
  });

  it('empty string message content -> provider_empty_content', async () => {
    const { body } = await run([{ body: chat('  ') }]);
    expect(body.detail.code).toBe('provider_empty_content');
  });

  it('8 body is consumed exactly once with text() and json() is never called', async () => {
    const { reads } = await run([{ body: OK }]);
    expect(reads).toEqual({ text: 1, json: 0 });
  });

  it('9/10 one retry succeeds after an empty first response, omits response_format, and makes no third request', async () => {
    const { res, requests, logs } = await run([{ body: '' }, { body: OK }, { body: OK }]);
    expect(res.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[1]).not.toHaveProperty('response_format');
    expect(requests[1]).toMatchObject({ stream: false, max_tokens: 8192 });
    const retryMessages = (requests[1] as { messages: { content: string }[] }).messages;
    expect(retryMessages.at(-1)?.content).toMatch(/ONE json object only/);
    expect(retryMessages).toHaveLength(3);
    expect(JSON.stringify(retryMessages)).not.toContain('chatcmpl');
    expect(logs).toContain('provider-retry-succeeded');
  });

  it('10 never makes a third request when both attempts fail', async () => {
    const { requests } = await run([{ body: 'null' }, { body: 'null' }, { body: OK }]);
    expect(requests).toHaveLength(2);
  });

  it.each([[401, 'provider_unauthorized'], [402, 'provider_payment_required'], [403, 'provider_forbidden'], [404, 'provider_not_found'], [429, 'provider_rate_limited']])('11 HTTP %i is not retried', async (status, code) => {
    const { body, requests } = await run([{ status, body: 'RAW_BODY_SECRET' }, { body: OK }]);
    expect(body.detail.code).toBe(code);
    expect(requests).toHaveLength(1);
  });

  it('12 raw bodies and credentials never appear in errors or logs', async () => {
    for (const bad of ['RAW_BODY_SECRET ' + HTML, '[' + KEY + ']', chat('RAW_BODY_SECRET ' + HTML), JSON.stringify({ error: { message: 'RAW_BODY_SECRET ' + KEY } })]) {
      const { text, logs } = await run([{ body: bad }]);
      expectNoLeak(text, logs);
    }
  });

  it('13 frontend schema accepts the final successful response', async () => {
    const { body } = await run([{ body: '' }, { body: OK }]);
    const parsed = normalizeGeneratedContent(unwrapGenerationBody(body));
    expect(parsed.indexHtml).toContain('BODY_HTML_MARKER');
    expect(parsed.title).toBe('Todo');
  });
});
