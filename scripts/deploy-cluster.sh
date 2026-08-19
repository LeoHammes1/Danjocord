#!/usr/bin/env bash
# Deploy do Danjocord no cluster k3s — o laço curto de teste.
#
#   ./scripts/deploy-cluster.sh                 # publica o HEAD atual
#   ./scripts/deploy-cluster.sh -m "mensagem"   # commita o que está sujo antes
#   ./scripts/deploy-cluster.sh --status        # só mostra o estado, não mexe
#
# POR QUE PELO CI, E NÃO BUILD LOCAL + SCP (que é a convenção dos outros apps
# do KubeCluster): a imagem tem ~370 MB e o nó fica na Hostinger. Subir isso de
# uma conexão doméstica é MAIS LENTO que o GitHub construir e o nó puxar do
# ghcr pela rede do datacenter. O caminho local só ganharia se o nó fosse local
# — que é o caso do sensor-consumer, não o nosso.
#
# POR QUE A TAG É O SHA, E NÃO `:latest`: com `:latest` não dá para saber se o
# pod subiu com o código novo ou reusou cache, e `rollout restart` fica sendo fé.
# O `release.yml` publica as duas tags (`type=raw,value=latest` e `type=sha`);
# apontar o Deployment para `sha-<commit>` faz o rollout falhar alto quando a
# imagem não é a esperada, e torna o rollback um `kubectl set image` para o SHA
# anterior.
#
# ARMADILHA: `kubectl apply -f deploy/danjocord.yaml` devolve a imagem para
# `:latest`, porque é o que o manifest diz. Isso é o CERTO (o manifest é a
# fonte da verdade do deploy, não o último teste), mas se você aplicar o
# manifest depois de um deploy destes, rode este script de novo — senão o pod
# fica num `:latest` que pode ser mais velho que o seu HEAD.
set -euo pipefail

NS=production
DEPLOY=danjocord
IMAGE=ghcr.io/leohammes1/danjocord
URL=https://danjocord.leohammes.dev
ESPERA_MAX=900 # 15 min: build do mediasoup no CI não é rápido

vermelho=$'\033[0;31m'; verde=$'\033[0;32m'; azul=$'\033[0;34m'; amarelo=$'\033[1;33m'; fim=$'\033[0m'
passo() { printf '\n%s>> %s%s\n' "$azul" "$1" "$fim"; }
ok()    { printf '%s[ok]%s %s\n' "$verde" "$fim" "$1"; }
aviso() { printf '%s[!]%s %s\n' "$amarelo" "$fim" "$1"; }
erro()  { printf '%s[erro]%s %s\n' "$vermelho" "$fim" "$1" >&2; exit 1; }

estado() {
  passo "Estado no cluster"
  kubectl -n "$NS" get deploy,pods,ingress -l app="$DEPLOY" 2>/dev/null || true
  printf '\nimagem em uso: %s\n' "$(kubectl -n "$NS" get deploy "$DEPLOY" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null)"
  printf 'certificado:   %s\n' "$(kubectl -n "$NS" get certificate "$DEPLOY"-tls -o jsonpath='{.status.conditions[0].status}' 2>/dev/null || echo '?')"
}

[[ "${1:-}" == "--status" ]] && { estado; exit 0; }

MENSAGEM=""
[[ "${1:-}" == "-m" ]] && { MENSAGEM="${2:?-m exige uma mensagem}"; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# --- 1. o código -------------------------------------------------------------
if [[ -n "$(git status --porcelain)" ]]; then
  [[ -z "$MENSAGEM" ]] && erro "árvore suja. Commite, ou rode com -m \"mensagem\"."
  passo "Commitando"
  git add -A && git commit -q -m "$MENSAGEM"
  ok "$(git log --oneline -1)"
fi

SHA="$(git rev-parse --short=7 HEAD)"
TAG="sha-$SHA"

passo "Publicando (push na main dispara o release.yml)"
git push origin main
ok "HEAD = $SHA"

# --- 2. esperar o CI ---------------------------------------------------------
# Poll no registry em vez da API do GitHub: não precisa de token, e o que
# importa é a imagem existir de verdade — não o workflow dizer que terminou.
passo "Esperando a imagem $TAG aparecer no ghcr"
inicio=$(date +%s)
until docker manifest inspect "$IMAGE:$TAG" >/dev/null 2>&1; do
  decorrido=$(( $(date +%s) - inicio ))
  (( decorrido > ESPERA_MAX )) && erro "imagem não apareceu em ${ESPERA_MAX}s. Veja as Actions no GitHub — e confirme que o package está PÚBLICO (novo nasce privado, e aí o kubelet leva 401)."
  printf '\r  %ss…' "$decorrido"; sleep 10
done
printf '\n'; ok "imagem publicada em $(( $(date +%s) - inicio ))s"

# --- 3. rolar ----------------------------------------------------------------
passo "Apontando o Deployment para $TAG"
kubectl -n "$NS" set image "deploy/$DEPLOY" "$DEPLOY=$IMAGE:$TAG"
kubectl -n "$NS" rollout status "deploy/$DEPLOY" --timeout=300s || {
  aviso "rollout não completou — últimos eventos:"
  kubectl -n "$NS" describe pod -l app="$DEPLOY" | sed -n '/Events:/,$p' | tail -15
  exit 1
}

# --- 4. provar que subiu -----------------------------------------------------
# healthz sozinho não prova nada útil: o gateway é WebSocket e é ele que carrega
# o app. O 101 é a diferença entre "o pod respondeu" e "dá para usar".
passo "Conferindo"
codigo=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$URL/healthz" || echo 000)
[[ "$codigo" == "200" ]] && ok "healthz 200" || aviso "healthz devolveu $codigo"

upgrade=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: ZGFuam9jb3JkdGVzdGUxMjM0NQ==" "$URL/gateway" || echo 000)
[[ "$upgrade" == "101" ]] && ok "gateway aceitou o upgrade (101)" || aviso "gateway devolveu $upgrade (esperado 101)"

oauth=$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 20 "$URL/auth/discord/start" || true)
case "$oauth" in
  *discord.com*) ok "OAuth redireciona para o Discord" ;;
  *)             aviso "/auth/discord/start não redirecionou (503 = credencial faltando no Secret)" ;;
esac

estado
printf '\n%s%s%s\n' "$verde" "$URL" "$fim"
