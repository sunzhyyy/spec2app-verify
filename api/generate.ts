/**
 * Vercel serverless function: POST /api/generate
 * Env (server-side only): AI_API_KEY, AI_BASE_URL, AI_MODEL. Keys are never returned or logged.
 */
import { GenerationFailure, parseProviderEnvelope, type GenerationErrorCode, type ProviderEnvelope, buildMessages, normalizeGeneratedContent, type GenerateRequestBody } from '../src/gen/provider';

const nodeEnv: Record<string, string | undefined> = typeof process !== 'undefined' && process.env ? process.env : {};
const TIMEOUT_MS = Number(nodeEnv.AI_TIMEOUT_MS ?? 170_000);
/** Output budget: DeepSeek's documented chat maximum; override with AI_MAX_TOKENS for models with larger limits. */
const DEFAULT_MAX_TOKENS = 8192; // DeepSeek chat output ceiling; override with AI_MAX_TOKENS.
const RETRYABLE = new Set<string>(['provider_empty_response', 'malformed_json', 'provider_output_truncated']);
const STATUS: Record<string, number> = { timeout: 504, provider_timeout: 504, quota_exhausted: 429, provider_rate_limited: 429, invalid_request: 422, not_configured: 503 };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const fail = (e: GenerationFailure) => json(STATUS[e.code] ?? 502, { detail: { code: e.code, message: e.message, providerInvoked: e.providerInvoked, ...(e.extra ?? {}) } });

function readBody(raw: unknown): GenerateRequestBody {
  const b = raw as GenerateRequestBody;
  if (!b || typeof b.prompt !== 'string' || !b.prompt.trim() || b.prompt.length > 4000) {
    throw new GenerationFailure('invalid_request', 'Prompt must be 1-4000 characters.', false);
  }
  const history = Array.isArray(b.history) ? b.history.filter((h) => typeof h === 'string').slice(-12) : [];
  return { prompt: b.prompt.trim(), history, currentFiles: b.currentFiles ?? null };
}

/** Joins AI_BASE_URL and the chat path, tolerating trailing slashes or an already-appended path. */
export function providerUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  return `${trimmed}/chat/completions`;
}

const UPSTREAM: Record<number, GenerationErrorCode> = { 401: 'provider_unauthorized', 402: 'provider_payment_required', 403: 'provider_forbidden', 404: 'provider_not_found', 429: 'provider_rate_limited' };

/** Removes secrets, URLs with query strings, and long tokens from a network error message. */
export function sanitizeMessage(message: unknown, secrets: (string | undefined)[]): string {
  let m = typeof message === 'string' ? message : '';
  for (const s of secrets) if (s && s.length >= 4) m = m.split(s).join('[redacted]');
  m = m.replace(/bearer\s+\S+/gi, 'Bearer [redacted]').replace(/(sk|key|token)[-_][A-Za-z0-9_-]{6,}/gi, '[redacted]').replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').replace(/\?[^\s]*/g, '');
  return m.slice(0, 200);
}

/** Safe request metadata: configuration only, never messages, prompt or credentials. */
export function requestMeta(cfg: Record<string, unknown>, url: string) {
  let requestUrl = 'invalid';
  try { const u = new URL(url); requestUrl = `${u.origin}${u.pathname}`; } catch { /* invalid base url */ }
  const rf = cfg.response_format as { type?: unknown } | undefined;
  const th = cfg.thinking as { type?: unknown } | undefined;
  return {
    requestUrl,
    requestedModel: typeof cfg.model === 'string' ? cfg.model.slice(0, 80) : null,
    streamValue: typeof cfg.stream === 'boolean' ? cfg.stream : null,
    responseFormatType: typeof rf?.type === 'string' ? rf.type : null,
    ...(th && typeof th.type === 'string' ? { thinkingType: th.type } : {}),
    maxTokensPresent: typeof cfg.max_tokens === 'number',
    maxTokensValue: typeof cfg.max_tokens === 'number' ? cfg.max_tokens : null,
  };
}

/** Safe fetch-exception diagnostic: names, network code, host/path, elapsed. No key, headers, prompt or body. */
export function fetchDiagnostic(e: unknown, url: string, elapsedMs: number, secrets: (string | undefined)[]) {
  const err = (e ?? {}) as { name?: unknown; message?: unknown; cause?: { code?: unknown } };
  let providerHost = '';
  let providerPath = '';
  try { const u = new URL(url); providerHost = u.hostname; providerPath = u.pathname; } catch { /* invalid base url */ }
  const safe = (v: unknown) => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60) : null);
  return {
    providerHost,
    providerPath,
    exceptionName: safe(err.name) ?? 'Unknown',
    constructorName: safe((e as object | null)?.constructor?.name) ?? 'Unknown',
    causeCode: safe(err.cause?.code),
    message: sanitizeMessage(err.message, secrets),
    elapsedMs,
  };
}

