/**
 * Vercel serverless function: POST /api/generate
 * Env (server-side only): AI_API_KEY, AI_BASE_URL, AI_MODEL. Keys are never returned or logged.
 */
import { GenerationFailure, buildMessages, parseProviderContent, type GenerateRequestBody } from '../src/gen/provider';

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS ?? 170_000);
const STATUS: Record<string, number> = { timeout: 504, quota_exhausted: 429, invalid_request: 422, not_configured: 503 };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (e: GenerationFailure) => json(STATUS[e.code] ?? 502, { detail: { code: e.code, message: e.message, providerInvoked: e.providerInvoked } });

function readBody(raw: unknown): GenerateRequestBody {
  const b = raw as GenerateRequestBody;
  if (!b || typeof b.prompt !== 'string' || !b.prompt.trim() || b.prompt.length > 4000) {
    throw new GenerationFailure('invalid_request', 'Prompt must be 1-4000 characters.', false);
  }
  const history = Array.isArray(b.history) ? b.history.filter((h) => typeof h === 'string').slice(-12) : [];
  return { prompt: b.prompt.trim(), history, currentFiles: b.currentFiles ?? null };
}

export async function handleGenerate(request: Request, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const started = Date.now();
  try {
    const body = readBody(await request.json().catch(() => null));
    const { AI_API_KEY: key, AI_BASE_URL: base, AI_MODEL: model = 'gpt-4o-mini' } = env;
    if (!key || !base) throw new GenerationFailure('not_configured', 'AI_API_KEY and AI_BASE_URL are not configured on the server.', false);

    let res: Response;
    try {
      res = await fetchImpl(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: buildMessages(body), temperature: 0.4 }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new GenerationFailure('timeout', 'The AI provider timed out.', true);
      throw new GenerationFailure('provider_unavailable', 'Could not reach the AI provider.', true);
    }
    if (res.status === 402 || res.status === 429) throw new GenerationFailure('quota_exhausted', `The AI provider rejected the request (HTTP ${res.status}).`, true);
    if (!res.ok) throw new GenerationFailure('provider_unavailable', `The AI provider returned HTTP ${res.status}.`, true);

    const envelope = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
    const content = envelope?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new GenerationFailure('malformed_json', 'The AI provider returned an unexpected response envelope.', true);

    const files = parseProviderContent(content);
    return json(200, {
      ...files,
      generationMode: 'live',
      providerInvoked: true,
      provider: `openai-compatible:${model}`,
      receivedPrompt: body.prompt,
      durationMs: Date.now() - started,
    });
  } catch (e) {
    if (e instanceof GenerationFailure) return fail(e);
    return fail(new GenerationFailure('provider_unavailable', 'Unexpected server error.', false));
  }
}

export function POST(request: Request): Promise<Response> {
  return handleGenerate(request);
}
