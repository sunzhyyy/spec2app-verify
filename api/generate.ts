/**
 * Vercel serverless function: POST /api/generate
 * Env (server-side only): AI_API_KEY, AI_BASE_URL, AI_MODEL. Keys are never returned or logged.
 */
import { GenerationFailure, parseProviderEnvelope, type GenerationErrorCode, buildMessages, normalizeGeneratedContent, type GenerateRequestBody } from '../src/gen/provider';

const nodeEnv: Record<string, string | undefined> = typeof process !== 'undefined' && process.env ? process.env : {};
const TIMEOUT_MS = Number(nodeEnv.AI_TIMEOUT_MS ?? 170_000);
/** Output budget: DeepSeek's documented chat maximum; override with AI_MAX_TOKENS for models with larger limits. */
const DEFAULT_MAX_TOKENS = 8192; // DeepSeek chat output ceiling; override with AI_MAX_TOKENS.
/** Failures that get exactly one retry. All occur only after an HTTP 200; 401/402/403/404/429, network and timeout are never retried. */
const RETRYABLE = new Set<string>(['provider_empty_response', 'provider_empty_content', 'provider_invalid_json', 'provider_invalid_response', 'malformed_json', 'provider_output_truncated']);
/** Body-level failures where the retry may omit response_format for compatibility. */
const COMPAT_RETRY = new Set<string>(['provider_empty_response', 'provider_invalid_json']);
const MAX_ATTEMPTS = 2;
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

