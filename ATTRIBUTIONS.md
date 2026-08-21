# Atribuições — assets de terceiros

Todo asset de terceiro que entra no Danjocord é registrado aqui: procedência,
licença e o que ela permite. "De onde veio este arquivo" é exatamente a pergunta
que aparece quando alguém questiona uma licença, e um ano depois ninguém lembra.

---

## ⚠️ ESTE REPOSITÓRIO NÃO PODE SER DISTRIBUÍDO

**12 dos 14 sons de interface são assets proprietários do Discord** (§ abaixo).
Enquanto eles estiverem em `apps/client/assets/sounds/`, valem três limites, e
eles não são formalidade:

1. **O repositório fica privado.** Torná-lo público publica os arquivos.
2. **O instalador não sai daqui.** Nada de GitHub Release público, nada de
   mandar o `.exe` para fora do grupo de amigos da allowlist.
3. **A instância fica fechada** — allowlist e convite, como já é hoje.

O caminho de volta existe e é curto, e foi construído justamente para que esta
decisão seja reversível em minutos: `pnpm --filter @danjocord/client sounds --all`
regenera os 14 sons sintetizados (`apps/client/scripts/gen-sounds.mjs`, código
deste repositório, sem licença de ninguém), e aí bastam trocar as extensões no
`catalog.ts`/`assets.ts` e rodar o medidor. **Faça isso ANTES de qualquer coisa
que seja distribuição.** O `.github/workflows/desktop-release.yml` tem uma trava
que reprova o build de release enquanto houver `.mp3` no catálogo — ela existe
para que este parágrafo não dependa de alguém lembrar dele.

---

## Regras do projeto para assets

- **Só CC0 para o que é redistribuído.** É a única licença que sobrevive a um
  app empacotado e copiado para a máquina de outra pessoa sem ninguém precisar
  ler contrato — inclusive quem fizer fork.
- **CC-BY-NC é proibido.** "NC" = non-commercial, e o limite do que conta como
  comercial é indefinido o bastante para não valer a discussão.
- **Pixabay, Mixkit e ZapSplat estão fora**, mesmo com clipes gratuitos: as três
  licenças proíbem redistribuir o arquivo *sem modificação significativa* — que
  é precisamente o que um instalador faz ao copiar o arquivo para o disco do
  usuário.
- **Os sons do Discord são a exceção consciente**, tomada pelo Leonardo para
  esta instância privada. As brand guidelines deles vedam o reuso de "sounds",
  com essa palavra na cláusula — o que a regra proíbe é justamente **espalhar**,
  e é por isso que a exceção vem amarrada aos três limites do topo. Não é
  "descobriram que podia": é uma escolha registrada, com o custo escrito ao
  lado e o desfazer pronto.
- Asset novo → uma linha nova neste arquivo, no mesmo commit.

## Sons de interface — 12 do Discord (M12)

Em `apps/client/assets/sounds/`, **byte a byte como o Discord serve** (o md5 de
cada arquivo é o próprio hash da URL de origem — é assim que o CDN deles nomeia
os assets, e é o que torna a procedência verificável).

- **Origem**: `https://discordapp.com/assets/<hash>.mp3`
- **Licença**: proprietária, do Discord. **Não redistribuível.**
- **Baixados em**: 20/08/2026
- **Formato**: MP3, 48 kHz estéreo, exatamente como baixados — sem reencode,
  sem corte, sem normalização (o nivelamento é ganho no playback, § seguinte)

