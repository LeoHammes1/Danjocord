# CLAUDE.md

Guia para o Claude Code neste repositório.

## O que é

Danjocord: clone didático e minimalista de Discord — **uma guild, até 10
usuários (amigos), self-hosted**. O objetivo do projeto é **aprender a
arquitetura de streaming de voz/vídeo** (WebRTC/SFU); didática vence
conveniência quando as duas conflitam.

O documento de arquitetura (decisões, diagramas, roadmap M0–M7, repositórios
de referência) está publicado como artifact:
https://claude.ai/code/artifact/849196ea-4925-4066-9ec7-615454afb8d8

## Decisões já tomadas (não reabrir sem o Leonardo pedir)

- **Cliente**: Electron (executável tipo Discord; M6). Capacitor/mobile está
  fora do escopo. Durante o dev, `apps/client` roda no navegador.
- **Mídia**: mediasoup embutido no processo do servidor (M3+). LiveKit é o
  plano B documentado, não o caminho.
- **Banco**: SQLite WAL via better-sqlite3. O Postgres do cluster fica nos EUA
  (~150 ms) — não usar.
- **Protocolo**: gateway WebSocket estilo Discord — envelope `{op, d, s, t}`
  em **snake_case no fio**, opcodes espelhando o Discord, heartbeat, Resume
  com replay via ring buffer. Mutações (mensagens) entram por REST; o gateway
  só faz fan-out.
- **Push-to-talk global** (M6): via `uiohook-napi` — o `globalShortcut` do
  Electron NÃO serve (não separa keydown/keyup, consome a tecla).
- **Deploy**: cluster k3s do repo E:\Work\KubeCluster, pod pinado no nó
  `hostinger` (Brasil, IP 72.61.44.156), mídia via hostPort 40000/UDP,
  Ingress `danjocord.leohammes.dev`. Manifest: `deploy/danjocord.yaml`.
- **Ids**: snowflakes de 64 bits (época 2026-01-01). No SQLite são INTEGER
  (o driver devolve BigInt — `defaultSafeIntegers(true)`); **no fio são
  string**. Nunca deixar um id virar `number` em JS.

## Comandos

```bash
docker compose watch         # caminho padrão de dev: tudo em container, sync ao salvar
docker build --target runtime -t danjocord .   # a imagem de produção (ghcr/cluster)

# alternativa local sem Docker:
pnpm install && pnpm build   # build do protocol é pré-requisito dos apps
pnpm dev                     # protocol -w + server :8080 + client :5173
pnpm typecheck
pnpm smoke                   # e2e do gateway (precisa do server rodando)
pnpm --filter @danjocord/server test   # testes unitários (node --test)

# app desktop (M6) — precisa do `pnpm dev` (server + vite) em outro terminal:
pnpm --filter @danjocord/desktop dev   # DANJOCORD_DEV=1 → Electron carrega o vite (:5173)
pnpm --filter @danjocord/desktop dist  # instalador NSIS local (bundla o cliente com a API de produção)

# allowlist (doc §5) — rodar de apps/server; usa o build (dist) e o mesmo
# DB_PATH do servidor (em produção: kubectl exec no pod):
node scripts/allowlist.ts <add|remove|list> [discord_id] [--by <discord_id>]
```

A imagem do ghcr é publicada pelo `.github/workflows/release.yml` a cada push
na main (amd64 — o pod pina no nó x86).

**O laço de deploy é `./scripts/deploy-cluster.sh`** (`-m "msg"` commita antes,
`--status` só olha): push → espera a imagem aparecer no ghcr → `set image` →
`rollout status` → confere healthz, upgrade do gateway (101) e o redirect do
OAuth. Duas decisões dentro dele que valem saber:

- **É pelo CI, e não build local + SCP como os outros apps do KubeCluster.** A
  imagem tem ~370 MB e o nó fica na Hostinger: subir isso de uma conexão
  doméstica é mais lento que o GitHub construir e o nó puxar pela rede do
  datacenter. O caminho local só ganha quando o nó é local (caso do
  `sensor-consumer`, não o nosso).
- **A tag é o SHA do commit, não `:latest`.** Com `:latest` não dá para saber se
  o pod subiu com o código novo ou reusou cache, e `rollout restart` vira fé; com
  `sha-<commit>` o rollout falha alto quando a imagem não é a esperada, e o
  rollback é um `set image` para o SHA anterior.

**Pré-requisito de uma vez só**: o repo é privado, então o package do ghcr nasce
**privado** e o kubelet leva `401 Unauthorized` (ImagePullBackOff) sem dizer por
quê. Deixar o package público em
`github.com/users/LeoHammes1/packages/container/danjocord/settings`. A imagem não
carrega segredo — eles entram por env do Secret, e o `.dockerignore` barra o
`.env`.

## App desktop (M6)

`apps/desktop` é casca fina (doc §7/§8): TODA a UI/mídia vem do bundle de
`apps/client` (dev: vite; produção: scheme `app://` servindo `renderer-dist`,
gerado por `scripts/bundle-renderer.mjs`). O main só dá superpoderes de SO,
expostos ao renderer pela ponte `window.danjocord` (preload + contextBridge;
tipo em `apps/client/src/desktop.d.ts`):

- **Tray**: fechar esconde a janela (voz continua); sair só pelo menu.
- **PTT global**: `uiohook-napi` no main (decisão acima); o cliente mostra a
  seção de PTT no rodapé de voz apenas quando `window.danjocord` existe.
- **Picker de Go Live**: `setDisplayMediaRequestHandler` + janelinha própria
  com `desktopCapturer`; áudio de sistema (`loopback`) no Windows. O
  `voice.ts` do cliente não muda — é o mesmo `getDisplayMedia`.
- **OAuth loopback**: `oauthLogin()` sobe um `http.Server` em 127.0.0.1:porta
  aleatória e abre o navegador em `/auth/discord/start?redirect_port=<porta>`;
  o callback do servidor redireciona para
  `http://127.0.0.1:<porta>/danjocord-callback` com **query** (`?otc=`/
  `?auth_error=`) — query e não fragment porque o listener local precisa ler o
  valor; o fluxo web continua com fragment (`#otc=`) e nada mudou nele
  (`apps/server/src/oauth.ts`; testes em
  `apps/server/test/oauth-loopback.test.ts`).
- **Segredos**: tokens via `safeStorage` num JSON em userData (o cliente troca
  localStorage pela ponte quando é desktop; web segue localStorage).
