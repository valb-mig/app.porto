# Porto

Página inicial da máquina: atalhos, tudo o que está rodando (localhost, Docker, systemd, Tailscale) e quem está acessando, num só lugar. Roda em **http://localhost:7777**.

Nada precisa ser cadastrado: o Porto descobre sozinho o que escuta em cada porta e de onde aquilo veio.

## O que tem

**Início**
- Relógio e uma busca que entende o que você digita: `3100` abre `localhost:3100`, `meusite.com` abre o site, um nome filtra seus atalhos e serviços, o resto vai pro buscador (DuckDuckGo, configurável).
- Atalhos em grupos, editáveis na própria página (arrastar entre grupos inclusive). Os favicons são buscados e guardados em cache localmente.
- **Rodando agora**: cada servidor web identificado pelo número da porta, com selo quando está na tailnet ou na internet.
- **Sites**: monitor de uptime dos seus sites publicados (status, tempo de resposta, % no ar em 24 h, validade do certificado TLS) com aviso no desktop quando um cai ou volta.

**Serviços**: lista agrupada por projeto de tudo o que está rodando ou parado:
- containers Docker (inclusive parados), com ações por projeto do compose;
- units systemd do usuário (`~/.config/systemd/user`);
- processos soltos (um `pnpm dev` aberto num terminal, por exemplo), com projeto detectado pelo diretório;
- mapeamentos do `tailscale serve`/Funnel e quick tunnels do Cloudflare, ligados ao serviço de destino;
- apps do desktop e serviços do sistema (Discord, containerd…), recolhidos por padrão.

Em cada serviço: abrir, reiniciar, parar/iniciar, encerrar processo (com opção de forçar), **compartilhar na tailnet** com um clique (`tailscale serve`) e remover, fixar no início (fixados avisam no desktop se pararem), ocultar e renomear. O painel lateral mostra **logs ao vivo** (Docker, journal ou arquivo), com filtro, "só erros", pausa e download.

**Acessos**
- Quem está conectado agora em cada serviço: processos desta máquina (Zen, Chrome, node de outro projeto…), dispositivos da tailnet pelo nome, containers, rede local ou internet.
- Histórico de 7 dias (primeira e última vez, tempo conectado, pico de conexões simultâneas).
- **Visitas aos sites**, lidas dos access logs de nginx/Apache/Caddy: visitantes, páginas mais vistas, dispositivos, de onde vêm e páginas por hora.

**Sistema**: CPU, memória, rede, temperaturas, bateria, discos, interfaces e os processos que mais consomem (os seus podem ser encerrados por ali).

## Rodando

Precisa de **Linux com systemd** (lê `/proc`, `/sys/fs/cgroup` e usa `ss`, `systemctl` e `journalctl`) e de **Node 24** ou mais novo (roda TypeScript direto, sem build). Nenhuma dependência em produção.

O resto é opcional, e a parte correspondente só não aparece se faltar:

- **Docker**: containers e logs (seu usuário precisa estar no grupo `docker`);
- **Tailscale**: nomes dos dispositivos, `tailscale serve` e compartilhamento na tailnet;
- **`notify-send`**: avisos no desktop (dunst, mako, GNOME, KDE…).

```bash
git clone https://github.com/valb-mig/app.porto.git && cd app.porto
pnpm start          # http://localhost:7777
pnpm dev            # reinicia ao salvar arquivos do servidor
pnpm install && pnpm check   # checagem de tipos (opcional)
```

### Como serviço (sobe junto com a sessão)

```bash
./deploy/install.sh
```

O script gera `~/.config/systemd/user/porto.service` apontando para a pasta onde o repositório está e para o seu `node`; rode de novo se mover a pasta ou trocar de versão do Node. Logs do próprio Porto: `journalctl --user -u porto -f`. Para tirar: `systemctl --user disable --now porto` e apague o arquivo da unit.

### Como página inicial do navegador

No Zen/Firefox: Configurações → Início → "Página inicial e novas janelas" → URLs personalizadas → `http://localhost:7777`. Para a página de nova aba, use uma extensão como New Tab Override apontando para o mesmo endereço.

Atalhos de teclado: `/` foca a busca (ou o filtro, em Serviços), `1` a `4` trocam de aba, `Esc` fecha o painel. Na tela inicial é só começar a digitar.

## Configuração

Tudo o que você edita na página vai para `~/.config/porto/config.json` (atalhos, sites monitorados, ajustes por serviço). Dá pra editar à mão também; reinicie o serviço depois.

| Campo | Para quê |
| --- | --- |
| `host`, `port` | Onde o servidor escuta (padrão `127.0.0.1:7777`). `PORTO_HOST`/`PORTO_PORT` sobrescrevem. |
| `allowedHosts` | Nomes extras aceitos no header Host, para expor pela tailnet (veja abaixo). |
| `noProbePorts` | Portas que nunca recebem a sonda HTTP (`GET /`). SSH, bancos, RTSP e o Miracast (7236/7239) já ficam de fora sozinhos. |
| `settings.searchUrl` | Buscador; `%s` vira o texto buscado. |
| `settings.notifyPinned` | Avisar no desktop quando um serviço fixado parar ou voltar. |

Estado e cache ficam em `~/.local/state/porto/` (histórico de acessos e de uptime) e `~/.cache/porto/` (favicons).

## Segurança

O Porto consegue parar containers e encerrar processos, então ele é fechado por padrão:

- escuta só em `127.0.0.1`;
- recusa requisições cujo header `Host` não seja `localhost`/`127.0.0.1` (proteção contra DNS rebinding);
- ações exigem o header `X-Porto: 1` e origem local, coisa que outro site aberto no navegador não consegue mandar (proteção contra CSRF);
- CSP restrita e nenhum `innerHTML` com dados de logs, containers ou sites;
- só encerra processos do seu usuário; units do sistema e processos de root ficam só para leitura.

### Abrir pelo celular (tailnet)

Se quiser acessar de outro dispositivo da tailnet, exponha pelo próprio Tailscale e libere o nome:

```bash
tailscale serve --bg --https=7443 http://127.0.0.1:7777
```

e em `config.json`: `"allowedHosts": ["minha-maquina.tailXXXX.ts.net"]` (o nome que o `tailscale serve` mostrar). Quem estiver na sua tailnet passa a poder controlar os serviços, então só faça isso se a tailnet for só sua.

## Como funciona

| Fonte | O que vem dela |
| --- | --- |
| `ss -tanpe` | Portas escutando, conexões e o cgroup de cada socket (é assim que se sabe que uma porta é do docker-proxy, de uma unit ou do tailscaled, mesmo sem root). |
| API do Docker (`/var/run/docker.sock`) | Containers, portas publicadas, logs e start/stop. |
| `systemctl --user show` / `journalctl` | Units, estado e logs. |
| `/proc` e `/sys/fs/cgroup` | Diretório, comando, CPU e memória de cada processo ou unit; sensores e bateria. |
| `tailscale status`/`serve status` | Nomes dos dispositivos da tailnet e endereços HTTPS de cada serviço. |
| Sonda HTTP local | Se a porta fala HTTP, título da página e favicon. Cada porta nova recebe um `GET /` (repetido no máximo a cada minuto); portas de protocolos conhecidos e as de `noProbePorts` nunca são tocadas. |

Código: `src/` (servidor, Node + TypeScript nativo, zero dependências) e `public/` (HTML, CSS e JS sem build).

## Licença

[MIT](LICENSE)
