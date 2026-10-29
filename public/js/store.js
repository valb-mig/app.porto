// Estado compartilhado entre as telas e o registro de ações (cliques delegados por data-action).

export const store = {
  services: null,
  system: null,
  sites: null,
  config: null,
  access: null,
  requests: null,
};

export const ui = {
  tab: 'inicio',
  drawerKey: null,
  drawerTab: 'logs',
};

const listeners = new Set();

export function set(key, value) {
  store[key] = value;
  // Um renderizador com erro não pode impedir os outros de atualizar.
  for (const fn of listeners) {
    try {
      fn(key);
    } catch (err) {
      reportError(err);
    }
  }
}

let lastReported = '';

/** Erro inesperado no front: vai pro console e aparece uma vez como aviso. */
export function reportError(err) {
  console.error(err);
  const text = `Erro na interface: ${err?.message ?? err}`;
  if (text === lastReported) return;
  lastReported = text;
  document.getElementById('toasts')?.append(Object.assign(document.createElement('div'), { className: 'toast error', role: 'alert', textContent: text }));
}

window.addEventListener('error', (e) => reportError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason));

export const subscribe = (fn) => listeners.add(fn);

const actions = new Map();

/** Registra o handler de `data-action="nome"`. Recebe o elemento clicado e o evento. */
export const onAction = (name, fn) => actions.set(name, fn);

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions.get(el.dataset.action);
  if (!fn) return;
  e.preventDefault();
  fn(el, e);
});

export const serviceByKey = (key) => store.services?.services.find((s) => s.key === key);

/** Melhor endereço pra abrir um serviço: local, depois tailnet, depois público. */
export function primaryLink(svc) {
  for (const kind of ['local', 'tailnet', 'lan', 'public']) {
    const l = svc.links.find((x) => x.kind === kind);
    if (l) return l;
  }
  return null;
}