/** Safe body metadata: lengths and leading-character flags only, never the body itself. */
export function bodyMeta(upstreamStatus: number, upstreamContentType: string, rawBody: string) {
  const t = rawBody.trim();
  return {
    upstreamStatus,
    upstreamContentType: upstreamContentType.replace(/[^\w/;=.+ -]/g, '').slice(0, 80),
    bodyLength: rawBody.length,
    bodyTrimmedLength: t.length,
    bodyIsEmpty: t.length === 0,
    bodyIsLiteralNull: t === 'null',
    bodyStartsWithBrace: t.startsWith('{'),
    bodyStartsWithBracket: t.startsWith('['),
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

/** Platform-specific fetch extras. Only EdgeOne supplies `eo`; Vercel and Node pass nothing. */
export interface ProviderFetchOptions {
  /** Extra RequestInit fields merged into the provider fetch (e.g. EdgeOne `eo.timeoutSetting`). */
  extraInit?: Record<string, unknown>;
  /** Lower bound for the portable AbortController timeout so it never fires before the platform timeout. */
  minTimeoutMs?: number;
}

/** True when a runtime error signals a platform read/connect timeout (EdgeOne reports `net_exception_timeout`). */
export function isPlatformTimeout(e: unknown): boolean {
  const m = `${(e as { name?: unknown })?.name ?? ''} ${(e as { message?: unknown })?.message ?? ''}`;
  return /net_exception_timeout|TimeoutError/i.test(m);
}

export async function handleGenerate(request: Request, env: Record<string, string | undefined> = nodeEnv, fetchImpl: typeof fetch = fetch, opts: ProviderFetchOptions = {}): Promise<Response> {
  const started = Date.now();
  try {
    const body = readBody(await request.json().catch(() => null));
    const { AI_API_KEY: key, AI_BASE_URL: base, AI_MODEL: model = 'gpt-4o-mini' } = env;
    if (!key || !base) throw new GenerationFailure('not_configured', 'AI_API_KEY and AI_BASE_URL are not configured on the server.', false);

    const url = providerUrl(base);
    const fetchStarted = Date.now();
    const timeoutMs = Math.max(Number(env.AI_TIMEOUT_MS ?? TIMEOUT_MS) || TIMEOUT_MS, opts.minTimeoutMs ?? 0);
    // Portable timeout: EdgeOne lacks AbortSignal.timeout(), so use AbortController + setTimeout everywhere.
    const maxTokens = Math.floor(Number(env.AI_MAX_TOKENS)) > 0 ? Math.floor(Number(env.AI_MAX_TOKENS)) : DEFAULT_MAX_TOKENS;
    const baseConfig = { model, stream: false, temperature: 0.4, max_tokens: maxTokens };
    /** One provider attempt with its own AbortController timer; the timer is always cleared. The body is read exactly once as text. */
    const attempt = async (strict: boolean, withResponseFormat: boolean) => {
      const requestConfig = withResponseFormat ? { ...baseConfig, response_format: { type: 'json_object' as const } } : baseConfig;
      const request = requestMeta(requestConfig, url);
      const controller = new AbortController();
      let timeoutTriggered = false;
      const timer = setTimeout(() => {
        timeoutTriggered = true;
        controller.abort();
      }, timeoutMs);
      let meta: ReturnType<typeof bodyMeta>;
      let envelope: unknown;
      try {
        let res: Response;
        try {
          res = await fetchImpl(url, {
            ...(opts.extraInit ?? {}),
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({ ...requestConfig, messages: buildMessages(body, strict) }),
            signal: controller.signal,
          } as RequestInit);
        } catch (e) {
          const diagnostic = { ...fetchDiagnostic(e, url, Date.now() - fetchStarted, [key, base, body.prompt]), timeoutTriggered };
          console.log({ stage: 'provider-fetch-exception', ...diagnostic });
          if (timeoutTriggered || isPlatformTimeout(e)) throw new GenerationFailure('provider_timeout', 'The AI provider timed out.', true, { diagnostic });
          throw new GenerationFailure('provider_unavailable', 'Could not reach the AI provider.', true, { diagnostic });
        }
        if (!res.ok) {
          const code = UPSTREAM[res.status] ?? 'provider_http_error';
          throw new GenerationFailure(code, `The AI provider returned HTTP ${res.status}.`, true, { upstreamStatus: res.status });
        }
        const contentType = res.headers.get('content-type') ?? '';
        let rawBody: string;
        try {
          rawBody = await res.text();
        } catch (e) {
          const diagnostic = { ...fetchDiagnostic(e, url, Date.now() - fetchStarted, [key, base, body.prompt]), timeoutTriggered, upstreamStatus: res.status };
          if (timeoutTriggered || isPlatformTimeout(e)) throw new GenerationFailure('provider_timeout', 'The AI provider timed out.', true, { diagnostic });
          throw new GenerationFailure('provider_unavailable', 'Could not read the AI provider response.', true, { diagnostic });
        }
        meta = bodyMeta(res.status, contentType, rawBody);
        const trimmed = rawBody.trim();
        if (!trimmed || trimmed === 'null') {
          throw new GenerationFailure('provider_empty_response', 'The AI provider returned an empty response body.', true, { diagnostic: { ...meta, parseErrorName: null, request } });
        }
        try {
          envelope = JSON.parse(trimmed);
        } catch (e) {
          const parseErrorName = ((e as Error)?.name ?? 'Error').replace(/[^A-Za-z]/g, '').slice(0, 40);
          throw new GenerationFailure('provider_invalid_json', 'The AI provider response body is not valid JSON.', true, { diagnostic: { ...meta, parseErrorName, request } });
        }
      } finally {
        clearTimeout(timer);
      }
      try {
        return parseProviderEnvelope(envelope, meta.upstreamStatus, request);
      } catch (e) {
        if (e instanceof GenerationFailure) e.extra = { ...e.extra, diagnostic: { ...meta, ...((e.extra?.diagnostic as object) ?? {}), request } };
        throw e;
      }
    };
    let files;
    let firstFailureCode: string | null = null;
    try {
      files = await attempt(false, true);
    } catch (e) {
      if (!(e instanceof GenerationFailure) || !RETRYABLE.has(e.code) || MAX_ATTEMPTS < 2) throw e;
      firstFailureCode = e.code;
      const compatibility = COMPAT_RETRY.has(e.code);
      console.log({ stage: 'provider-retry', attemptNumber: 2, firstFailureCode, compatibilityRetry: compatibility, ...((e.extra?.diagnostic as object) ?? {}) });
      try {
        files = await attempt(true, !compatibility);
      } catch (retryError) {
        if (retryError instanceof GenerationFailure) {
          const diagnostic = { ...((retryError.extra?.diagnostic as object) ?? {}), attemptNumber: 2, firstFailureCode, retryPerformed: true, retrySucceeded: false, compatibilityRetry: compatibility };
          retryError.extra = { ...retryError.extra, diagnostic };
          console.log({ stage: 'provider-retry-failed', code: retryError.code, ...diagnostic });
        }
        throw retryError;
      }
      console.log({ stage: 'provider-retry-succeeded', attemptNumber: 2, firstFailureCode, retryPerformed: true, retrySucceeded: true, compatibilityRetry: compatibility });
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
