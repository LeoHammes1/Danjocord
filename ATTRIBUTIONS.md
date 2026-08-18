# Atribuições — assets de terceiros

Todo asset de terceiro que entra no Danjocord é registrado aqui.

**Por que este arquivo existe.** Os 14 clipes de som são CC0, e CC0 **não exige**
atribuição — nada aqui é obrigação legal. O arquivo existe por dois motivos
práticos: registrar **procedência** (daqui a um ano ninguém lembra de onde veio
`self-deafen.ogg`, e "de onde veio" é exatamente a pergunta que aparece quando
alguém questiona a licença), e ter o lugar pronto para o dia em que entrar um
asset **CC-BY** — que exige crédito e sem este arquivo viraria uma linha solta
num README qualquer.

## Regras do projeto para assets

- **Só CC0.** É a única licença que sobrevive a um app empacotado e
  redistribuído sem que ninguém precise ler contrato.
- **CC-BY-NC é proibido.** "NC" = non-commercial, e o limite do que conta como
  comercial é indefinido o bastante para não valer a discussão.
- **Pixabay, Mixkit e ZapSplat estão fora**, mesmo com clipes gratuitos: as três
  licenças proíbem redistribuir o arquivo *sem modificação significativa* — que
  é precisamente o que um instalador faz ao copiar o `.ogg` para o disco do
  usuário.
- **Nenhum som do Discord pode ser reusado.** As brand guidelines deles vedam
  explicitamente o reuso de "sounds"; o clone é didático, a semelhança para no
  comportamento.
- Asset novo → uma linha nova nesta tabela, no mesmo commit.

## Sons de interface (M8)

Todos os 14 arquivos em `apps/client/assets/sounds/`. Ogg Vorbis, entram no
repositório **exatamente como saíram do pack** — sem reencode, sem corte, sem
normalização destrutiva (o nivelamento é um ganho aplicado no playback; veja a
seção seguinte).

