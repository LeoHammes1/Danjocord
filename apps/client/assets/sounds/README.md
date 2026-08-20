# Sons de interface

14 clipes, de duas origens — e a distinção importa:

- **12 `.mp3` são assets proprietários do Discord.** Estão aqui por decisão
  explícita do Leonardo, para esta instância privada. **Leia a advertência no
  topo do [ATTRIBUTIONS.md](../../../../ATTRIBUTIONS.md) antes de tornar o repo
  público ou gerar instalador.**
- **2 `.wav` são sintetizados** por
  [`../../scripts/gen-sounds.mjs`](../../scripts/gen-sounds.mjs) — código deste
  repositório, sem licença de ninguém. Cobrem os dois eventos que a fonte não
  tem: Go Live e erro.

**Não edite estes arquivos nem os renomeie.** Os nomes são o contrato com
`src/sound/catalog.ts` e `src/sound/assets.ts` (um `import` estático por
arquivo — é assim que o Vite os copia para o bundle).

`measured.json` é gerado, não escrito à mão:

```bash
pnpm --filter @danjocord/client sounds:measure
```

Ele decodifica cada arquivo no Chromium do Electron (o Node não lê .mp3) e
registra sha256, RMS, pico e o **ganho** de cada um. Trocou um som? Rode o
medidor, copie o ganho para o `catalog.ts` e rode os testes — o
`test/sound-assets.test.ts` confere o sha256 e reprova se você esquecer.

O passo a passo completo e a conta do ganho estão no `ATTRIBUTIONS.md`; as
decisões, em [`docs/som.md`](../../../../docs/som.md).
