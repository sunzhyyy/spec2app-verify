import { createClient } from '@metagptx/web-sdk';
import { validateLiveResponse, type GeneratedFiles, type GenerationResponse } from './core';
import { GenerationFailure, type GenerationErrorCode } from './provider';

const client = createClient();
const TIMEOUT_MS = 200_000;
/** Build-time switch (not a secret): 'edgeone' or 'vercel' use the same-origin /api/generate function, otherwise the Atoms Cloud endpoint. */
const TARGET = ['vercel', 'edgeone'].includes(import.meta.env.VITE_GENERATION_TARGET ?? '') ? 'vercel' : 'atoms';

export interface GenerateInput {
  prompt: string;
  history: string[];
  currentFiles: GeneratedFiles | null;
}

function toFailure(e: unknown): GenerationFailure {
  if (e instanceof GenerationFailure) return e;
  const err = e as { data?: { detail?: unknown }; response?: { data?: { detail?: unknown }; status?: number }; message?: string; code?: string };
  const detail = err?.response?.data?.detail ?? err?.data?.detail;
  if (detail && typeof detail === 'object' && 'code' in detail) {
    const d = detail as { code: GenerationErrorCode; message: string; providerInvoked?: boolean };
    return new GenerationFailure(d.code, d.message, Boolean(d.providerInvoked));
  }
  if (typeof detail === 'string') return new GenerationFailure('provider_unavailable', detail, false);
  if (err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message ?? '')) return new GenerationFailure('timeout', 'The generation request timed out.', false);
  return new GenerationFailure('network', err?.message || 'Network error while contacting the generation endpoint.', false);
}

export async function requestGeneration(input: GenerateInput): Promise<GenerationResponse> {
  let raw: unknown;
  try {
    if (TARGET === 'vercel') {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw { response: { data: body, status: res.status }, message: `HTTP ${res.status}` };
      raw = body;
    } else {
      const res = await client.apiCall.invoke({ url: '/api/v1/generate/page', method: 'POST', data: input, options: { timeout: TIMEOUT_MS } });
      raw = res.data;
    }
  } catch (e) {
    throw toFailure(e);
  }
  const checked = validateLiveResponse(raw, input.prompt);
  if ('message' in checked) throw new GenerationFailure('schema_invalid', `Server response failed validation: ${checked.message}`, true);
  return checked.data as GenerationResponse;
}
