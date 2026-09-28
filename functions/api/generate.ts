/**
 * Tencent EdgeOne Pages Function: POST /api/generate
 * Reuses the same handler and validation as the Vercel function (api/generate.ts).
 * Env (server-side only, set in the EdgeOne Pages console): AI_API_KEY, AI_BASE_URL, AI_MODEL.
 */
import { handleGenerate, type ProviderFetchOptions } from '../../api/generate';

interface EdgeOneContext {
  request: Request;
  env: Record<string, string | undefined>;
  /** Test seam only; EdgeOne never supplies it. */
  fetchImpl?: typeof fetch;
}

/** EdgeOne's default 15 s fetch read timeout is too short for long model responses. */
export const EDGEONE_TIMEOUT_SETTING = { connectTimeout: 60_000, readTimeout: 300_000, writeTimeout: 60_000 } as const;

/** The portable AbortController timeout stays above the EdgeOne read timeout. */
export const EDGEONE_FETCH_OPTIONS: ProviderFetchOptions = {
  extraInit: { eo: { timeoutSetting: EDGEONE_TIMEOUT_SETTING } },
  minTimeoutMs: EDGEONE_TIMEOUT_SETTING.readTimeout + 10_000,
};

export function onRequestPost(context: EdgeOneContext): Promise<Response> {
  return handleGenerate(context.request, context.env ?? {}, context.fetchImpl ?? fetch, EDGEONE_FETCH_OPTIONS);
}