| Nome no Danjocord | Arquivo no repo      | Nome no Discord     | Hash de origem (= md5 do arquivo) |
| ----------------- | -------------------- | ------------------- | --------------------------------- |
| `voice-join`      | `voice-join.mp3`     | User Join           | `5dd43c946894005258d85770f0d10cff` |
| `voice-leave`     | `voice-leave.mp3`    | User Leave          | `4fcfeb2cba26459c4750e60f626cebdc` |
| `message`         | `message.mp3`        | Message             | `dd920c06a01e5bb8b09678581e29d56f` |
| `mention`         | `mention.mp3`        | Audio device changed / mention3 | `84c9fa3d07da865278bd77c97d952db4` |
| `self-mute`       | `self-mute.mp3`      | Mute                | `429d09ee3b86e81a75b5e06d3fb482be` |
| `self-unmute`     | `self-unmute.mp3`    | Unmute              | `43805b9dd757ac4f6b9b58c1a8ee5f0d` |
| `self-deafen`     | `self-deafen.mp3`    | Deafen              | `e4d539271704b87764dc465b1a061abd` |
| `self-undeafen`   | `self-undeafen.mp3`  | Undeafen            | `5a000a0d4dff083d12a1d4fc2c7cbf66` |
| `ptt-on`          | `ptt-on.mp3`         | PTT Activate        | `8b63833c8d252fedba6b9c4f2517c705` |
| `ptt-off`         | `ptt-off.mp3`        | PTT Deactivate      | `74ab980d6890a0fa6aa0336182f9f620` |
| `disconnected`    | `disconnected.mp3`   | Voice Disconnected  | `7e125dc075ec6e5ae796e4c3ab83abb3` |
| `reconnected`     | `reconnected.mp3`    | User Moved          | `e81d11590762728c1b811eadfa5be766` |

Duas escolhas de mapeamento que não são óbvias:

- **`mention` ← "Audio device changed / mention3"**: o nome duplo é do próprio
  Discord, que reusa o clipe nos dois lugares. É o som de menção deles.
- **`reconnected` ← "User Moved"**: a lista traz "Voice Disconnected" mas
  **não** traz o par de reconexão. "User Moved" é o que mais se aproxima —
  transição de estado de voz, ascendente, mesma família tímbrica do
  disconnected. Se soar errado no uso, é o primeiro candidato a virar
  sintetizado.

## Sons de interface — 2 sintetizados (M12)

`stream-start.wav` e `error.wav` são saída de
[`apps/client/scripts/gen-sounds.mjs`](apps/client/scripts/gen-sounds.mjs) —
código deste repositório, **sem licença de terceiro**.

Eles existem porque a lista de origem **não tem** equivalente: não há som de
"alguém começou a transmitir" nem de erro entre os arquivos do Discord
disponíveis. O que sobrava eram toques de chamada (5,3 s e 22,7 s) e navegação
de menu de atalhos (1,3 s) — nenhum serve para um evento de 400 ms.

O gerador guarda receita para os **14**, não só para estes dois: é o conjunto
completo que existia antes da troca, e é o caminho de volta da advertência do
topo. O `sound-assets.test.ts` reprova se alguma receita sumir.

## Sons do soundboard (M9) — CC0 da Kenney

Os 9 clipes de `apps/server/assets/soundboard/*.ogg` são **seed** da tabela
`sounds`, não catálogo: entram no banco no primeiro boot e a partir daí a fonte
da verdade é o banco.

