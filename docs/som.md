# Som (M8) — decisões e o risco do vazamento

Este arquivo é o **porquê** do sistema de som. Os outros dois lugares onde o
assunto mora:

- [`ATTRIBUTIONS.md`](../ATTRIBUTIONS.md) — o **quê**: procedência, licença e
  arquivo de origem de cada um dos 14 clipes, mais a receita de medição para
  quem for trocar um som.
- [`apps/client/src/sound/`](../apps/client/src/sound/) — o **como**: o
  catálogo (`catalog.ts`), a política (`policy.ts`), o player (`player.ts`),
  as preferências (`prefs.ts`) e a fachada (`index.ts`).

O que está aqui e em nenhum dos dois: o caminho completo de um som, a
investigação do item 20 do [ROADMAP](../ROADMAP.md) (*"os sons de UI vazam para
o microfone?"*) e as decisões que produziram o resto.

---

## 1. O caminho de um som

Nenhum módulo do cliente fala com o `player` direto. Todo som atravessa a mesma
sequência — evento → foto do mundo → decisão → ganho → saída — e é essa
sequência, não a lista de arquivos, que é o sistema:

```
 main.ts (dono do estado)                sound/  (a fachada é o index.ts)
 ───────────────────────                 ─────────────────────────────────────

 VOICE_STATE_UPDATE ──┐
 MESSAGE_CREATE ──────┤
 clique em mute/fone ─┼──► emit({ name, actorId?, channelId? })
 keydown/keyup do PTT ┤              │
 setConnectionStatus ─┘              │   emitConnection() entra por aqui, mas
                                     │   só depois de ~2 s de estado ESTÁVEL
                                     │   (um blip de rede não vira som)
                                     ▼
   mountSound(() => mundo) ─────► FOTO DO MUNDO, tirada AGORA
   (um CALLBACK, não um objeto:      meId · deafened · voiceChannelId
    o mundo é lido no instante do     viewingChannelId · windowFocused
    evento, nunca no boot)                  │
                                            │
   prefs.ts ── getPrefs() ──────────────────┤  master · volume · categories{}
   (localStorage, tolerante a lixo)         │
                                            ▼
   catalog.ts ────────────────────►  policy.decide(evento, mundo)
   (categoria + ganho do som)        ┌──────────────────────────────────┐
                                     │ 1. master desligado?     → null  │
                                     │ 2. categoria desligada?  → null  │
   ┌── é AQUI que o deafen mora ────►│ 3. deafened E a categoria está   │
   │   (DEAFEN_SILENCES =            │    em DEAFEN_SILENCES?   → null  │
   │    voice + notify)              │ 4. relevante? (é meu? é no meu   │
   │                                 │    canal? está à vista? a janela │
   │                                 │    tem foco?)            → null  │
   │                                 │ 5. ganho = gain × prefs.volume   │
   │                                 └──────────────────────────────────┘
   │                                            │ { gain }
   │                                            ▼
   │                                  player.play(nome, ganho)
   │                                   ├─ contexto travado (nenhum gesto do
   │                                   │  usuário ainda)? IGNORA — som de um
   │                                   │  evento de 30 s atrás é pior que
   │                                   │  silêncio, então nada é enfileirado
   │                                   ├─ buffers.get(nome) ← decodeAudioData
   │                                   │  uma única vez por clipe, no preload
   │                                   └─ o mesmo som já tocando? corta o
   │                                      anterior (rajada não empilha)
   │                                            │
   │        AudioBufferSourceNode ──► GainNode ──────► ctx.destination
   │            (o clipe em PCM)      envelope         (AudioContext único,
   │                                  0 → ganho → 0     SEM sinkId)
   │                                  fade de 5 ms           │
   │                                  nas duas bordas        ▼
   └───────────────────────────────────────────────► SAÍDA PADRÃO DO SO
                                                     — o MESMO mix por onde
                                                       sai a voz da chamada.
                                                       O §2 é sobre o que
                                                       acontece depois daqui.
```

Três coisas que o desenho diz e que valem mais que os nomes dos arquivos:

1. **A decisão está num lugar só.** Antes do M8 a regra "não toque o meu
   próprio som" existia duas vezes no `main.ts` — uma no dispatch do
   `VOICE_STATE_UPDATE`, outra no `onChange` do `VoiceClient`, cada uma com sua
   checagem de deafen. Duas cópias da mesma regra é como uma regra vira duas
   regras diferentes sem ninguém perceber. Hoje quem responde é `decide()`, que
   é puro e tem teste (`apps/client/test/sound-policy.test.ts`).
2. **O mundo é lido no instante do evento.** Por isso `mountSound` recebe uma
   função. Uma foto tirada no boot já estaria errada no primeiro join — e o
   `windowFocused` (que decide se o som de mensagem toca) muda entre um evento
   e o seguinte.
3. **O ganho tem dois fatores e nenhum deles está no arquivo**: a normalização
   por som (do catálogo) e o volume geral (das preferências). É disso que o §3.1
   trata.

---

## 2. Os sons de UI vazam para os outros? (item 20 do ROADMAP)

Um som de UI toca no **mesmo mix** da voz da chamada. Um app de call tem dois
caminhos por onde esse mix pode voltar para dentro da conversa:

```
   (a) CAMINHO ACÚSTICO — só quem usa alto-falante
       ctx.destination → mix do SO → alto-falante → ((ar da sala)) → microfone
                                                                       │
                                                    getUserMedia com   │
                                                    echoCancellation ──┘
                                                    ↑ o AEC vive AQUI

   (b) CAMINHO DIGITAL — Go Live com áudio de sistema, no Windows
       ctx.destination → mix do SO ─┬─► (DAC) → fone/alto-falante
                                    │
                                    └─► WASAPI loopback → track screen_audio
                                        → produce() → todos os espectadores
                                        ↑ NÃO passa por AEC nenhum,
                                          e o fone NÃO ajuda: a tomada
                                          é digital, antes do DAC
```

### 2.1 O que dá para afirmar só lendo o código

Fatos, não estimativas:

- **UI e chamada saem pela mesma saída.** O `player.ts` faz `new AudioContext()`
  sem `sinkId` e sem `latencyHint`, e conecta em `ctx.destination`. Não existe
  um único `setSinkId` no repositório (item 38 do ROADMAP: seleção de
  dispositivo ainda não existe). Logo, por construção, os blips, os `<audio>`
  de cada participante remoto e o `<video>` do stream assistido caem todos no
  mesmo dispositivo padrão. Isso importa muito no cenário (a) — é exatamente a
  condição em que a referência do AEC *pode* conter o blip.
- **O microfone passa pelo processamento; o áudio de sistema não.** O
  `captureAudio()` do `voice.ts` pede
  `{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }`
  (fixos — item 39). Já o `captureScreen()` pede `audio: true` no
  `getDisplayMedia` sem nenhuma constraint de processamento, e o track resultante
  é produzido cru (`appData: { source: "screen_audio" }`, sem DTX de propósito).
  O AEC mora no pipeline de **captura de microfone**; ele não tem nada a ver com
  o track de tela.
- **No Windows o áudio do Go Live é o sistema inteiro.** O
  `apps/desktop/src/picker.ts` responde ao `setDisplayMediaRequestHandler` com
  `callback({ video: source, audio: "loopback" })`. `loopback` é a tomada do
  *render endpoint* do WASAPI: tudo o que a máquina toca, inclusive o que o
  próprio Danjocord toca. O picker já avisa isso ao usuário desde o M6
  ("o áudio do sistema — tudo que tocar no computador — será transmitido
  junto"), o que é a disclosure certa e, hoje, também a única mitigação.
- **O nível de partida é baixo.** Os clipes tocam em ~-20 dBFS de RMS e o
  volume geral default é 0.6, o que os põe perto de -24 dBFS antes do volume do
  sistema. O que vaza, seja por onde for, parte daí.

### 2.2 Cenário (a) — o blip volta pelo meu microfone

**É real?** Só para quem usa alto-falante *e* está com o microfone aberto (sem
mute e, no desktop, sem PTT). Com fone, o caminho não existe: o som não chega
ao ar da sala.

**O AEC cobre?** Provavelmente sim, e a topologia do §2.1 é o motivo — mas a
resposta honesta é *"provavelmente"*, não *"sim"*. O AEC3 do Chromium não
cancela "o que a chamada tocou": ele cancela o que está na **referência de
render** que recebe. Essa referência é o mix que o serviço de áudio entrega ao
dispositivo de saída, e um `AudioContext` sem `sinkId` renderiza dentro desse
mesmo mix. No papel, o blip está na referência e é cancelado como qualquer
outro eco.

O que **não** dá para afirmar lendo este repositório:

- **Onde exatamente fica a tomada da referência nesta build.** Isso é do
  Chromium (o Electron aqui é o 43), varia por plataforma e já mudou de lugar
  entre versões: a referência pode ser o mix do dispositivo (que inclui o
  WebAudio) ou apenas o stream de playout do WebRTC (que não incluiria). No
  Windows ainda existe a possibilidade de o Chromium delegar para o
  processamento de voz do próprio driver, e aí a cobertura costuma ser mais
  ampla — mas depende do driver.
- **O resíduo.** AEC cancela bem eco **linear**. Alto-falante de notebook em
  volume alto é não-linear; um transiente curto (um "click") é o pior caso para
  um filtro adaptativo que acabou de convergir em voz; e o AGC, que também está
  fixo em `true`, levanta ganho no silêncio — justamente onde o resíduo ficaria
  audível.
- **Troca de dispositivo no meio da call.** Fone Bluetooth caindo para HFP, ou
  o usuário mudando a saída padrão do Windows: por um intervalo o
  `AudioContext` e o playout da chamada podem estar em endpoints diferentes, e
  aí a condição do §2.1 deixa de valer.

Vale registrar o que **não** é risco: não há realimentação. O meu blip vaza uma
vez para os outros; do lado deles ele chega como stream recebido, e o eco do
alto-falante deles é problema do AEC deles. Nada disso se retroalimenta.

### 2.3 Cenário (b) — o blip vai junto no Go Live

**É real?** Sim — e aqui não é "provavelmente": o mecanismo é suficiente. No
Windows, `audio: "loopback"` captura o mix do endpoint de render, o
`AudioContext` do player renderiza nesse mix, e o track vai cru para o
`produce()`. Todo espectador ouve o blip de quem transmite. **Usar fone não
resolve**: a tomada é digital, antes do conversor — a única coisa que o fone
muda é que o *transmissor* também ouve o próprio blip.

E a parte desconfortável, que a investigação obriga a escrever: **os sons de UI
são a menor parte do que vaza por esse caminho.** O mesmo mix carrega a voz de
todo mundo na chamada. Quem assiste a uma transmissão recebe, junto com a tela,
a call inteira de volta, atrasada — inclusive a própria voz. Isso não é uma
regressão do M8: existe desde o M5 e não depende de som de UI nenhum. O M8 é
só quando alguém foi olhar.

### 2.4 Mitigações, da mais barata para a mais cara

1. **Nenhuma, para o cenário (a) — o nível já é a mitigação.** Clipe em -20
   dBFS de RMS, volume default 0.6, atenuação da sala e mais o AEC por cima: o
   que sobra fica muito abaixo da fala. Se o teste do §2.5 mostrar o contrário,
   a ordem é: baixar o volume default; depois "abaixar" (duck) a categoria
   `notify` enquanto o meu track de microfone está `enabled` — um campo a mais
   no `SoundWorld` e uma linha na `decide()`; e, quando o item 38 existir,
   fixar o `AudioContext` no mesmo dispositivo do playout com `setSinkId`, o
   que torna a condição do §2.1 verdadeira **por construção** em vez de por
   coincidência. O que **não** vale a pena: desligar os sons durante a chamada
   — é remover a funcionalidade para consertar um talvez.

2. **Cenário (b), o remendo barato (~5 linhas, sem tocar em protocolo):**
   enquanto EU estou transmitindo COM áudio de sistema, não tocar som de UI.
   Um campo a mais na foto do mundo (`sharingSystemAudio`, derivado de
   `voice.streamOn` + existência do track de `screen_audio`) e um retorno
   antecipado na `decide()`. A recomendação é silenciar **tudo menos
   `system`**: `system` é raro e um "caiu" tocando durante uma transmissão
   significa que a transmissão está morrendo de qualquer jeito. O preço é
   explícito: enquanto transmito, eu deixo de ouvir menção — e é um preço
   melhor que blipar no ouvido de todo mundo que está assistindo.

3. **Cenário (b), o conserto de verdade (não cabe num milestone de som):**
   *loopback por processo*. O WASAPI do Windows 10 2004+ tem
   `ActivateAudioInterfaceAsync` com `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`
   e `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` — capturar o áudio do
   sistema **exceto** a árvore do meu próprio processo. É literalmente o que um
   app de call quer: o jogo e o navegador vão, o Danjocord não. Resolve os
   blips **e** o eco da call, que o item 2 não resolve. O Electron não expõe
   isso no `setDisplayMediaRequestHandler`; sairia um módulo nativo no processo
   main alimentando um track — trabalho de um milestone próprio.

4. **Descartado com uma linha:** o Electron aceita `audio: "loopbackWithMute"`,
   que captura o sistema e **muta a saída local**. Serve para "assistir um
   vídeo junto"; num app de call, mutaria a chamada inteira para quem está
   transmitindo.

### 2.5 O roteiro de 5 minutos (o que só hardware responde)

Duas coisas ficaram sem resposta na leitura de código: se o AEC desta máquina
de fato cancela o blip (§2.2) e qual o nível percebido do vazamento do Go Live
(§2.3). Os dois testes abaixo cabem em cinco minutos e não precisam de
instrumentação.

**Teste 1 — vazamento pelo microfone (~2 min).**

Precisa de: máquina **A** com o áudio saindo pelos **alto-falantes** (é o
cenário), microfone aberto (sem mute, sem PTT); e **B** em outra máquina, de
fone, com o próprio microfone mutado. Os dois no mesmo canal de voz, volume do
sistema de A em uns 70%, volume geral do som de A em 100%.

1. Em **A**, no painel de som, aperte "testar" no `mention` cinco vezes, com uns
   2 s entre uma e outra, **em silêncio total** (ninguém falando).
2. Em **B**: ouviu o blip?
3. Repita com **A falando por cima** do blip. Este é o caso realista — e é onde
   o AEC trabalha pior (duplo-talk).
4. Controle: em **A**, desligue a chave geral do som e repita a fala. O que B
   ouvir agora é a linha de base do canal.

Leitura do resultado:

- nada em B, nos dois passos → o AEC cobriu **nesta máquina, com este driver e
  este alto-falante**. Fecha o item 20 com a ressalva do escopo.
- blip só no passo 3 → resíduo de duplo-talk, o esperado. Decide-se no volume
  default, não no código.
- blip já no passo 1 → o som **não** está na referência do AEC. Aí vale a
  mitigação 1 do §2.4 (duck enquanto o mic está aberto).

Medida objetiva opcional, 30 s: rode A no navegador (`pnpm dev`) e abra
`chrome://webrtc-internals` → a conexão → as stats do `media-source` de áudio.
Quando o Chromium as expõe, `echoReturnLoss` e `echoReturnLossEnhancement`
dizem que o AEC está ativo e quanto ele está cancelando; um mergulho do
`echoReturnLossEnhancement` no instante do blip é o sintoma de um som que o
cancelador não reconheceu.

**Teste 2 — vazamento pelo Go Live (~2 min, e é o decisivo).**

Precisa de: **A** no **app desktop, no Windows, DE FONE** — o fone é o ponto do
teste, ele elimina o caminho acústico e isola o digital. **B** em outra máquina.

1. **A** entra na voz, aperta Go Live e escolhe uma tela (o aviso laranja de
   áudio do sistema aparece no picker — confirme que apareceu).
2. **B** clica em "Assistir".
3. **A** aperta "testar" no `mention`.
4. **B** ouviu? Com A de fone, um "sim" prova que o caminho é digital. Nenhum
   volume, nenhum AEC e nenhum headset resolvem — só a mitigação 2 ou 3 do
   §2.4.
5. Bônus de 20 s, ainda com o mesmo setup: **B fala**. A ouve pelo fone. Se B
   ouvir a **própria voz voltar com atraso**, está demonstrado o problema maior
   do §2.3 — o que vaza no loopback não são os blips, é a call.

---

## 3. As decisões

### 3.1 Ganho no playback, não reencode

Os clipes da Kenney vêm com níveis muito diferentes entre si. Nivelar tem dois
caminhos: reescrever os arquivos (o `loudnorm` do ffmpeg, item 10 do ROADMAP)
ou aplicar um ganho por som na hora de tocar.

O motivo circunstancial é que **não há ffmpeg nesta máquina**. O motivo que
importa é outro: com ganho no playback, o `.ogg` fica **intacto** e o
nivelamento vira **dado** — 14 números num `Record` versionado
(`catalog.ts`), auditáveis num diff, ajustáveis sem reprocessar nada e sem
perder a rastreabilidade até o arquivo original do pack. Reencode é
irreversível: a partir dele, "o arquivo do repo" e "o arquivo do pack" deixam
de ser a mesma coisa, e a linha do `ATTRIBUTIONS.md` vira uma promessa em vez
de uma verificação (é literalmente `fc /b` contra o pack baixado).

Há um bônus didático: o ganho é **invertível**. A tabela foi produzida por

```
gain = min(0.1 / rms_do_clipe, 0.89 / pico_do_clipe)
        └── alvo -20 dBFS ──┘   └── teto de pico ──┘
```

então ler `voice-join: 0.327` é ler que aquele clipe é bem mais quente que o
alvo, e ler `ptt-on: 1.101` é ler que aquele é mais frio. Onde o teto de pico é
que ganhou (`message`, `ptt-on`, `ptt-off`, `disconnected`), o número conta a
respeito do pico, não do RMS: são clipes que não chegam a -20 dBFS sem clipar e
ficam **de propósito** um pouco mais baixos. No caso do PTT isso é até
desejável — ele dispara o tempo todo.

O custo dessa escolha é um só, e está escrito no `ATTRIBUTIONS.md`: trocar um
som é trocar o arquivo **e** recalcular o número.

### 3.2 Alvo de -20 dBFS de RMS

Som de UI existe para ser notado sem interromper. O critério é comparativo, não
absoluto: **ele tem que ficar abaixo da voz da chamada**. Voz normalizada numa
call vive na casa dos -18 a -12 dBFS; um blip em -20 dBFS de RMS é ouvido com
clareza e não compete com quem está falando. O teto de pico em 0.89 é margem
para duas coisas: o `linearRamp` do envelope no `player.ts` e a soma com a voz
na saída, sem clipar o mix.

**Por que RMS em dBFS e não LUFS**, como pedia o item 10 do ROADMAP
(loudnorm EBU R128, -20 a -16 LUFS): o R128 mede loudness em janela de 400 ms
com filtro de ponderação. Os clipes daqui têm entre décimos de segundo e pouco
mais que isso — vários **não preenchem nem uma janela**. Medir loudness
integrado de um clique é medir a janela, não o clique. RMS simples sobre o
clipe inteiro é uma medida honesta nessa escala, e é reprodutível em quinze
linhas de WebAudio (a receita está no `ATTRIBUTIONS.md`), sem depender de
ferramenta externa nenhuma.

### 3.3 Ogg Vorbis

O item 9 do ROADMAP propunha OGG/**Opus** 48 kHz mono como formato canônico.
Ficou Ogg **Vorbis** — que é como os packs da Kenney vêm —, e a razão é a mesma
do §3.1: **não transcodificar**. Reencodar de um formato com perda para outro
formato com perda acumula artefato para não ganhar nada aqui. Os 14 clipes
somam ~140 KB; o alvo de "3–8 KB por clipe" do item 9 fazia sentido para um
catálogo grande, não para isto.

O argumento a favor do Opus/48 kHz era casar com o clock do mediasoup — e ele
volta a valer **se e quando** o som precisar entrar no SFU (o spike do item 32,
injeção via PlainTransport). Não é o caso do playback local: o
`decodeAudioData` entrega PCM e o `AudioContext` reamostra para a taxa dele de
qualquer jeito. Codec de arquivo e codec de transporte são problemas
diferentes; misturá-los custaria qualidade sem comprar nada.

Vorbis serve porque o alvo de entrega é **Chromium**: o Electron do app e os
navegadores de dev decodificam nativamente, via `decodeAudioData`, sem
biblioteca nenhuma.

**A ressalva do Safari.** Ogg/Vorbis é o ponto cego do Safari — o suporte é
recente, irregular entre versões de macOS e historicamente ausente no iOS. Não
afeta nada hoje (o cliente web é ferramenta de desenvolvimento; o produto é o
Electron), mas se um dia o cliente web precisar rodar lá, o caminho é
**detectar e ter uma segunda cópia** em `.m4a`/AAC, escolhida por
`canPlayType`/feature-detect — e não trocar o formato base, que penalizaria o
alvo real por causa de um navegador que ninguém usa aqui.

### 3.4 Por que `self` e `system` escapam do deafen

Ensurdecer não é "desligar o áudio do app": é **"não quero ouvir nada que venha
de fora"**. Quem vem de fora são as categorias `voice` (entrar, sair, alguém
começou a transmitir) e `notify` (mensagem, menção) — e é essa lista que está
em `DEAFEN_SILENCES`.

`self` é a resposta às **minhas** ações: eu apertei o botão, o som confirma que
o app entendeu. Silenciar isso é a mesma classe de erro que apagar o clique do
botão. E há a redução ao absurdo: `self-undeafen` é da categoria `self` e toca
no exato momento em que o deafen ainda vale — se o deafen silenciasse `self`, o
som de **voltar a ouvir** seria o único que nunca tocaria.

`system` (caiu, voltou, erro) escapa por outro motivo: é aviso de estado
crítico sobre o próprio app. Ensurdecer é uma decisão sobre as **pessoas**, não
sobre a conexão. Alguém de fone, ensurdecido, com a janela no tray, precisa
saber que a conexão caiu — e é justamente nessa situação que ele não tem
nenhuma outra pista.

O PTT vive em `self` pelo mesmo raciocínio, e com um detalhe prático: é o som
que dispara com mais frequência no app inteiro, então é também o que mais
precisa ser discreto (§3.1) e o que mais óbvio ficaria se sumisse ao ensurdecer
— o usuário continua **falando** enquanto está ensurdecido.

### 3.5 Licença: só CC0

A regra e as exclusões estão no [`ATTRIBUTIONS.md`](../ATTRIBUTIONS.md); aqui
fica o raciocínio.

O Danjocord vira um **`.exe` distribuído** (NSIS, GitHub Release). Isso muda a
pergunta de licença: não é "posso usar este som no meu projeto", é "posso
copiar este arquivo para o disco de outra pessoa". CC0 é a única resposta que
sobrevive a essa pergunta sem ninguém precisar ler contrato — inclusive quem
fizer fork.

- **CC-BY ficaria de fora por atrito, não por proibição:** exige crédito
  visível, e um app sem tela "Sobre" (item 105) não tem onde pôr. Quando a tela
  existir, o `ATTRIBUTIONS.md` já é o lugar onde o crédito estaria pronto.
- **CC-BY-NC é proibido no projeto.** "Non-commercial" não tem fronteira
  definida o bastante para valer a discussão num projeto que qualquer um pode
  clonar.
- **Pixabay, Mixkit e ZapSplat estão fora mesmo com clipes gratuitos**: as três
  proíbem redistribuir o arquivo *sem modificação significativa*. Copiar o
  `.ogg` para o disco do usuário é exatamente isso — e um soundboard (M9) é
  literalmente redistribuir o arquivo para ser tocado.
- **Nenhum som do Discord.** As brand guidelines vedam o reuso de "sounds", com
  essa palavra na cláusula. Independentemente disso: copiar o som do Discord
  não ensina nada. Escolher um som por medição, ensina — que é o §3.6.

### 3.6 Como os 14 clipes foram escolhidos: por medição

O pack da Kenney tem uma centena de arquivos com nomes como `maximize_002` e
`error_003`. Escolher **pelo nome** seria escolher pela intenção de quem
gravou; o que interessa é o que o clipe **faz no ouvido**. Cada candidato foi
decodificado no navegador (`decodeAudioData`, o mesmo caminho que o player usa
em produção) e medido em quatro eixos:

- **duração** — som de UI que passa de ~400 ms começa a parecer trilha; o de
  PTT precisa ser bem mais curto que isso, porque toca no meio da fala;
- **pico** — quem já está perto de 0 dBFS não pode ser levantado ao alvo sem
  clipar (é o que produz os quatro ganhos limitados por pico do §3.1);
- **RMS** — de onde sai o ganho;
- **direção do brilho espectral** — medido em **três janelas** (começo, meio,
  fim), comparando a proporção de energia em alta frequência entre a primeira e
  a última. Um proxy barato serve: energia acima de ~2 kHz sobre a energia
  total, ou a taxa de cruzamentos por zero, janela a janela.

```js
// proxy de brilho por janela: fração de cruzamentos por zero.
// sobe do começo para o fim → som ascendente; desce → descendente.
function brilho(buf, janelas = 3) {
  const d = buf.getChannelData(0), tam = Math.floor(d.length / janelas);
  return Array.from({ length: janelas }, (_, j) => {
    let cruz = 0;
    for (let i = j * tam + 1; i < (j + 1) * tam; i++) {
      if (d[i - 1] < 0 !== d[i] < 0) cruz++;
    }
    return +(cruz / tam).toFixed(4);
  });
}
```

**É a direção que carrega o significado.** Um som que sobe é chegada, abertura,
ligar; um que desce é saída, fechamento, desligar. Isso não é convenção de
software — é a mesma leitura de uma pergunta contra uma afirmação em quase
todas as línguas, e é por isso que funciona sem ninguém precisar aprender. O
`sounds.ts` do M6, com seus dois osciladores (A4→D5 subindo no join, descendo
no leave), já estava certo **nessa** decisão; o que estava errado era o timbre.
O M8 troca o timbre e **preserva a direção**.

O achado que fechou o catálogo foi que a Kenney já tinha feito metade do
trabalho: `maximize`/`minimize` e `open`/`close` são **pares espelhados** — o
segundo é o primeiro ao contrário. Daí saem, de graça, duas oposições
perfeitamente simétricas: entrar/sair (`voice-join`/`voice-leave`) e
ensurdecer/voltar-a-ouvir (`self-deafen`/`self-undeafen`). Par espelhado é
melhor que dois sons "parecidos": a assimetria entre eles é audível e é o
próprio significado.

A tabela final — qual arquivo de origem virou qual som — está no
`ATTRIBUTIONS.md`, junto com o script que recalcula o ganho de um clipe novo.

### 3.7 O que fica para o M9 (soundboard)

O soundboard é o §3 do ROADMAP e já **depende** de tudo o que está aqui. A
recomendação registrada no item 22 é a rota **(a)**: evento no gateway +
playback **local** do asset embutido — ou seja, quando um amigo aperta um pad,
o que chega em mim é um evento, e quem toca é este mesmo player. O trabalho no
cliente, então, é pequeno de propósito:

- **uma categoria nova** (`soundboard`) no `catalog.ts`, entrando em
  `DEAFEN_SILENCES` — som que vem dos outros. Isso resolve, de nascença, o item
  27 ("com playback local o deafen atual **não silencia** o pad"): o deafen
  deixou de ser um `if` no `main.ts` e virou uma lista de categorias;
- **N entradas novas** no catálogo, cada uma com seu ganho medido pela mesma
  receita — e aqui o §3.1 se paga: som de soundboard vai chegar em níveis
  malucos, e nivelar é editar um número;
- **um `emit`** no dispatch do `VOICE_SOUNDBOARD`, com `actorId` e `channelId`.
  A `decide()` já sabe responder "isso é no meu canal?" e "fui eu?" sem uma
  linha nova;
- o volume por categoria e a chave geral do painel já valem para o pad.

Duas coisas que o M9 vai ter que resolver e que **não** estão resolvidas aqui:
o cooldown/anti-spam (itens 24 e 25 — server-side, porque validação de cliente
não é validação), e o §2.3 deste documento **amplificado**: som de soundboard é
alto e frequente por natureza, então quem estiver transmitindo com áudio de
sistema vai despejar cada pad no ouvido dos espectadores. A mitigação 2 do
§2.4, se implementada antes, já cobre o pad junto.