- **CSP**: o header do Fastify **não alcança este renderer** — quem serve é o
  scheme `app://`, dentro do Electron. Até o M12 o desktop rodava a mesma UI do
  navegador **sem CSP nenhuma**. Ela agora sai de `src/csp.ts` (função pura,
  testada) e é posta no `protocol.handle`, só nas respostas `.html`. A diferença
  para a do servidor é o `connect-src`: no web a API é a MESMA origem e `'self'`
  basta; aqui a origem é `app://bundle` e a API precisa ser nomeada, junto do
  `wss://` do gateway — que o `connect-src` também governa (WebRTC não).
  Armadilha do formato: origem com barra no fim é inválida e o navegador
  descarta a **diretiva inteira em silêncio**; o teste cobre isso.

Release do desktop: tag `v*` → `.github/workflows/desktop-release.yml`
(windows-latest) gera o NSIS e publica no GitHub Release da tag (draft —
publicar manualmente); os apps instalados se atualizam via `electron-updater`
(`checkForUpdatesAndNotify` no ready, só empacotado).

## UI do cliente (M7)

`apps/client` é **TypeScript puro, sem framework** — DOM imperativo. A decisão
é deliberada (o projeto é para aprender WebRTC, não front) e não se reabre sem
o Leonardo pedir. A partir do M7 a organização é:

- `src/styles/` — CSS por área, agregado por `index.css` (que define a **ordem**
  do cascade). `tokens.css` é o único lugar com cor literal; todo o resto usa
  `var(--…)`. Paleta e escalas espelham o Discord.
  **Armadilha já paga uma vez**: `@media` não soma especificidade — regra
  responsiva em `layout.css` perde para regra solta de um arquivo importado
  depois. Os seletores responsivos são escopados em `#app` por isso.
- `src/ui/` — um módulo por área (`sidebar`, `members`, `messages`, `chrome`,
  `composer`, `avatar`, `icons`). Nenhum deles conhece o `state` global nem o
  `VoiceClient`: tudo entra pelo `UiContext` de `ui/context.ts`, cujos campos
  são **getters vivos** montados no `main.ts` (um snapshot congelaria o boot).
- `main.ts` é cola: estado, gateway, paginação e os call sites. Render não
  mora mais lá.
- Ícone é SVG inline de `ui/icons.ts` (`fill="currentColor"`), nunca emoji, e
  nunca via `innerHTML` — o cliente não usa `innerHTML` em lugar nenhum.
- Botão que reflete estado: o `aria-label` é **invariante** (o objeto:
  "Microfone") e o estado vai no `aria-pressed`; o verbo fica no `title`.

O agrupamento de mensagens convive com a janela de DOM da paginação: como o
trim corta nas **duas pontas**, toda inserção e todo trim precisa chamar
`regroupAt`/`regroupAll` — e, onde há compensação de scroll, **antes** de medir
a altura. Os comentários nos call sites do `main.ts` dizem em quais.

## Som (M8; catálogo trocado no M12)

14 clipes em `apps/client/assets/sounds/` — decisões em
[docs/som.md](docs/som.md), procedência em [ATTRIBUTIONS.md](ATTRIBUTIONS.md).

> ⚠️ **12 deles são assets proprietários do Discord** (`.mp3`, byte a byte como o
> CDN serve), por decisão explícita do Leonardo para esta instância **privada**.
> Enquanto estiverem aqui: repo privado, sem instalador para fora, instância
> fechada. O `desktop-release.yml` tem uma trava que reprova o build de release
> enquanto houver `.mp3` no catálogo. O desfazer é
> `pnpm --filter @danjocord/client sounds --all` (repõe os 14 sintetizados) +
> trocar as extensões no `catalog.ts`/`assets.ts` + re-medir. Ler a advertência
> no topo do ATTRIBUTIONS.md antes de qualquer coisa que seja distribuição.

Os outros 2 (`stream-start`, `error`) são `.wav` sintetizados por
`scripts/gen-sounds.mjs`, porque a fonte não tem equivalente para Go Live nem
para erro. O gerador guarda receita para os **14** de propósito: é o caminho de
volta, e um teste reprova se alguma sumir.

- **Nada é reencodado.** A normalização é um **ganho por som** no `catalog.ts`,
  aplicado no playback pelo GainNode (alvo ~−20 dBFS de RMS, teto de pico 0.89).
  Arquivo intacto, nivelamento como dado versionado. Os fades de 5 ms também são
  no envelope, não no arquivo. O RMS é medido na **região ativa** (acima de −60
  dBFS), não no arquivo inteiro — senão silêncio nas pontas vira ganho a mais.
- **O medidor roda dentro do Chromium do Electron**
  (`scripts/measure-sounds.mjs` → `assets/sounds/measured.json`): o Node não
  decodifica `.mp3`, não há ffmpeg e o projeto não instala dependência. Quem
  mede é o mesmo decodificador que vai tocar.
- **Trocar um som é trocar o arquivo E recalcular o ganho** — e isso deixou de
  ser instrução: o `test/sound-assets.test.ts` amarra medição e arquivo pelo
  **sha256** e reprova se o `catalog.ts` discordar.
- `src/sound/` separa por um motivo: `catalog.ts` é **dado puro** e `assets.ts` é
  o único que importa asset — sem isso o teste do Node não conseguiria importar
  a política (o Node não resolve import de asset do Vite).
- `policy.ts` é **pura e testada**: quem decide se um som toca é ela, nunca o
  call site. Regra nova de contexto entra lá, não num `if` espalhado.
- **`vite.config.ts` existe por causa da CSP**: asset < 4 KB viraria `data:` URI,
  que `media-src` bloqueia nas duas CSPs. Deixou de ser hipótese no M12 —
  `ptt-on.mp3` tem ~1,6 KB, e o teste confere que a regra cobre a extensão de
  todo clipe pequeno.
- Deafen silencia `voice` e `notify`; `self` e `system` continuam — senão o
  próprio som de "voltar a ouvir" não tocaria.
- O evento próprio de join/leave sai do `voice.onChange` (local, imediato, e o
  único que funciona na saída, quando `channelId` já zerou). O eco do
  `VOICE_STATE_UPDATE` **não** pode emitir para o próprio usuário — senão toca
  duas vezes; a política não separa as duas origens de propósito.

## Soundboard e controles de voz (M9)

**Upload compartilhado, como no Discord** (decisão do Leonardo): qualquer membro
sobe um som e ele vale para o servidor inteiro. Os 9 clipes CC0 da Kenney em
`apps/server/assets/soundboard/` são **seed**, não catálogo — semeados na tabela
no primeiro boot para existir UMA fonte da verdade (o banco) e o cliente ter um
caminho só. Apagar um embutido é definitivo; o seed só roda com a tabela vazia.