- **Autor**: Kenney (Kenney Vleugels — <https://kenney.nl>)
- **Licença**: CC0 1.0 Universal — <https://creativecommons.org/publicdomain/zero/1.0/>
- **Baixado em**: 18/08/2026

| Nome no Danjocord | Arquivo no repo     | Arquivo de origem | Pack de origem                                   |
| ----------------- | ------------------- | ----------------- | ------------------------------------------------ |
| `voice-join`      | `voice-join.ogg`    | `maximize_002`    | [Interface Sounds](https://kenney.nl/assets/interface-sounds) |
| `voice-leave`     | `voice-leave.ogg`   | `minimize_002`    | [Interface Sounds](https://kenney.nl/assets/interface-sounds) |
| `stream-start`    | `stream-start.ogg`  | `maximize_004`    | [Interface Sounds](https://kenney.nl/assets/interface-sounds) |
| `message`         | `message.ogg`       | `pluck_001`       | [Interface Sounds](https://kenney.nl/assets/interface-sounds) |
| `mention`         | `mention.ogg`       | `question_003`    | [Interface Sounds](https://kenney.nl/assets/interface-sounds) |
| `self-mute`       | `self-mute.ogg`     | `toggle_003`      | [Interface Sounds](https://kenney.nl/assets/interface-sounds) |
| `self-unmute`     | `self-unmute.ogg`   | `toggle_002`      | [Interface Sounds](https://kenney.nl/assets/interface-sounds) |
| `self-deafen`     | `self-deafen.ogg`   | `close_002`       | [Interface Sounds](https://kenney.nl/assets/interface-sounds) |
| `self-undeafen`   | `self-undeafen.ogg` | `open_002`        | [Interface Sounds](https://kenney.nl/assets/interface-sounds) |
| `disconnected`    | `disconnected.ogg`  | `error_003`       | [Interface Sounds](https://kenney.nl/assets/interface-sounds) |
| `reconnected`     | `reconnected.ogg`   | `open_004`        | [Interface Sounds](https://kenney.nl/assets/interface-sounds) |
| `error`           | `error.ogg`         | `error_002`       | [Interface Sounds](https://kenney.nl/assets/interface-sounds) |
| `ptt-on`          | `ptt-on.ogg`        | `mouseclick1`     | [UI Audio](https://kenney.nl/assets/ui-audio)                 |
| `ptt-off`         | `ptt-off.ogg`       | `mouserelease1`   | [UI Audio](https://kenney.nl/assets/ui-audio)                 |

Os pares não são coincidência: `maximize`/`minimize` e `open`/`close` são
**espelhados pela própria Kenney** — o segundo é o primeiro ao contrário, e é
daí que sai a semântica de entrar/sair e de ensurdecer/voltar-a-ouvir sem que
ninguém precise aprender o som.

## Como trocar um som

O nivelamento dos clipes **não está nos arquivos** — é um ganho por som,
aplicado no `GainNode` na hora de tocar (`apps/client/src/sound/catalog.ts`).
Isso mantém os `.ogg` intactos, deixa o nivelamento auditável como dado, e
significa que trocar um som é trocar o arquivo **e recalcular o número**.

1. Substitua o `.ogg` em `apps/client/assets/sounds/`, **mantendo o nome**
   (o `assets.ts` importa cada arquivo estaticamente — é assim que o Vite
   enxerga a dependência e a copia para o bundle).
2. Meça o novo clipe com o trecho abaixo e anote o `ganho`.
3. Ponha o valor em `CATALOG` no `catalog.ts`, no campo `gain` daquele som.
4. Acrescente a linha na tabela acima: origem, autor, licença, data. Licença
   diferente de CC0 → veja as regras do projeto antes.

O alvo é **RMS de ~-20 dBFS** (som de UI tem que ficar **abaixo** da voz da
chamada — se ele competir com a pessoa falando, está alto demais) com **teto de
pico em 0.89** (margem para o `linearRamp` do envelope e para a soma com a voz
sem clipar na saída). Quando o teto de pico ganha, o clipe fica *de propósito*
mais baixo que o alvo — é o caso de `message`, `ptt-on`, `ptt-off` e
`disconnected` hoje. Ganho maior que 1.0 não é erro: quer dizer só que o clipe
original é baixo.

Cole no console do navegador com o cliente aberto (`pnpm dev`; em dev o Vite
serve `apps/client/assets/` direto na raiz). Foi assim que os 14 atuais foram
calibrados — por medição, não pelo nome do arquivo:

```js
// mede um clipe e devolve o ganho de playback
async function medir(url) {
  const ctx = new AudioContext();
  const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
  let soma = 0, pico = 0, n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      soma += v * v;
      if (Math.abs(v) > pico) pico = Math.abs(v);
      n++;
    }
  }
  await ctx.close();
  const rms = Math.sqrt(soma / n);
  const porRms = 0.1 / rms;   // 0.1 = -20 dBFS, o alvo
  const porPico = 0.89 / pico; // teto de pico
  return {
    arquivo: url.split("/").pop(),
    duracao: +buf.duration.toFixed(3),
    rms: +rms.toFixed(4),
    pico: +pico.toFixed(3),
    // qual dos dois limitou: "rms" é o caso normal, "pico" é o clipe que não
    // chega a -20 dBFS sem clipar
    limitado_por: porRms <= porPico ? "rms" : "pico",
    ganho: +Math.min(porRms, porPico).toFixed(3),
  };
}

// um arquivo:
console.table([await medir("/assets/sounds/message.ogg")]);

// a bateria inteira, para comparar (útil quando se troca um som só e quer-se
// ver se ele destoa dos vizinhos):
const nomes = ["voice-join","voice-leave","stream-start","message","mention",
  "self-mute","self-unmute","self-deafen","self-undeafen","ptt-on","ptt-off",
  "disconnected","reconnected","error"];
console.table(await Promise.all(nomes.map((n) => medir(`/assets/sounds/${n}.ogg`))));
```

Um detalhe que já mordeu: **não deixe um clipe cair abaixo de 4 KB sem olhar o
`vite.config.ts`**. O default do Vite embutiria o arquivo como `data:` URI, e
`data:` é barrado pelas CSPs do projeto (`media-src`/`connect-src`, tanto no
`<meta>` do `index.html` quanto no header do servidor) — o som sumiria só em
produção. O `assetsInlineLimit` de lá já protege contra isso; o comentário no
arquivo explica por quê, e é para ficar.
