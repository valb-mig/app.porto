import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessSnapshot, saveAccessHistory, startAccessSampler } from './access.ts';
import { CONFIG_PATH, config, loadConfig, sanitizeGroups, sanitizeOverride, sanitizeSites, updateConfig } from './config.ts';
import { containerAction } from './docker.ts';
import { favicon } from './favicon.ts';
import { streamLogs } from './logs.ts';
import { runCheck, saveMonitor, sitesSnapshot, startMonitor } from './monitor.ts';
import { initProcs, processTable } from './procs.ts';
import { requestsOf } from './requests.ts';
import { handleOf, servicesSnapshot, shareablePort, type Service } from './services.ts';
import { unitAction } from './systemd.ts';
import { startSystemSampler, systemSnapshot, topProcesses } from './system.ts';
import { serveAdd, serveRemove, tailscaleState } from './tailscale.ts';
import { cached, errorText, mapLimit } from './util.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MY_UID = process.getuid?.() ?? -1;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string>; body: () => Promise<Record<string, unknown>> };
type Handler = (ctx: Ctx) => unknown;
const routes: { method: string; parts: string[]; handler: Handler }[] = [];
const route = (method: string, pattern: string, handler: Handler) => routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });

function match(method: string, pathname: string) {
  // Casa no caminho ainda codificado: chaves de serviço podem conter "/" (serve:443/foo).
  const parts = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (r.parts.every((p, i) => (p.startsWith(':') ? ((params[p.slice(1)] = decodeURIComponent(parts[i]!)), true) : p === parts[i]))) return { handler: r.handler, params };
  }
  return null;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) reject(new HttpError(413, 'Corpo da requisição grande demais.'));
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Proteção contra DNS rebinding: só atende pelos nomes locais (ou os liberados na config).
 * Sem isso, qualquer site aberto no navegador poderia conversar com o Porto via um domínio
 * que resolve pra 127.0.0.1.
 */
function hostAllowed(value?: string) {
  if (!value) return false;
  const host = value.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1' || config().allowedHosts.includes(host);
}

/**
 * Ações que mudam estado exigem um header customizado: navegadores não mandam headers
 * customizados cross-origin sem preflight CORS, que o Porto nunca aprova (anti-CSRF).
 */