- **Reprodução é LOCAL.** O áudio nunca passa pelo SFU: o gateway só faz fan-out
  do `sound_id` (`VOICE_SOUNDBOARD`) e cada cliente do canal toca o arquivo que
  já baixou. É imediato, não entra no AEC de ninguém e não gasta banda.
  Todo mundo — inclusive quem apertou — toca pelo MESMO caminho: o cliente faz o
  POST e **espera o dispatch voltar**, então não há regra separada para o eco.
- **Bytes em BLOB no SQLite.** O pod tem um PVC só e o banco já mora nele: com
  BLOB, backup e restore continuam sendo um arquivo. Teto de 100 sons × 512 KB.
- **Upload por corpo binário cru**, não multipart — o Fastify 5 não lê multipart
  sem plugin e o projeto não instala dependência. Metadados vão na query.
- **Duração é medida pelo servidor abrindo o container** (`sounds/probe.ts`), sem
  ffmpeg: *granule position* da última página Ogg, `data`/byte-rate do WAV, soma
  de frames no MP3 (com o atalho do `Xing` em VBR). O tipo sai dos **magic
  bytes**, nunca da extensão ou do `Content-Type`. Nunca confie na duração que o
  cliente declara.
- **O `gain` é sugestão, não ordem**: o cliente mede o RMS no preview (alvo
  ~−20 dBFS, mesmo critério do M8) e o servidor **clampa** em 0,05..2,0.
- Rate limit: a **tentativa** conta, não só o sucesso — mandar lixo repetidamente
  custa ler e abrir o container.

`server_mute` é o **primeiro flag de voz que NÃO é declarativo**. Os do M3
(`self_mute`, `self_deaf`) são declarações que o cliente pode mentir; este é
imposto com `producer.pause()` no mediasoup. O conjunto de silenciados é indexado
por **usuário** (não por sessão) e o `produce` de `mic` re-sincroniza — senão
bastava sair e voltar para burlar. É estado em memória: restart perde.

O cache de sons do pad tem **teto em bytes decodificados** (`sound/lru.ts`,
24 MB, descarte do menos usado): um clipe de 5 s a 48 kHz estéreo é ~1,9 MB
DESCOMPRIMIDO, e sem teto quem tocasse os 100 sons de uma sessão acumularia
~190 MB numa aba que fica semanas aberta na bandeja. O orçamento de pré-carga é
outra coisa — ele conta bytes **comprimidos** e só governa o download.

Deafen agora é **real**: pausa os consumers (`pause_consumer`) em vez de só mutar
o `<audio>`. Cada consumer de áudio passa por `MediaStreamSource → GainNode(por
usuário) → GainNode(mestre)`, o que dá mute local e volume 0..200% por pessoa.
O `<audio>` continua no DOM, vivo e mudo, porque no Chromium um MediaStream de
WebRTC só "anda" ligado a um sink — está comentado no `voice.ts`; não remova.

## Convites e moderação (M10)

Até o M9 a única porta era o dono rodar um CLI. Com convite por link a porta
abre sozinha, e aí "quem manda", "quem não entra nunca mais" e "quem fez o quê"
deixam de ser opcionais.

- **Cargo no lugar do booleano**: `users.role` (owner/admin/member); a coluna
  `is_admin` **foi removida** na migration 004 — duas fontes da verdade para a
  mesma pergunta é como nasce o bug em que a UI mostra uma coisa e o servidor
  decide outra. `roleRank()`, `isStaff()` e `displayName()` moram no
  **protocolo**: cliente e servidor decidem pela mesma regra.
