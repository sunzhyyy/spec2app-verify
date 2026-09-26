/**
 * Tencent EdgeOne Pages Function: POST /api/generate
 * Reuses the same handler and validation as the Vercel function (api/generate.ts).
 * Env (server-side only, set in the EdgeOne Pages console): AI_API_KEY, AI_BASE_URL, AI_MODEL.
 */
import { handleGenerate } from '../../api/generate';

interface EdgeOneContext {
  request: Request;
  env: Record<string, string | undefined>;
}

export function onRequestPost(context: EdgeOneContext): Promise<Response> {
  return handleGenerate(context.request, context.env ?? {});
}