function mutationAllowed(req: IncomingMessage) {
  if (req.headers['x-porto'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return hostAllowed(new URL(origin).host);
  } catch {
    return false;
  }
}

async function findService(key: string): Promise<Service> {
  const snap = await servicesSnapshot();
  const svc = snap.services.find((s) => s.key === key);
  if (!svc) throw new HttpError(404, 'Serviço não encontrado. Ele pode ter sido encerrado.');
  return svc;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function signalProcess(pid: number, force: boolean) {
  if (pid === process.pid) throw new HttpError(400, 'O Porto não encerra a si mesmo por aqui; use systemctl --user stop porto.');
  const table = await processTable(true);
  const p = table.get(pid);
  if (!p) throw new HttpError(404, 'Esse processo já não existe.');
  if (p.uid !== MY_UID) throw new HttpError(403, 'Processo de outro usuário: encerre pelo terminal com sudo.');
  process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  await sleep(force ? 300 : 1_500);
  return { stillAlive: alive(pid) };
}

// ---------------------------------------------------------------- rotas

route('GET', '/api/services', () => servicesSnapshot());

route('PATCH', '/api/services/:key', async ({ params, body }) => {
  const patch = sanitizeOverride(await body());
  await updateConfig((c) => {
    const merged = { ...c.services[params.key!], ...patch };
    // pinned/hidden falsos são o padrão e podem sumir; accessLog: false desliga a detecção automática e fica.
    for (const k of Object.keys(merged) as (keyof typeof merged)[]) if (merged[k] === undefined || (merged[k] === false && k !== 'accessLog')) delete merged[k];
    if (Object.keys(merged).length) c.services[params.key!] = merged;
    else delete c.services[params.key!];
  });
  return servicesSnapshot(true);
});

route('POST', '/api/services/:key/action', async ({ params, body }) => {
  const svc = await findService(params.key!);
  const { action, force, servePort } = await body();
  const h = handleOf(svc.key);
  let message = 'Feito.';
  let extra: Record<string, unknown> = {};
  if (!svc.actions.includes(action as never)) throw new HttpError(400, `Ação "${String(action)}" não disponível para ${svc.name}.`);
  switch (action) {
    case 'start':
    case 'stop':
    case 'restart': {
      if (h?.container) await containerAction(h.container.id, action);
      else if (h?.unit) await unitAction(h.unit, action);
      else throw new HttpError(400, 'Esse serviço não pode ser controlado por aqui.');
      message = { start: 'Iniciado.', stop: 'Parado.', restart: 'Reiniciado.' }[action];
      break;
    }
    case 'kill': {
      if (!svc.pid) throw new HttpError(400, 'Sem PID para encerrar.');
      const r = await signalProcess(svc.pid, Boolean(force));
      extra = r;
      message = r.stillAlive ? 'O processo ainda está rodando. Force o encerramento se ele não sair sozinho.' : 'Processo encerrado.';
      break;
    }
    case 'share': {
      const port = shareablePort(svc);
      if (!port) throw new HttpError(400, 'Nenhuma porta HTTP local para compartilhar.');
      const url = await serveAdd(port.port, Boolean(port.http?.https));
      extra = { url };
      message = `Disponível na tailnet em ${url}`;
      break;
    }
    case 'unshare': {
      const link = svc.links.find((l) => l.servePort && (servePort === undefined || l.servePort === Number(servePort)));
      const serve = h?.serve ?? (link ? { httpsPort: link.servePort!, path: link.servePath ?? '/' } : undefined);
      if (!serve) throw new HttpError(400, 'Esse serviço não está no Tailscale serve.');
      await serveRemove(serve.httpsPort, serve.path);
      message = 'Removido da tailnet.';
      break;
    }
  }
  return { ok: true, message, ...extra, snapshot: await servicesSnapshot(true) };
});

route('POST', '/api/projects/:name/action', async ({ params, body }) => {
  const { action } = await body();
  if (action !== 'start' && action !== 'stop' && action !== 'restart') throw new HttpError(400, 'Ação inválida.');
  const snap = await servicesSnapshot();
  const targets = snap.services.filter((s) => s.kind === 'docker' && s.project === params.name);
  if (!targets.length) throw new HttpError(404, 'Nenhum container nesse projeto.');
  await mapLimit(targets, 4, async (s) => {
    const c = handleOf(s.key)?.container;
    if (c && !(action === 'start' && s.state === 'running') && !(action === 'stop' && s.state !== 'running')) await containerAction(c.id, action);
  });
  return { ok: true, message: `${targets.length} containers de ${params.name}: ${{ start: 'iniciados', stop: 'parados', restart: 'reiniciados' }[action]}.`, snapshot: await servicesSnapshot(true) };
});

route('GET', '/api/services/:key/requests', async ({ params }) => requestsOf(await findService(params.key!)));

route('GET', '/api/logs', async ({ url, req, res }) => {
  const svc = await findService(url.searchParams.get('key') ?? '');
  const tail = Math.min(5_000, Math.max(0, Number(url.searchParams.get('tail') ?? 300)));
  streamLogs(svc, tail, res, (fn) => req.on('close', fn));
});

const allRequests = cached(10_000, async () => {
  const snap = await servicesSnapshot();
  const list = snap.services.filter((s) => s.accessLog && s.state === 'running');
  return mapLimit(list, 3, async (svc) => ({ key: svc.key, name: svc.name, project: svc.project, data: await requestsOf(svc, 2_000).catch((err) => ({ available: false as const, reason: errorText(err) })) }));
});

route('GET', '/api/access', async () => {
  const ts = await tailscaleState();
  return { ...accessSnapshot(), devices: ts.self ? [ts.self, ...ts.peers] : ts.peers };
});
route('GET', '/api/requests', () => allRequests());

route('GET', '/api/system', async ({ url }) => ({ ...systemSnapshot(), top: url.searchParams.has('top') ? await topProcesses() : undefined }));

route('POST', '/api/processes/:pid/signal', async ({ params, body }) => {
  const { force } = await body();
  const r = await signalProcess(Number(params.pid), Boolean(force));
  return { ok: true, ...r, message: r.stillAlive ? 'O processo ainda está rodando.' : 'Processo encerrado.' };
});

route('GET', '/api/sites', () => sitesSnapshot());
route('POST', '/api/sites/:id/check', async ({ params }) => {
  const site = config().sites.find((s) => s.id === params.id);
  if (!site) throw new HttpError(404, 'Site não encontrado.');
  await runCheck(site);
  return sitesSnapshot();
});

route('GET', '/api/config', () => ({ ...config(), configPath: CONFIG_PATH }));
route('PUT', '/api/config/groups', async ({ body }) => {
  const groups = sanitizeGroups((await body()).groups);
  return updateConfig((c) => void (c.groups = groups));
});
route('PUT', '/api/config/sites', async ({ body }) => {
  const sites = sanitizeSites((await body()).sites);
  return updateConfig((c) => void (c.sites = sites));
});
route('PUT', '/api/config/settings', async ({ body }) => {
  const b = await body();
  return updateConfig((c) => {
    if (typeof b.searchUrl === 'string' && b.searchUrl.includes('%s')) c.settings.searchUrl = b.searchUrl.trim();
    if (typeof b.notifyPinned === 'boolean') c.settings.notifyPinned = b.notifyPinned;
  });
});

route('GET', '/api/favicon', async ({ url, res }) => {
  const icon = await favicon(url.searchParams.get('url') ?? '').catch(() => null);
  if (!icon) {
    res.writeHead(404, { 'Cache-Control': 'max-age=3600' }).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': icon.type, 'Cache-Control': 'max-age=86400', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }).end(icon.body);
});

// ---------------------------------------------------------------- estáticos

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

const CSP = ["default-src 'self'", "img-src 'self' data:", "style-src 'self'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"].join('; ');

async function serveStatic(pathname: string, res: ServerResponse) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    throw new HttpError(400, 'Endereço malformado.');
  }
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(403, 'Fora da pasta pública.');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP }).end(body);
  } catch {
    throw new HttpError(404, 'Arquivo não encontrado.');
  }
}