- **A regra de quem-mexe-em-quem é UMA função** (`moderationProblem`): ninguém
  age sobre si mesmo, o owner é intocável (é isso que garante "nunca sem
  owner"), e `roleRank(ator) <= roleRank(vítima)` é 403.
- **Kick ≠ ban.** Kick sai da allowlist (volta com convite); ban entra em
  `bans` (nenhum convite serve). Ban é checado **antes** da allowlist em
  `store.isMember` — readicionar pelo CLI não desfaz um ban.
- **O furo do kickado (roadmap 114) fecha pelos dois lados**: kick/ban derrubam
  refresh + WebSocket + voz na hora; e o heartbeat revalida PERTENCIMENTO (não
  o JWT — ele expira em 15 min e a chamada dura horas), que é o único jeito de
  alcançar uma mudança feita por outro processo, como o `scripts/allowlist.ts`.
- **O código do convite viaja no `state` do OAuth**, nunca em cookie nem na
  query do callback — senão dá para trocá-lo no meio do fluxo. O resgate e o
  incremento de `uses` são a MESMA transação: dois logins simultâneos no último
  uso furariam o `max_uses`.
- `GET /api/invites/:code` é a **única rota sem auth** do projeto: devolve só
  `{valid, guild_name, inviter_name}`, e tem rate limit por IP em que a
  tentativa conta (adivinhar código não pode ser barato).
- **Timeout de chat vai ao BANCO** (`users.muted_until`), ao contrário dos flags
  de voz: um prazo de 24 h que evapora no deploy não é prazo. O composer se
  fecha sozinho e reabre no vencimento por timer local — o vencimento não gera
  evento no servidor.
- **Bootstrap** (roadmap 116): `DANJOCORD_OWNER_DISCORD_ID`. Deploy limpo tem
  allowlist vazia e ninguém entra; "primeiro login vira dono" seria sequestro
  de servidor com o Ingress público.
- Bloquear (item 54) é 100% local e refaz a janela de mensagens pelo
  `loadLatest` — arrancar nós à mão quebraria o agrupamento do M7.

## Chat completo (M11a e M11b)

- **Estado de leitura** (`read_state`) é a base de badge, divisor e notificação.
  O ack só sai com a **janela em foco** — marcar lido em segundo plano é o erro
  que faz perder mensagem. `MESSAGE_ACK` é o primeiro evento do projeto que não
  é da guild inteira (`dispatchToUser`): duas abas não podem discordar.
  Quem **entra** na guild nasce com os canais lidos — entrar não é ter perdido
  as conversas de antes.
- **Menções** ficam em `message_mentions` (tabela, não JSON): "quantas não lidas
  me mencionam" é uma query. O parser mora no **protocolo** e roda nos dois
  lados — o servidor resolve no POST para contar, o cliente pinta com a MESMA
  função. `contato@leo.com` não menciona; `@leo` não casa dentro de `@leonardo`.
- **Markdown produz nós do DOM, nunca string.** É isso que torna a sanitização
  estrutural: o cliente não usa `innerHTML` em lugar nenhum, e montar HTML como
  texto seria a primeira exceção. `javascript:`/`data:`/`vbscript:` não viram
  link; `<script>` colado sai como texto.
- **Preview de link é a superfície mais perigosa do projeto** (`links/guard.ts`):
  o servidor busca URL que usuário cola. Só http/https, só portas 80/443, DNS
  resolvido por nós e conexão feita ao **IP já aprovado** (Host e SNI pelo nome
  — fecha rebinding), faixas internas bloqueadas **antes de conectar** e
  revalidadas **a cada redirect**, 3 saltos, 5 s, 512 KB, zero header de
  identidade. Sem campo de imagem de propósito: um `image_url` remoto faria o
  navegador de cada amigo buscar no site — o IP que o unfurl existe para não
  vazar. Os testes de SSRF são de primeira classe; o principal prova que o
  servidor local recebe **zero** requisições.
- **Anexos**: só imagem, magic bytes, 8 MB, BLOB (um PVC, um arquivo de
  backup), e as **dimensões lidas do cabeçalho** em TS puro — irmão do
  `sounds/probe.ts`. Servem para reservar o espaço antes de a imagem carregar,
  senão a timeline pula. Órfão sem mensagem é limpo em 15 min.
- **Busca**: FTS5 com `content='messages'` (externo, não contentless — sem isso
  o `snippet()` não funciona). O trecho vem com marcadores ``/``, não
  com `<b>`, porque o cliente monta nós.
- **CORS não é só de dev** (corrigido no M12, rodando o Electron contra o
  cluster): o renderer do desktop é servido pelo scheme `app://`, que é **origem
  própria** — toda chamada dele à API é cross-origin, inclusive em produção. Só
  o cliente web é same-origin. Enquanto o `cors` ficou dentro de
  `if (config.devAuth)`, o app desktop **nunca conseguiu falar com produção**, e
  o sintoma enganava: o OAuth terminava, o navegador dizia "Login concluído" e o
  app dizia "Falha no login" — quem apanhava era o `POST /auth/session`, depois
  de o OTC já ter voltado. Hoje o `origin: true` é só de dev (para o vite) e
  produção tem lista fechada com `app://bundle`.
  A lista de **métodos** já mordeu duas vezes (M2 faltavam PATCH/DELETE, M11b
  faltava PUT); o sintoma é `Failed to fetch` sem status, porque o navegador
  barra no preflight. Método novo entra lá junto — e agora isso vale para o
  desktop em produção, não só para o dev.

## Limites, e por que a chave nunca é o IP (M12)

O gateway ganhou freios primeiro (op 20 a 60/s, op 3 a 10/s, tetos de sessão e
de ring buffer). O REST em geral não tinha nenhum: mandar mensagem, editar,
apagar, ler histórico, buscar, baixar anexo e o "está digitando" eram
ilimitados — e quase todos terminam em `gateway.broadcast`, que faz
`JSON.stringify` **por sessão**. `src/rate-limit.ts` fecha isso.

- **A chave é o USUÁRIO, nunca o IP, e isso é medição.** Três requisições ao pod
  (uma sem `x-forwarded-for`, uma com `1.1.1.1`, uma com três saltos forjados)
  registraram `remoteAddress = 10.42.0.0` nas **três**. O Service do Traefik usa
  `externalTrafficPolicy: Cluster`, então o kube-proxy faz SNAT **antes** do
  proxy. Duas conclusões: não há bypass por header forjado (o `trustProxy: 1`
  cumpre), mas o IP é um **balde único** — chavear por ele é dar a um estranho o
  poder de trancar os dez amigos para fora. Foi o que aconteceu no
  `/auth/discord/start`. A linha que reintroduz o bug é `user?.id ?? req.ip`;
  há teste que reprova se ela aparecer. Requisição sem Bearer não entra em
  janela nenhuma: leva 401 no `onRequest`, antes de o corpo ser lido.
- **Rota nova sem classe não sobe.** A classe vem de uma tabela por PADRÃO de
  rota, carimbada num `onRoute`; rota fora dela faz o **boot lançar**. O default
  silencioso seria uma rota nova nascendo ilimitada sem ninguém notar.
- **Os números saem das constantes do CLIENTE** (throttle de digitação, debounce
  de ack e de busca, tamanho de página), cada um com a conta no comentário: um
  limite que o próprio cliente estoura em uso normal é um bug, não uma defesa.
- **Mídia tem balde próprio.** O download de anexo **não é lazy** — sai no
  render, e cada mensagem carrega até 10 anexos — uma página de 50 mensagens
  pode disparar centenas de GETs de uma vez. No mesmo balde da paginação, rolar um canal com fotos estouraria a cota
  lendo o histórico. A classe conta REQUISIÇÕES e não bytes, e isso é limitação
  declarada: cobrir banda exige cobrar por MB no `onResponse`, e não foi feito.
- **O hook vai DEPOIS do `register(cors)`.** Antes dele, contaria o preflight —
  e como o renderer do desktop é `app://bundle`, toda ação dele gastaria duas
  unidades, com o sintoma `Failed to fetch` sem status.
- **Isento é lista explícita.** `/healthz` é o mortal: um 429 ali tira o pod dos
  Endpoints em ~30 s (Traefik devolve 503 com o processo vivo) e o mata em ~45.
- Rota com limitador próprio é `proprio` e o geral **não** a conta: levar 429 do
  soundboard é o caso normal de quem aperta o pad duas vezes, e cobrança dupla
  gastaria o balde geral sem um som tocar.
- O 429 tem **uma** função (`limits.ts`) — havia cinco cópias idênticas. A forma
  é a que o cliente já lê: `retry_after` em **segundos no corpo**.

Do lado do cliente: o `api()` lia o status e **jogava o corpo fora**. Com o
limite, existe erro que aparece sem ninguém ter feito nada errado e cuja
resposta traz a única informação útil — quanto esperar. E o editor de mensagem
agora **fica aberto com o texto** quando o PATCH falha; antes o texto digitado
evaporava sem uma palavra.

**O laço que já existia**: `maybeLoadOlder` terminava rearmando a si mesmo. Numa
falha nada é prependado, então `scrollTop` não muda e `reachedStart` continua
falso — rearmava na hora, uma requisição por RTT, para sempre. O comentário do
`catch` dizia "sem retry automático" e a linha seguinte era o retry automático.
O mesmo `if` repetia a MESMA página quando ela vinha inteira de gente bloqueada.
A condição certa é **progresso**, e agora é função pura em `pagination.ts`.

**`readOnlyRootFilesystem: true`** no pod, medido e não deduzido: no pod em
operação, `find / -xdev -newer /proc/1` fora de `/data` não devolve arquivo e os
únicos descritores de escrita são os três do SQLite. O `emptyDir` em `/tmp` é
para o temporário que o SQLite escreve quando uma query **derrama** — provado
com dois pods idênticos, um com o mount e outro sem: sem ele é
`SQLITE_IOERR_GETTEMPPATH`. Quem segura é o **volume**, não o `SQLITE_TMPDIR`
(o SQLite testa a gravabilidade de cada candidato e acha `/tmp` sozinho); a env
tira o resultado da ordem de tentativa. E o temporário só vira arquivo acima da
cache de 16 MB — é por isso que em operação normal `/tmp` fica vazio, e é por
isso que este é o `EROFS` que não aparece no boot.

**O `deploy-cluster.sh` aplica o MANIFEST** (com a imagem trocada pelo SHA no
stream). Antes só fazia `set image`, e mudar `securityContext`, volume ou env
era passo manual fora do laço — um pod que diverge do manifest em silêncio é
pior que um deploy que não roda.
## Identidade do Danjomar (M13)

O app é do time de e-sports Danjomar, e passou a parecer. **O layout do Discord
não mudou** — grid de 4 colunas, densidade, agrupamento de mensagens,
componentes: tudo intocado. Mudou cor, tipografia de título e o brasão.
Referência: o site em `E:\Work\DanjomarFront` (Next/Tailwind, `#d41824`,
Orbitron, fundo quase-preto).

- **A marca virou vermelha, e isso forçou a segunda metade da mudança.** Com
  `--brand` vermelho, "vermelho = perigo" deixa de significar algo: o `--danger`
  foi para o âmbar (`#f2964a`) e o `--warn` saiu de perto dele (`#ecd45a`) —
  âmbar e o dourado antigo ficavam a 13° no círculo de matiz, e os dois
  aparecem **lado a lado** (os selos do card do membro, os da lista).
- **`--danger` virou DOIS tokens, por física e não por gosto.** Num tema escuro
  a mesma cor não serve como preenchimento (texto claro por cima → precisa ser
  escura) e como tinta (sobre a superfície escura → precisa ser clara). Regra
  mecânica: `color:`/`border:` → `--danger`; `background:` com texto claro →
  `--danger-bg`. Isso consertou de passagem um defeito que já existia: o
  vermelho antigo cheio com `--text-strong` dava 3,4:1 e reprovava o AA.
- **Pelo mesmo motivo existe `--brand-bright`** (`#ff7a83`), para o vermelho
  usado como tinta ou marca fina (trilho do canal, anel de foco, linha de não
  lidas, ponto de "não perturbe"). E não adianta "usar um vermelho mais forte":
  `#ff0000` tem luminância 0,213 e dá 3,16:1 sobre o `--bg-chat` — **nenhum**
  vermelho puro chega aos 4,5:1, só clareando na direção do coral.
- **Vermelho que é CONVENÇÃO não virou âmbar.** "AO VIVO", badge de menção,
  linha de novas mensagens e o ponto de não-perturbe apontam para a marca, não
  para o `--danger`: o `ui/sidebar.ts` já dizia "não é 'perigo', é 'no ar'".
- **Três `color-mix` medidos à mão sumiram do `unread.css`** e isso é ganho, não
  perda de rigor: eles existiam para corrigir o contraste do blurple e do
  vermelho antigo. O vermelho do Danjomar é escuro o bastante para receber texto
  claro (4,78:1) e o `--brand-bright` já é a versão clareada. O rigor subiu para
  o `tokens.css`.
- **O brasão é gerado, não desenhado**: `apps/client/scripts/trace-logo.mjs`
  vetoriza `assets/brand/danjomar-logo-fonte.png` (PNG → contornos →
  Douglas-Peucker → path). Node puro, sem dependência — o mesmo espírito do
  `gen-sounds.mjs`. Duas descobertas que valem saber: a logo tem **uma cor só**
  (o "branco" é transparência), então é UM path com `fill-rule="evenodd"` que
  herda `currentColor` como qualquer ícone; e a tolerância (1.6) foi **medida**
  rasterizando o path de volta e comparando pixel a pixel — 726 B com 0,63% de
  divergência, que é a borda de antialiasing do PNG.
- O mesmo script gera `apps/desktop/assets/icon.png` (512×512), que alimenta
  janela, bandeja e instalador NSIS. Cruza a fronteira do pacote de propósito:
  as duas saídas vêm da mesma origem e **não podem divergir**. O
  `test/brand-asset.test.ts` amarra tudo por sha256 e refaz a vetorização para
  conferir — ao contrário dos sons, aqui dá para refazer o trabalho em Node.
- **O brasão NÃO está no `ui/icons.ts`**, e não é arrumação: aquele arquivo
  declara no topo que seus desenhos são geometria feita à mão, sem licença
  presa. O brasão é gerado, é mancha (não traço), tem proporção própria e é a
  identidade de um time — mora em `ui/brasao.ts`.
- **Orbitron é empacotada** (`assets/fonts/`, 11,8 kB, variável, subset latin).
  Google Fonts não é opção: nenhuma das três CSPs declara `font-src`, todas
  herdam `default-src 'self'`. O `vite.config.ts` ganhou as extensões de fonte
  na trava de inline — hoje a fonte passa longe dos 4 kB, mas um subset menor
  viraria `data:` URI e sumiria **só em produção**, exatamente como os
  `ptt-*.mp3` de 1,6 kB. **A forma da regra importa**: uma literal de regex só,
  porque o `sound-assets.test.ts` lê o arquivo como texto.
- **Onde a Orbitron pode aparecer é uma lista fechada**, em `styles/display.css`
  — e ele é o ÚLTIMO `@import`, porque todos os seus seletores pertencem a
  outros arquivos e `.dialog-head h2` empata em especificidade (0,1,1). A regra
  para acrescentar: é o nome de uma COISA (servidor, canal, diálogo), nunca o
  conteúdo dela. São **três** cabeças de diálogo copiadas no projeto
  (`.dialog-head`, `.settings-head`, `.sb-dialog-head`) — esquecer uma dá fonte
  errada num diálogo só.
- Superfícies que quase ficaram para trás, porque não passam pelo `tokens.css`:
  o favicon (era blurple literal no `index.html`; hoje o `main.ts` o gera do
  próprio `--brand`), o `backgroundColor` da janela do Electron (o que pisca
  antes do renderer pintar) e o badge da landing de convite — a única tela que
  alguém de fora vê antes de ter conta.

### A coluna de guilds saiu (e o que ela levou junto)

O grid tem **três** colunas agora. A de guilds existe no Discord para trocar de
servidor; aqui há um só, e eram 72px de moldura para um botão que não levava a
lugar nenhum. Dos 72 devolvidos, **24 foram para a sidebar** (é lá que estavam
os apertos) e 48 para as mensagens.

- **O brasão perdeu a casa e ganhou outra**: `#sidebar-head`, à esquerda do
  nome, com `prepend` — nunca `replaceChildren`. Quando o `mountBrand()` roda,
  aquele botão já tem o texto do HTML **e** o chevron que o `ui/sidebar.ts`
  pendurou; `replaceChildren` apagaria os dois, e o chevron não voltaria (o
  `mountSidebar` tem guarda de "já montei").
- **O chevron precisou de classe ANTES do brasão entrar.** O `sidebar.css` o
  alcançava por `#sidebar-head svg`, e agora há dois SVG ali: o brasão herdaria
  o `margin-left: auto` e **giraria 90°** a cada recolhimento das categorias.
- **20px de brasão, não 24.** "DANJOCORD" em Orbitron come ~111px dos 208 úteis;
  a 24px sobrava 0,6px quando a media query encolhe a sidebar para 200 — e o
  texto é uma palavra só, sem ellipsis, então ele não cede, vaza. Com 20px
  sobram 4,6px. Foi medido no navegador, não estimado.
- **`.conn-bar` era a mina.** O `left` dela era
  `calc(var(--col-guilds) + var(--col-side))`: apagar o token sem tocar ali
  deixaria um `var()` indefinido, e custom property indefinida **invalida a
  declaração inteira** em tempo de valor computado. O `left` cairia para `auto`
  e a faixa sairia do lugar — sem erro no console, e justamente na hora em que
  a rede cai.
- **`--bg-guilds` virou `--bg-deepest`.** Dos 22 usos, exatamente UM era da
  coluna; o resto sempre foi "a superfície mais escura da paleta" (a tela de
  login, que nunca teve coluna, é a prova). Token que nomeia uma região morta é
  como se apaga um token por engano.
- **`--glow-brand` foi apagado junto**: era o `box-shadow` do pill, e ficou sem
  consumidor. Sobrou o `--glow-brand-drop`, do brasão no login.

### Respiro e personalidade (mesma passada)

- O que estava apertado estava quase todo na **sidebar**, não no chat: o painel
  do usuário fechava em 42px (o Discord usa 52), o rodapé de voz tinha 4px de
  respiro embaixo, e o rótulo de categoria ficava 4px mais à esquerda que os
  canais que ele encabeça.
- **Dois `padding-top` de bloco de mensagem sobem juntos, sempre**: o
  `.msg:not(.msg--cont)` do `chat.css` e o `.msg:has(.unread-line)` do
  `unread.css` empatam em especificidade e têm a mesma função. Se um subir
  sozinho, o bloco que abre as não lidas fica com menos respiro que os vizinhos.
- **`.member + .member` não casa com nada** — o `ui/members.ts` põe o
  `<button class="member">` DENTRO de um `<li>`. O passo da lista é
  `.member-list li + li`. Um seletor morto não dá erro: parece que funcionou.
- **O rodapé de voz tem SEIS botões de 32px** (o sexto é o do soundboard,
  criado em JS): 212px numa faixa de 184 quando a sidebar encolhe. Era bug
  antes do M13, e o `flex-wrap` o fecha sem tirar botão de ninguém.
- **`--bg-hover`** é o `--bg-elevated` com 8% da marca: o app esquenta um grau
  no hover em vez de acender cinza. É a superfície mais tocada do produto e a
  personalidade mais barata que existe. Desfazer é uma linha.
- **A régua da marca** (um fio de 1px em gradiente sob as duas barras de 48px)
  é `position: absolute` — não vira flex item, não move um pixel, não anima.
### Onde mora cada controle de voz

O microfone e os fones ficam **só no painel do usuário**, no rodapé da sidebar.
O rodapé de VOZ tem só o que é da chamada: câmera, transmissão, soundboard e
desconectar.

Até o M13 os dois primeiros existiam nos **dois** lugares, ligados no MESMO
`toggleMute`/`toggleDeafen` e pintados por duas funções diferentes — dois
botões idênticos, um logo acima do outro, mudando de estado juntos. A divisão
certa não é "dentro/fora da chamada": mute e ensurdecer são **preferência de
quem usa o app** (valem fora da voz — é o "mutado ao entrar"), e por isso vivem
no painel que está sempre visível. Câmera e tela só existem em chamada.

De quebra o rodapé caiu de seis botões para quatro, o que resolveu de verdade o
aperto que o `flex-wrap` estava remediando.

### Mídia: onde dá para tirar a cara de navegador, e onde não dá

- **O seletor de fonte do `getDisplayMedia` no NAVEGADOR é intocável.** É UI do
  próprio Chrome, não do documento: não existe CSS, API nem truque que o
  alcance. Quem pedir "deixa esse diálogo bonito" está pedindo o impossível, e
  vale saber disso antes de tentar.
- **No app empacotado ele é NOSSO** — o `setDisplayMediaRequestHandler` devolve
  o controle e quem aparece é o `apps/desktop/src/picker.html`. Por isso ele
  ganhou a identidade do time no M13: é o único lugar onde essa tela pode
  deixar de parecer navegador. O brasão dele é **injetado pelo
  `copy-static.mjs`**, lido do mesmo `brasao-path.ts` gerado que o cliente usa
  — um path colado à mão ali ficaria velho sem ninguém notar, numa janela que
  abre por três segundos. Se o caminho quebrar, o build FALHA em vez de
  publicar um picker sem marca.
- **O picker não tem Orbitron, e é decisão**: o `font-src` dele herda
  `default-src 'none'`, então nem a fonte do bundle nem uma em `data:` carregam.
  Relaxar a CSP e colar ~16 kB de base64 por causa de duas palavras de título
  não vale — a identidade ali vem da cor, do brasão e das maiúsculas espaçadas.
  A paleta é copiada em literais porque aquela janela não carrega o bundle: ao
  mexer no `tokens.css`, mexer lá junto (é a segunda exceção do projeto, ao
  lado do `backgroundColor` da janela do Electron).
- **`color-scheme: dark` no `:root`** conserta o que o CSS não alcança: a lista
  suspensa do `<select>`, o preenchimento automático, os menus de campo. Sem
  ela o Chrome desenhava tudo isso no tema CLARO do sistema — a lista de
  microfones abria **branca** no meio de um app preto. Não é estilo, é a
  declaração de qual tema o documento tem.
- **O `<select>` continua nativo por dentro** (a lista do sistema já é
  acessível por teclado, leitor de tela e digitação — reimplementá-la é o
  componente que quase todo mundo erra). O que mudou é a casca: `appearance:
  none` tira a moldura e a setinha do Windows, e a seta volta como desenho
  nosso num `data:` URI (passa na CSP porque `background-image` é governado por
  `img-src`, que já traz `data:`).
- **O que foi recusado, e por quê**: fundo hexagonal (o do site é um `<canvas>`
  com `requestAnimationFrame` eterno — numa janela que mora semanas na bandeja
  é exatamente o defeito que o `base.css` já teve de consertar uma vez);
  `backdrop-filter` (os menus flutuam sobre cor chapada, então o blur devolve a
  mesma cor); Orbitron nos rótulos de categoria e nos dígitos das badges (mede
  +6,1px numa badge cuja largura o nome do canal paga); e glow espalhado pelos
  botões — a política escrita no `chrome.css` é que o halo existe onde o
  vermelho é identidade, não onde é ação.

## Como o app chega e como se atualiza (M14)

Até aqui não havia caminho: o instalador nascia num Release do GitHub e o
`electron-updater` apontava para a API do GitHub — que responde **404, e não
401**, a repo privado sem credencial. Ou seja: o auto-update do M6 nunca
funcionou, e ninguém tinha como descobrir isso sem tagear um release.

**O binário não fica no GitHub** (decisão do Leonardo). O CI continua
compilando — NSIS e os módulos nativos precisam de Windows — mas em vez de
publicar um Release ele faz POST dos artefatos no próprio servidor, e eles moram
no PVC, ao lado do SQLite.

- **O custo está declarado, não escondido: o pod SERVE os bytes.** Este é o
  mesmo nó que carrega a mídia (mediasoup, hostPort 40000/UDP), e o pior caso já
  documentado de um Go Live 4K com os nove amigos é ~108 Mbps de uplink dali. Um
  release novo são ~100 MB por amigo — ~1 GB se os dez atualizarem. Na prática
  isso se espalha por horas (a checagem é no login e a cada 6 h, nunca
  simultânea) e para dez amigos é aceitável. Se doer, os remédios são cobrar por
  MB no `onResponse` ou capar downloads simultâneos; nenhum foi feito.
  **Espaço não é a restrição**: medido no nó, o disco do `local-path` tem 74 GB
  livres contra 396 kB de banco. Banda é.
- **O layout é PLANO, e é exigência do electron-updater**: `latest.yml` e o
  `.exe` no mesmo nível, porque ele resolve cada arquivo com
  `new URL(nome, base)`. Nada de subpasta por versão.
- **O `release.json` é NOSSO, e existe para o servidor não ler YAML.** O projeto
  não instala dependência, e um parser de YAML à mão para ler metadado é
  exatamente o tipo de coisa que quebra calada. O `latest.yml` do
  electron-builder é servido tal e qual, sem ninguém interpretá-lo.
- **O publish tem DOIS passos, e o segundo é o que publica — mas isso só virou
  verdade depois de uma revisão.** A primeira versão afirmava que o commit era a
  chave, e era falso para o cliente que mais importa: o feed serve `latest.yml`
  direto do disco, então os apps instalados enxergavam a versão nova no instante
  em que o upload do manifesto terminava, antes do commit e mesmo que o job
  morresse em seguida. O commit governava só a página de download.
  Agora o manifesto chega em **estágio** (`latest.yml.pendente`, um nome que
  `nomeDeArtefatoValido` recusa de propósito, então o feed não o serve nem por
  engano) e o commit o promove com um `rename` atômico. A chave é uma linha, e
  vale para os dois clientes.
- **A poda protege o instalador do release que acabou de ser commitado.** Sem
  isso existe um caminho real de apagar o arquivo no ar: jobs que sobem o `.exe`
  e morrem antes do commit deixam órfãos MAIS NOVOS por mtime, e reexecutar um
  run antigo pela UI do GitHub commita uma versão cujo `.exe` é velho — a poda
  ordenava por mtime e apagava justamente ele.
- **`.tmp-*` órfão é recolhido no boot.** O `gravarArtefato` só apaga o
  temporário quando o erro chega ao processo; pod morto no meio de um upload
  (rollout, OOM, drain) deixava até 500 MB parados no mesmo PVC do SQLite. No
  boot não há upload em voo por definição — é a única hora segura.
- **O portão de versão do workflow espelha o do servidor, e é mais estrito num
  ponto.** A regex da tag era ancorada só no início: `v1.2.3.4` passava,
  compilava, subia 96 MB e só então levava 400 no commit. E pré-lançamento é
  recusado de propósito, embora `versaoValida` o aceite — o electron-builder
  deriva o CANAL da versão e emitiria `beta.yml` em vez de `latest.yml`, que o
  feed não serve e o `app-update.yml` dos apps não procura.
- **A ordem do upload importa e está no workflow**: `.exe` primeiro, `latest.yml`
  depois. Um manifesto novo apontando para um instalador que ainda não chegou
  seria uma atualização quebrada para quem checasse naquele minuto.
- **O upload tem content-type PRÓPRIO** (`application/vnd.danjocord.release`) e
  parser de FLUXO. O `raw-body.ts` bufferiza com chão de 64 kB — certo para
  anexo e som; um instalador de 100 MB por ali viraria ~200 MB de pico
  (`Buffer.concat` dobra) num pod com limite de 1 GiB.
- **A guarda do publish é um `onRequest` de ROTA**, que roda antes do parser de
  corpo: um POST sem token não chega a escrever um byte no PVC onde mora o
  banco. Comparação do token em tempo constante.
- **A poda guarda DOIS instaladores, por mtime.** Ordenar semver à mão é o tipo
  de código que erra `1.10.0` vs `1.9.0`, e a ordem de chegada já é a ordem
  certa por construção. Dois e não um porque entre ler o `latest.yml` e baixar o
  `.exe` passam minutos — um release publicado nesse intervalo apagaria o
  arquivo que alguém está buscando.
- **`artefatoExiste` compara com o `readdir`, não só com o `stat`.** O NTFS é
  insensível a maiúsculas e o ext4 do pod não é: `LATEST.YML` abre o arquivo na
  máquina de quem desenvolve e dá 404 em produção. E quem COMPILA é um runner
  Windows enquanto quem serve é Linux — é a fronteira exata onde isso vira
  "publiquei e o pod não acha". O teste pegou isso.
- **`sendFile` do `@fastify/static`, e não um stream à mão**: traz Range, ETag e
  Last-Modified de graça. Range importa de verdade — são ~100 MB numa conexão
  doméstica, e sem ele um download cortado em 90% recomeça do zero.
- **O tíquete vai na QUERY, e isso é decisão.** Dois motivos, um por cliente: o
  navegador não manda header numa NAVEGAÇÃO (a sessão vive no localStorage, não
  em cookie), e o executor HTTP do electron-updater **repassa os headers ao
  seguir um redirect**. Funciona porque o `newUrlFromBase` do electron-updater
  propaga a query da base para cada arquivo que resolve; é o mecanismo
  documentado para feed privado. O preço está declarado: o tíquete entra no log
  do Fastify, e a mitigação é o ESCOPO — ele só abre os arquivos do release, não
  vira sessão (roadmap 129).
- **A barra final da URL do feed não é estilo.** Sem ela,
  `new URL("latest.yml", ".../feed?t=x")` SUBSTITUI o último segmento e vira
  `/api/updates/latest.yml`, que cai no fallback de SPA e volta index.html com
  content-type de HTML — relatado como "YAML inválido". Tem teste.
- **Download diferencial DESLIGADO.** O blockmap troca banda (o eixo em que este
  projeto tem folga) por muitas requisições de RANGE e superfície que pode
  falhar no meio (o eixo apertado). E um instalador de Electron é quase todo
  `app.asar` recomprimido — o delta raramente compensa.
- **Quem manda checar é o RENDERER**, não o main: o feed precisa de sessão, e no
  `ready` do Electron ainda não houve login. O main virou executor
  (`update:check`). Checagem no login e a cada 6 h.
- **Baixar é automático; instalar não.** Instalar fecha o app, e fechar o app no
  meio de uma chamada de voz é a pior coisa que um atualizador pode fazer com
  ESTE projeto. Baixou → faixa com "Reiniciar agora" (a frase muda se a pessoa
  está em chamada, porque a consequência muda); ninguém clicou → o
  `autoInstallOnAppQuit` instala quando ela sair pelo tray.

O `publish` do `apps/desktop/package.json` é `generic` apontando para o nosso
feed — é isso que faz o electron-builder **gerar o `latest.yml`** e carimbar o
`app-update.yml` de dentro do app. O `--publish never` do CI só impede o upload;
quem entrega é o `curl` do workflow. Verificado compilando de verdade: um
instalador de 96 MB, `latest.yml` correto ao lado, e `app-update.yml` apontando
para `/api/updates/feed/`.

### A página `/download`

Irmã da landing de convite (`ui/download-page.ts`), e a segunda tela que alguém
de fora vê deste servidor.

- **A página é pública, os BYTES não.** O `.exe` leva os sons proprietários
  dentro, e a condição escrita no ATTRIBUTIONS.md é "instância fechada". Quem
  não está logado vê o mesmo cartão com "Entrar com Discord" no lugar do botão —
  e isso não exclui ninguém, porque para USAR o app é preciso estar na allowlist
  de qualquer jeito.
- **O caminho volta depois do OAuth.** O login traz o navegador para a RAIZ
  (`APP_URL`), então `/download` se perde no meio; a intenção fica no
  `sessionStorage` (por aba, não atravessa origem, não é credencial — o código
  de convite, que É credencial, continua no `state` assinado).
- **`location.assign`, nunca `fetch` + Blob**: 100 MB num `createObjectURL` fica
  inteiro na memória da aba e tira do navegador a barra de progresso, o retomar
  e a escolha de pasta. A página NÃO é abandonada no caminho feliz — a resposta
  vem com `Content-Disposition: attachment` (medido, com o instalador real: o
  clique dispara o GET e a página continua montada). No caminho de erro o
  servidor **redireciona de volta** para `/download?erro=…` em vez de devolver
  JSON: quem está ali é uma navegação, e um corpo JSON deixaria a pessoa numa
  aba branca sem botão de tentar de novo.
- **O aviso do SmartScreen vem ANTES do clique** (roadmap 112 segue aberto — o
  app continua sem assinatura). O Windows esconde o "Executar assim mesmo" atrás
  de "Mais informações", e quem não foi avisado lê aquilo como vírus e desiste.
  É `--warn` e não `--danger` de propósito: a tela azul é etapa esperada, e
  pintá-la de perigo confirmaria o medo que o texto existe para desfazer.

### A trava de distribuição saiu

O `desktop-release.yml` reprovava o build enquanto houvesse `.mp3` no catálogo
de sons. Ela foi **retirada a pedido do Leonardo** — não substituída. O que
segura hoje é o desenho: o `.exe` só sai por `/api/updates`, que exige sessão de
membro, e não existe mais artefato hospedado fora daqui. Não há mais nada
mecânico impedindo uma distribuição aberta; a advertência do ATTRIBUTIONS.md
passou a valer por leitura, e não por trava.

## Convenções

- TypeScript estrito (base em `tsconfig.base.json`); ESM em tudo.
- Todo payload que entra (WS ou REST) passa por schema Zod de
  `packages/protocol` — nada de `JSON.parse` cru virando objeto confiável.
- Auth (M1): OAuth do Discord + allowlist → sessão própria — JWT de acesso
  curto (HS256, iss/aud `danjocord`) + refresh opaco rotativo com detecção de
  reuso, na tabela `sessions`. A auth de desenvolvimento continua existindo:
  token `dev.<username>` e `POST /auth/dev` (só com `DANJOCORD_DEV_AUTH=1`,
  default fora de produção — NUNCA ligar em produção).
- **Credenciais de dev ficam no `.env` da raiz** (gitignored). O `config.ts` o
  carrega com `process.loadEnvFile` porque só o `docker compose` lê esse arquivo
  sozinho — sem isso, `pnpm dev` dava 503 em `/auth/discord/start` com o `.env`
  preenchido do lado, sintoma que não aponta para nada. `loadEnvFile` **não
  sobrescreve** o que já existe em `process.env`: shell, container e Secret do
  k8s vencem o arquivo, e é isso que mantém os testes imunes a ele.
- **O `redirect_uri` do OAuth tem uma fonte só**: `PUBLIC_BASE_URL +
  "/auth/discord/callback"`, calculado **uma vez no boot** (`oauth.ts`), nunca
  derivado do header `Host`. Trocar de ambiente é trocar `PUBLIC_BASE_URL` e
  cadastrar a URL correspondente no Developer Portal — dev
  (`http://localhost:8080`), staging (`https://danjocord.local.leohammes.dev`)
  e produção (`https://danjocord.leohammes.dev`). O `APP_URL` é **outra coisa**:
  é para onde o navegador volta com o one-time code; na imagem de produção
  (`NODE_ENV=production`) ele cai em `PUBLIC_BASE_URL`, então num ambiente que
  define um e esquece o outro o login "termina" numa URL vazia.
- **Nada de `127.0.0.1` vai ao Developer Portal.** O loopback do desktop (M6) é
  um segundo 302, do NOSSO callback, depois de o OAuth já ter acabado — o
  Discord nunca vê a porta (`test/oauth-loopback.test.ts` crava isso). Porta
  aleatória nem seria cadastrável: o Discord casa redirect URI por igualdade
  exata, sem curinga.
- Migrations: arquivos `NNN_nome.sql` em `apps/server/migrations`, aplicados
  em ordem no boot. Nunca editar migration aplicada; criar a próxima.
- Estado efêmero (presença, voice states, ring buffers) vive **em memória** —
  restart derruba sessões de gateway por desenho (clientes fazem re-Identify).