const REQUIRED = ['title', 'summary', 'indexHtml', 'stylesCss', 'scriptJs', 'readme', 'generationNotes'] as const;

/** Rejects any success payload whose `response` is not a plain object with string files. Logs types/keys only. */
export function assertSuccessContract(payload: unknown): void {
  const r = (payload as { response?: unknown } | null)?.response;
  const isObj = !!r && typeof r === 'object' && !Array.isArray(r);
  console.log({ stage: 'success-contract', topLevelType: typeof payload, responseType: typeof r, responseIsArray: Array.isArray(r), responseKeys: isObj ? Object.keys(r as object) : [] });
  const o = r as Record<string, unknown>;
  if (!payload || typeof payload !== 'object' || !isObj || REQUIRED.some((k) => typeof o[k] !== 'string') || o.generationMode !== 'live' || o.providerInvoked !== true) {
    throw new GenerationFailure('schema_invalid', 'The server built an invalid success payload.', true);
  }
}

export async function handleGenerate(request: Request, env: Record<string, string | undefined> = nodeEnv, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const started = Date.now();
  try {
    const body = readBody(await request.json().catch(() => null));
    const { AI_API_KEY: key, AI_BASE_URL: base, AI_MODEL: model = 'gpt-4o-mini' } = env;
    if (!key || !base) throw new GenerationFailure('not_configured', 'AI_API_KEY and AI_BASE_URL are not configured on the server.', false);

    const url = providerUrl(base);
    const fetchStarted = Date.now();
    const timeoutMs = Number(env.AI_TIMEOUT_MS ?? TIMEOUT_MS) || TIMEOUT_MS;
    // Portable timeout: EdgeOne lacks AbortSignal.timeout(), so use AbortController + setTimeout everywhere.
    const maxTokens = Math.floor(Number(env.AI_MAX_TOKENS)) > 0 ? Math.floor(Number(env.AI_MAX_TOKENS)) : DEFAULT_MAX_TOKENS;
    /** One provider attempt with its own AbortController timer; the timer is always cleared. */
    const requestConfig = { model, temperature: 0.4, max_tokens: maxTokens, response_format: { type: 'json_object' as const } };
    const attempt = async (strict: boolean) => {
      const controller = new AbortController();
      let timeoutTriggered = false;
      const timer = setTimeout(() => {
        timeoutTriggered = true;
        controller.abort();
      }, timeoutMs);
      let envelope: ProviderEnvelope | null;
      let upstreamStatus = 0;
      try {
        let res: Response;
        try {
          res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({ ...requestConfig, messages: buildMessages(body, strict) }),
            signal: controller.signal,
          });
        } catch (e) {
          const diagnostic = { ...fetchDiagnostic(e, url, Date.now() - fetchStarted, [key, base, body.prompt]), timeoutTriggered };
          console.log({ stage: 'provider-fetch-exception', ...diagnostic });
          if (timeoutTriggered) throw new GenerationFailure('provider_timeout', 'The AI provider timed out.', true, { diagnostic });
          throw new GenerationFailure('provider_unavailable', 'Could not reach the AI provider.', true, { diagnostic });
        }
        upstreamStatus = res.status;
        if (!res.ok) {
          const code = UPSTREAM[res.status] ?? 'provider_http_error';
          throw new GenerationFailure(code, `The AI provider returned HTTP ${res.status}.`, true, { upstreamStatus: res.status });
        }
        envelope = (await res.json().catch(() => {
          if (timeoutTriggered) throw new GenerationFailure('provider_timeout', 'The AI provider timed out.', true, { diagnostic: { timeoutTriggered } });
          return null;
        })) as typeof envelope;
      } finally {
        clearTimeout(timer);
      }
      return parseProviderEnvelope(envelope, upstreamStatus, requestMeta(requestConfig, url));
    };
    let files;
    try {
      files = await attempt(false);
    } catch (e) {
      // One bounded retry for content-quality failures only; never auth, payment, rate-limit, network or timeout.
      if (!(e instanceof GenerationFailure) || !RETRYABLE.has(e.code)) throw e;
      console.log({ stage: 'provider-retry', reason: e.code, ...((e.extra?.diagnostic as object) ?? {}) });
      files = await attempt(true);
    }
    const successPayload = {
      response: {
        ...files,
        generationMode: 'live' as const,
        providerInvoked: true as const,
        provider: `openai-compatible:${model}`,
        receivedPrompt: body.prompt,
        durationMs: Date.now() - started,
      },
    };
    assertSuccessContract(successPayload);
    return json(200, successPayload);
  } catch (e) {
    if (e instanceof GenerationFailure) return fail(e);
    return fail(new GenerationFailure('provider_unavailable', 'Unexpected server error.', false));
  }
}

export function POST(request: Request): Promise<Response> {
  return handleGenerate(request);
}
