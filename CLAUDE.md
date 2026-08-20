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
- **CORS de dev**: a lista de métodos em `index.ts` já mordeu duas vezes (M2
  faltavam PATCH/DELETE, M11b faltava PUT). O sintoma engana — `Failed to fetch`
  sem status, porque o navegador barra no preflight. Método novo entra lá junto.

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
