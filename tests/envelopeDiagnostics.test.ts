import { describe, expect, it } from 'vitest';
import { handleGenerate } from '../api/generate';
import { envelopeShape } from '../src/gen/provider';

const KEY = 'sk-live-ENVELOPEsecret1234567890abcdef';
const PROMPT = 'Create a simple todo app with add, complete, and delete actions.';
const HTML = '<!doctype html><html><body><main>SECRET_HTML_MARKER</main></body></html>';
const ENV = { AI_API_KEY: KEY, AI_BASE_URL: 'https://api.deepseek.com', AI_MODEL: 'deepseek-chat' };

async function run(envelope: unknown) {
  const urls: string[] = [];
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(JSON.stringify(a)); };
  const fetchImpl = (async (u: string) => {
    urls.push(u);
    return new Response(JSON.stringify(envelope), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  try {
    const res = await handleGenerate(new Request('http://x/api/generate', { method: 'POST', body: JSON.stringify({ prompt: PROMPT }) }), ENV, fetchImpl);
    const text = await res.text();
    return { text, body: JSON.parse(text), urls, logs: logs.join('\n') };
  } finally {
    console.log = orig;
  }
}

function expectNoLeak(...texts: string[]) {
  for (const t of texts) for (const leak of [HTML, 'SECRET_HTML_MARKER', PROMPT, KEY, 'Bearer', 'RAW_CONTENT', 'THINKING_SECRET', 'ERR_MSG_SECRET', 'chatcmpl-ABC123']) expect(t).not.toContain(leak);
}

describe('safe provider envelope diagnostics', () => {
  it('normal envelope reports contentType string', () => {
    const shape = envelopeShape({ id: 'chatcmpl-ABC123', model: 'deepseek-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'RAW_CONTENT' }, finish_reason: 'stop' }] });
    expect(shape).toMatchObject({ responseJsonType: 'object', objectHasChoices: true, choicesType: 'array', choicesCount: 1, firstChoiceType: 'object', messagePresent: true, messageType: 'object', messageKeys: ['content', 'role'], contentType: 'string', idPrefix: 'chatcmpl', modelPresent: true });
    expectNoLeak(JSON.stringify(shape));
  });

  it('empty choices are diagnosed safely and request goes to the exact endpoint', async () => {
    const { body, urls, text, logs } = await run({ id: 'chatcmpl-ABC123', choices: [] });
    expect(urls).toEqual(['https://api.deepseek.com/chat/completions', 'https://api.deepseek.com/chat/completions']);
    expect(body.detail.code).toBe('provider_invalid_response');
    expect(body.detail.diagnostic).toMatchObject({ choicesType: 'array', choicesCount: 0, firstChoiceType: 'missing', messagePresent: false, contentType: 'missing' });
    expect(body.detail.diagnostic.request).toEqual({ requestUrl: 'https://api.deepseek.com/chat/completions', requestedModel: 'deepseek-chat', streamValue: false, responseFormatType: 'json_object', maxTokensPresent: true, maxTokensValue: 8192 });
    expectNoLeak(text, logs);
  });

  it('missing message is diagnosed safely', async () => {
    const { body } = await run({ choices: [{ index: 0, finish_reason: 'stop' }] });
    expect(body.detail.diagnostic).toMatchObject({ firstChoiceKeys: ['finish_reason', 'index'], messagePresent: false, messageType: 'missing', contentType: 'missing' });
  });

  it('null content is diagnosed safely', async () => {
    const { body, text } = await run({ choices: [{ message: { role: 'assistant', content: null, reasoning_content: 'THINKING_SECRET' } }] });
    expect(body.detail.diagnostic).toMatchObject({ contentType: 'null', reasoningContentPresent: true, messagePresent: true });
    expectNoLeak(text);
  });

  it('array content is diagnosed safely', async () => {
    const { body, text } = await run({ choices: [{ message: { content: [{ type: 'text', text: 'RAW_CONTENT' + HTML }] } }] });
    expect(body.detail.code).toBe('provider_invalid_response');
    expect(body.detail.diagnostic.contentType).toBe('array');
    expectNoLeak(text);
  });

  it('top-level error object does not expose its message or body', async () => {
    const { body, text, logs } = await run({ error: { message: 'ERR_MSG_SECRET ' + KEY, type: 'invalid_request_error' } });
    expect(body.detail.diagnostic).toMatchObject({ errorFieldPresent: true, errorType: 'object', objectHasChoices: false, choicesType: 'missing', topLevelKeys: ['error'] });
    expectNoLeak(text, logs);
  });

  it('non-object responses never leak raw content, HTML, prompt or credentials', async () => {
    for (const env of ['RAW_CONTENT ' + HTML + KEY, [HTML], null]) {
      const { body, text, logs } = await run(env);
      if (env === null) {
        expect(body.detail.code).toBe('provider_empty_response');
        expect(body.detail.diagnostic.bodyIsLiteralNull).toBe(true);
      } else {
        expect(['provider_invalid_response', 'provider_invalid_json']).toContain(body.detail.code);
      }
      expectNoLeak(text, logs);
    }
  });
});
