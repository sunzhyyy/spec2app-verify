/**
 * Portable Node.js production server (e.g. Zeabur).
 * Serves the Vite `dist` build, exposes POST /api/generate via the shared handler, and falls back to index.html for SPA routes.
 * Env: PORT (platform-assigned), AI_API_KEY, AI_BASE_URL, AI_MODEL. Keys are never logged or returned.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleGenerate } from '../api/generate';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const MAX_BODY = 2_000_000;

export interface AppOptions {
  distDir: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/** Platform-assigned port; 3000 only when PORT is absent (local runs). */
export function resolvePort(env: Record<string, string | undefined>): number {
  const n = Number(env.PORT);
  return Number.isInteger(n) && n >= 0 && n < 65536 && env.PORT?.trim() ? n : 3000;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('too_large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function sendFile(res: ServerResponse, file: string, cache: boolean) {
  const data = await readFile(file);
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': cache ? 'public, max-age=31536000, immutable' : 'no-cache' });
  res.end(data);
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

export function createApp({ distDir, env = process.env, fetchImpl = fetch }: AppOptions): Server {
  const root = resolve(distDir);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = decodeURIComponent(url.pathname);

      if (path === '/healthz') return sendJson(res, 200, { ok: true });

      if (path === '/api/generate') {
        if (req.method !== 'POST') return sendJson(res, 405, { detail: { code: 'invalid_request', message: 'Use POST.', providerInvoked: false } });
        let body: string;
        try {
          body = await readBody(req);
        } catch {
          return sendJson(res, 413, { detail: { code: 'invalid_request', message: 'Request body too large.', providerInvoked: false } });
        }
        const request = new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        const out = await handleGenerate(request, env, fetchImpl);
        res.writeHead(out.status, { 'content-type': out.headers.get('content-type') ?? 'application/json; charset=utf-8' });
        return res.end(await out.text());
      }
      if (path.startsWith('/api/')) return sendJson(res, 404, { detail: { code: 'invalid_request', message: 'Unknown API route.', providerInvoked: false } });
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { detail: { code: 'invalid_request', message: 'Method not allowed.', providerInvoked: false } });

      const file = normalize(join(root, path));
      if (file.startsWith(root + sep)) {
        const info = await stat(file).catch(() => null);
        if (info?.isFile()) return await sendFile(res, file, path.startsWith('/assets/'));
      }
      if (extname(path) && path.startsWith('/assets/')) return sendJson(res, 404, { detail: { code: 'not_found', message: 'Asset not found.', providerInvoked: false } });
      return await sendFile(res, join(root, 'index.html'), false);
    } catch {
      if (!res.headersSent) sendJson(res, 500, { detail: { code: 'provider_unavailable', message: 'Unexpected server error.', providerInvoked: false } });
      else res.end();
    }
  });
}

const isMain = typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const distDir = process.env.DIST_DIR ?? resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
  const port = resolvePort(process.env);
  createApp({ distDir }).listen(port, '0.0.0.0', () => {
    console.log(`spec2app server listening on 0.0.0.0:${port} (AI configured: ${Boolean(process.env.AI_API_KEY && process.env.AI_BASE_URL)})`);
  });
}