- **Autor**: Kenney (Kenney Vleugels — <https://kenney.nl>)
- **Licença**: CC0 1.0 Universal — <https://creativecommons.org/publicdomain/zero/1.0/>
- **Arquivos**: `fanfarra`, `deu-ruim`, `buzina`, `cristal`, `scratch`, `hein`,
  `subiu`, `caiu`, `ping` (entram no repo exatamente como saíram do pack)

O mapeamento arquivo-do-repo → arquivo-de-origem **não foi registrado** no M9 e
não vai ser inventado agora: pack e licença estão identificados, que é o que
responde à pergunta de licença. Asset novo não repete esse buraco.

---

## Como trocar um som de interface

O nivelamento **não está nos arquivos** — é um ganho por som aplicado no
`GainNode` na hora de tocar (`apps/client/src/sound/catalog.ts`). Isso mantém os
arquivos intactos e deixa o nivelamento auditável como dado. O preço é que
trocar um som é trocar o arquivo **e** recalcular o número:

1. ponha o arquivo em `apps/client/assets/sounds/`, **mantendo o nome** do
   catálogo (`assets.ts` importa cada um estaticamente — é assim que o Vite os
   enxerga e copia para o bundle). Extensão nova? Atualize `catalog.ts` e
   `assets.ts` juntos;
2. `pnpm --filter @danjocord/client sounds:measure` — decodifica no Chromium do
   Electron, escreve `assets/sounds/measured.json` e imprime o ganho;
3. copie o ganho para o `CATALOG` do `catalog.ts`;
4. `pnpm --filter @danjocord/client test` — o `sound-assets.test.ts` confere o
   sha256 de cada arquivo contra a medição e o ganho do catálogo contra ela.
   O passo 3 deixou de ser esquecível.

O alvo é **RMS de ~-20 dBFS** (som de UI tem que ficar **abaixo** da voz da
chamada) com **teto de pico em 0.89** (margem para o `linearRamp` do envelope no
`player.ts` e para a soma com a voz sem clipar):

```
gain = min(0.1 / rms_ativo, 0.89 / pico) × 10^(quieterDb / 20)
        └── alvo -20 dBFS ─┘  └─ teto ─┘   └── intenção declarada ──┘
```

Duas sutilezas que a troca pelos arquivos do Discord obrigou a acertar:

- **`rms_ativo` é medido só na região acima de -60 dBFS**, não no arquivo
  inteiro. Os clipes do Discord trazem silêncio nas pontas (o `disconnected` tem
  1216 ms de arquivo para 911 ms de som); RMS do arquivo todo contaria esse
  silêncio, o número desceria e o ganho subiria **para compensar um silêncio** —
  o clipe tocaria acima do alvo justamente por ter cauda vazia. O **pico** segue
  sendo do arquivo inteiro: ele é sobre não clipar, e pico fora da região ativa
  clipa igual.
- **`quieterDb`** (em `scripts/measure-sounds.mjs`) é a única porta por onde
  gosto entra no ganho. Está vazio hoje.

Ganho maior que 1.0 não é erro — quer dizer só que o clipe é mais frio que o
alvo. Metade dos do Discord está aí.

---

## Marca do Danjomar (M13) — brasão e ícone do app

**Não é asset de terceiro.** É a logo do próprio time, trazida do site
(`E:/Work/DanjomarFront/public/logo.png`) por decisão do Leonardo. Fica aqui
porque a pergunta "de onde veio este arquivo" é a mesma, e porque a resposta
importa se algum dia este repositório for aberto ou o instalador sair do grupo.

| arquivo | o que é |
|---|---|
| `apps/client/assets/brand/danjomar-logo-fonte.png` | a origem, 1048×944 RGBA. **Não entra no bundle**: nada em `src/` a importa. Existe para o gerador e para o teste. |
| `apps/client/src/ui/brasao-path.ts` | **gerado** — o path SVG (726 B) que a UI desenha |
| `apps/desktop/assets/icon.png` | **gerado** — 512×512, o ícone da janela, da bandeja e do instalador |

Os dois gerados saem de `apps/client/scripts/trace-logo.mjs`, do MESMO arquivo
de origem, e o `test/brand-asset.test.ts` reprova se a origem mudar sem alguém
regerar (sha256, igual ao que o `sound-assets.test.ts` faz com os clipes).

Refazer, depois de trocar o PNG de origem:

```bash
node scripts/trace-logo.mjs   # de apps/client
```

O antigo `apps/desktop/assets/icon.png` (quadrado azul com barras de
equalizador, 1332 B) não tinha procedência registrada e foi substituído.

## Orbitron — a fonte de display (M13)

- **Fonte**: Google Fonts, subset latin, peso variável 400..900 — o arquivo é
  `apps/client/assets/fonts/orbitron-latin.woff2` (11.800 B).
- **Autor**: Matt McInerney.
- **Licença**: SIL Open Font License 1.1.

A OFL permite empacotar e redistribuir a fonte com o aplicativo, inclusive
comercialmente, e **não** contamina o resto do projeto. As duas condições que
valem para nós: a fonte não pode ser vendida por si só, e um arquivo modificado
não pode manter o nome "Orbitron" (não modificamos — o arquivo é o que o
Google serve).

É a mesma fonte do site do time, e por isso ela está aqui.

**Ela é EMPACOTADA, e isso não é preferência.** O site faz
`@import url('https://fonts.googleapis.com/…')`; aqui isso não funcionaria:
nenhuma das três CSPs do projeto declara `font-src`, então todas herdam
`default-src 'self'` e host externo é barrado. No desktop seria pior — o app
roda offline, servido pelo scheme `app://`.
