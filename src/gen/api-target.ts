/** Build-time switch (not a secret): 'node', 'edgeone' or 'vercel' use the same-origin /api/generate function, otherwise the Atoms Cloud endpoint. */
const EDGEONE_HOST = /\.(edgeone\.app|edgeone\.run|edgeone\.cool)$/i;
export function resolveTarget(flag: string | undefined, hostname: string): 'serverless' | 'atoms' {
  if (flag === 'vercel' || flag === 'edgeone' || flag === 'node') return 'serverless';
  if (flag !== 'atoms' && (EDGEONE_HOST.test(hostname) || /\.vercel\.app$/i.test(hostname))) return 'serverless';
  return 'atoms';
}
