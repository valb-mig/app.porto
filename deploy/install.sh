#!/bin/sh
# Instala o Porto como serviço do usuário (sobe junto com a sessão). Rodar de novo atualiza a unit.
set -eu

dir=$(cd "$(dirname "$0")/.." && pwd)
node=$(command -v node) || { echo "Node não encontrado no PATH." >&2; exit 1; }
"$node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || {
  echo "O Porto precisa do Node 24 ou mais novo (achei o $("$node" --version) em $node)." >&2
  exit 1
}

unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/porto.service"
mkdir -p "$(dirname "$unit")"
# Remove antes de escrever: se for um link antigo para o modelo, o modelo não pode ser sobrescrito.
rm -f "$unit"
sed -e "s|@DIR@|$dir|g" -e "s|@NODE@|$node|g" "$dir/deploy/porto.service" > "$unit"

systemctl --user daemon-reload
systemctl --user enable porto
systemctl --user restart porto
echo "Porto rodando em http://localhost:7777 (logs: journalctl --user -u porto -f)"
