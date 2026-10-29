import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from './util.ts';

const DIR = join(CACHE_DIR, 'icons');
const MAX_BYTES = 4 * 1024 * 1024;
const REMOTE_TTL_MS = 7 * 86_400_000;
const LOCAL_TTL_MS = 10 * 60_000;
const MISS_TTL_MS = 6 * 3600_000;

type Meta = { type?: string; at: number; missing?: boolean };
export type Icon = { type: string; body: Buffer } | null;

const isLocal = (u: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.localhost');

async function get(url: string, accept: string) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5_000), headers: { Accept: accept, 'User-Agent': 'Mozilla/5.0 (Porto favicon)' } });
  if (!res.ok) throw new Error(String(res.status));
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('grande demais');
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error('grande demais');
  return { body, type: res.headers.get('content-type') ?? '', finalUrl: res.url };
}

const looksLikeImage = (type: string, body: Buffer) =>
  /^image\//.test(type) || body.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])) || body.subarray(0, 8).toString('latin1').includes('PNG') || /<svg/i.test(body.subarray(0, 300).toString());

/** Escolhe o maior ícone declarado no HTML (apple-touch-icon costuma ser o de melhor resolução). */
function iconCandidates(html: string, base: string) {
  const found: { href: string; score: number }[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /rel=["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    if (!/\bicon\b|apple-touch-icon/.test(rel)) continue;
    const href = /href=["']?([^"' >]+)/i.exec(tag)?.[1];
    if (!href) continue;
    const size = Number(/sizes=["']?(\d+)/i.exec(tag)?.[1] ?? 0);
    const score = (rel.includes('apple') ? 180 : size || 32) + (/\.svg(\?|$)/i.test(href) ? 500 : 0);
    try {
      found.push({ href: new URL(href.replace(/&amp;/g, '&'), base).href, score });
    } catch {
      // href inválido.
    }
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.href);
}

async function discover(origin: string): Promise<Icon> {
  const candidates: string[] = [];
  try {
    const page = await get(origin + '/', 'text/html');
    if (/html/i.test(page.type)) candidates.push(...iconCandidates(page.body.toString('utf8'), page.finalUrl));
  } catch {
    // Sem HTML: tenta só o /favicon.ico.
  }
  candidates.push(origin + '/favicon.ico');
  for (const url of candidates.slice(0, 4)) {
    try {
      const icon = await get(url, 'image/*');
      if (looksLikeImage(icon.type, icon.body)) return { type: icon.type.startsWith('image/') ? icon.type : 'image/x-icon', body: icon.body };
    } catch {
      // Próximo candidato.
    }
  }
  return null;
}

const pending = new Map<string, Promise<Icon>>();

export async function favicon(raw: string): Promise<Icon> {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const origin = u.origin;
  const id = createHash('sha1').update(origin).digest('hex');
  const metaPath = join(DIR, `${id}.json`);
  const bodyPath = join(DIR, `${id}.bin`);
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Meta;
    const ttl = meta.missing ? MISS_TTL_MS : isLocal(u) ? LOCAL_TTL_MS : REMOTE_TTL_MS;
    if (Date.now() - meta.at < ttl) return meta.missing ? null : { type: meta.type!, body: await readFile(bodyPath) };
  } catch {
    // Sem cache.
  }
  let p = pending.get(origin);
  if (!p) {
    p = discover(origin).then(async (icon) => {
      await mkdir(DIR, { recursive: true });
      if (icon) await writeFile(bodyPath, icon.body);
      await writeFile(metaPath, JSON.stringify({ type: icon?.type, at: Date.now(), missing: !icon } satisfies Meta));
      return icon;
    });
    pending.set(origin, p);
    void p.finally(() => pending.delete(origin));
  }
  return p;
}
