import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type HttpInfo = {
  status: number;
  ms: number;
  https: boolean;
  title?: string;
  server?: string;
  location?: string;
  /** Caminho do favicon declarado no HTML (relativo à raiz do serviço). */
  icon?: string;
};

/**
 * Portas cujo protocolo não é HTTP: nem tenta sondar. Alguns servidores tratam a primeira
 * conexão como o cliente de verdade (o RTSP do Miracast, por exemplo), então um GET / ali
 * derruba a sessão.
 */
export const KNOWN_PROTOCOLS: Record<number, string> = {
  22: 'SSH',
  25: 'SMTP',
  53: 'DNS',
  554: 'RTSP',
  7236: 'Miracast (RTSP)',
  7239: 'Miracast (controle)',
  8554: 'RTSP',
  1433: 'SQL Server',
  3306: 'MySQL',
  5432: 'PostgreSQL',
  5672: 'RabbitMQ',
  6379: 'Redis',
  9000: 'PHP-FPM',
  11211: 'Memcached',
  27017: 'MongoDB',
};

const MAX_BODY = 64 * 1024;

function decodeEntities(s: string) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

function iconFrom(html: string) {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']?[^"'>]*\bicon\b/i.test(tag)) continue;
    const href = /href=["']?([^"' >]+)/i.exec(tag)?.[1];
    if (href) return decodeEntities(href);
  }
  return undefined;
}

function attempt(host: string, port: number, https: boolean, timeoutMs: number): Promise<HttpInfo> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const fn = https ? httpsRequest : httpRequest;
    const req = fn(
      {
        host,
        port,
        path: '/',
        method: 'GET',
        timeout: timeoutMs,
        rejectUnauthorized: false,
        headers: { 'User-Agent': 'Porto/0.1 (sonda local)', Accept: 'text/html,*/*' },
      },
      (res: IncomingMessage) => {
        const ms = Math.round(performance.now() - started);
        const isHtml = /html/i.test(String(res.headers['content-type'] ?? ''));
        let body = '';
        const done = () => {
          const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(body)?.[1];
          resolve({
            status: res.statusCode ?? 0,
            ms,
            https,
            title: title ? decodeEntities(title.trim()).replace(/\s+/g, ' ') : undefined,
            server: [res.headers.server].flat()[0],
            location: res.headers.location,
            icon: isHtml ? iconFrom(body) : undefined,
          });
          req.destroy();
        };
        if (!isHtml) return done();
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
          if (body.length > MAX_BODY || /<\/head>/i.test(body)) done();
        });
        res.on('end', done);
        res.on('error', done);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const cache = new Map<string, { at: number; value: HttpInfo | null }>();
const OK_TTL_MS = 60_000;
const FAIL_TTL_MS = 10_000;

/**
 * Descobre se a porta fala HTTP (ou HTTPS) e lê título e favicon. `identity` entra na
 * chave do cache pra re-sondar quando outro processo assume a mesma porta.
 */
export async function probe(host: string, port: number, identity: string, force = false): Promise<HttpInfo | null> {
  const key = `${host}:${port}:${identity}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < (hit.value ? OK_TTL_MS : FAIL_TTL_MS)) return hit.value;
  let value: HttpInfo | null = null;
  try {
    value = await attempt(host, port, false, 1_500);
    // Servidor HTTPS respondendo a HTTP puro costuma devolver 400 com aviso de TLS.
    if (value.status === 400 && /https|ssl|tls/i.test(value.title ?? '')) value = await attempt(host, port, true, 1_500);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code === 'ECONNRESET' || code.startsWith('HPE_')) value = await attempt(host, port, true, 1_500).catch(() => null);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