// ---------------------------------------------------------------- servidor

async function handle(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!hostAllowed(req.headers.host)) throw new HttpError(403, 'Host não permitido. Acesse por http://localhost ou libere o nome em allowedHosts.');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  if (!url.pathname.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
    return serveStatic(url.pathname, res);
  }
  if (method !== 'GET' && !mutationAllowed(req)) throw new HttpError(403, 'Requisição bloqueada (falta o header X-Porto ou a origem não é local).');
  const m = match(method, url.pathname);
  if (!m) throw new HttpError(404, 'Rota não encontrada.');
  const result = await m.handler({ req, res, url, params: m.params, body: () => readBody(req) });
  if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(result ?? { ok: true }));
}

async function main() {
  await initProcs();
  const cfg = await loadConfig();
  startSystemSampler();
  await startAccessSampler();
  await startMonitor();
  // Redescoberta periódica mesmo sem a página aberta: mantém os avisos de serviços fixados.
  setInterval(() => void servicesSnapshot().catch((err) => console.error('[services]', errorText(err))), 15_000).unref();

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('[http]', req.method, req.url, err);
      if (res.headersSent) return res.end();
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: errorText(err) }));
    });
  });
  const host = process.env.PORTO_HOST ?? cfg.host;
  const port = Number(process.env.PORTO_PORT ?? cfg.port);
  server.listen(port, host, () => console.log(`Porto em http://localhost:${port} (escutando em ${host}:${port}, config em ${CONFIG_PATH})`));

  const shutdown = async () => {
    server.close();
    await Promise.allSettled([saveAccessHistory(), saveMonitor()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void main();
