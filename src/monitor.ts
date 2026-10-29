import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TLSSocket } from 'node:tls';
import { config, type SiteCheck } from './config.ts';
import { STATE_DIR, errorText, notify, writeJson } from './util.ts';

export type Level = 'up' | 'warn' | 'down';
export type CheckResult = { t: number; level: Level; status?: number; ms?: number; error?: string };
type SiteState = { history: CheckResult[]; since?: number; cert?: { days: number; validTo: string; issuer?: string } };

const KEEP = 720;
const DNS_TIMEOUT = 25_000;
const HTTP_TIMEOUT = 10_000;
const RETRIES = 2;
const RETRY_DELAY = 5_000;
const STATE_PATH = join(STATE_DIR, 'sites.json');
const state = new Map<string, SiteState>();
const inflight = new Set<string>();
let saveTimer: NodeJS.Timeout | null = null;

const levelOf = (status: number): Level => (status < 400 ? 'up' : status < 500 ? 'warn' : 'down');

function friendlyError(err: unknown) {
  const code = (err as NodeJS.ErrnoException).code;
  const map: Record<string, string> = {
    ENOTFOUND: 'domínio não encontrado (DNS)',
    EAI_AGAIN: 'falha temporária de DNS',
    ECONNREFUSED: 'conexão recusada',
    ECONNRESET: 'conexão encerrada pelo servidor',
    ETIMEDOUT: 'tempo esgotado',
    EDNSTIMEOUT: 'o DNS desta máquina não respondeu',
    CERT_HAS_EXPIRED: 'certificado TLS expirado',
    ERR_TLS_CERT_ALTNAME_INVALID: 'certificado TLS não cobre esse domínio',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificado TLS não verificável',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'certificado TLS autoassinado',
  };
  return (code && map[code]) ?? errorText(err);
}

/**
 * Resolve o nome antes da requisição, com prazo próprio: o DNS local (MagicDNS do Tailscale)
 * às vezes leva 5 a 15 s pra responder, e isso não pode estourar o timeout nem contar como lentidão do site.
 */
async function resolveHost(host: string) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout de DNS'), { code: 'EDNSTIMEOUT' })), DNS_TIMEOUT);
  });
  try {
    return await Promise.race([lookup(host, { all: true }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Mede o tempo até os cabeçalhos (sem baixar a página nem contar o DNS) e lê o certificado TLS. */
async function check(url: string): Promise<CheckResult & { cert?: SiteState['cert'] }> {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs: LookupAddress[] | undefined;
  if (!isIP(host)) {
    try {
      addrs = await resolveHost(host);
    } catch (err) {
      return { t: Date.now(), level: 'down', error: friendlyError(err) };
    }
  }
  const resolved: LookupFunction | undefined = addrs && ((_host, opts, cb) => (opts.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family)));
  return new Promise((resolve) => {
    const started = performance.now();
    const fn = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = fn(u, { method: 'GET', timeout: HTTP_TIMEOUT, agent: false, lookup: resolved, headers: { 'User-Agent': 'Porto/0.1 (monitor de uptime)' } }, (res: IncomingMessage) => {
      const ms = Math.round(performance.now() - started);
      let cert: SiteState['cert'];
      const peer = (res.socket as TLSSocket).getPeerCertificate?.();
      if (peer?.valid_to) {
        const validTo = new Date(peer.valid_to);
        cert = { days: Math.floor((validTo.getTime() - Date.now()) / 86_400_000), validTo: validTo.toISOString(), issuer: [peer.issuer?.O ?? peer.issuer?.CN].flat()[0] };
      }
      const status = res.statusCode ?? 0;
      res.destroy();
      resolve({ t: Date.now(), level: levelOf(status), status, ms, cert });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => resolve({ t: Date.now(), level: 'down', error: friendlyError(err) }));
    req.end();
  });
}

export async function runCheck(site: SiteCheck) {
  if (inflight.has(site.id)) return;
  inflight.add(site.id);
  try {
    const st = state.get(site.id) ?? { history: [] };
    let result = await check(site.url);
    // Uma falha isolada (DNS ou rede local oscilando) não basta pra dizer que o site caiu: confirma antes.
    for (let i = 0; i < RETRIES && result.level === 'down'; i++) {
      await sleep(RETRY_DELAY);
      result = await check(site.url);
    }
    const prev = st.history.at(-1);
    if (result.cert) st.cert = result.cert;
    const { cert: _, ...entry } = result;
    st.history.push(entry);
    if (st.history.length > KEEP) st.history.splice(0, st.history.length - KEEP);
    if (!prev || prev.level !== entry.level) st.since = entry.t;
    state.set(site.id, st);
    if (site.notify && prev && prev.level !== entry.level) {
      if (entry.level === 'down') notify(`${site.title} fora do ar`, entry.error ?? `HTTP ${entry.status}`, 'critical');
      else if (prev.level === 'down') notify(`${site.title} voltou`, `HTTP ${entry.status} em ${entry.ms} ms`, 'low');
    }
    saveTimer ??= setTimeout(save, 5_000);
  } finally {
    inflight.delete(site.id);
  }
}

async function save() {
  saveTimer = null;
  await writeJson(STATE_PATH, Object.fromEntries(state)).catch((err) => console.error('[monitor] não salvou:', errorText(err)));
}

export async function startMonitor() {
  try {
    const saved = JSON.parse(await readFile(STATE_PATH, 'utf8')) as Record<string, SiteState>;
    for (const [id, st] of Object.entries(saved)) state.set(id, st);
  } catch {
    // Sem histórico salvo ainda.
  }
  const tick = () => {
    const now = Date.now();
    for (const site of config().sites) {
      const last = state.get(site.id)?.history.at(-1);
      if (!last || now - last.t >= site.intervalSec * 1000) void runCheck(site);
    }
  };
  tick();
  setInterval(tick, 5_000).unref();
}

export const saveMonitor = save;

export function sitesSnapshot() {
  const dayAgo = Date.now() - 86_400_000;
  return config().sites.map((site) => {
    const st = state.get(site.id);
    const recent = st?.history.filter((h) => h.t >= dayAgo) ?? [];
    return {
      ...site,
      level: st?.history.at(-1)?.level ?? 'pending',
      last: st?.history.at(-1),
      since: st?.since,
      cert: st?.cert,
      uptime24: recent.length ? recent.filter((h) => h.level !== 'down').length / recent.length : null,
      history: st?.history.slice(-60) ?? [],
    };
  });
}
