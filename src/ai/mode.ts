export type AiMode = 'demo' | 'http';

/** Demo Mode is the default; HTTP mode only when a non-empty endpoint is configured. */
export function resolveAiMode(endpoint: string | undefined): AiMode {
  return endpoint && endpoint.trim() !== '' ? 'http' : 'demo';
}

export const AI_MODE: AiMode = resolveAiMode(import.meta.env.VITE_AI_ENDPOINT);
