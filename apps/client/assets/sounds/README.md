# Sons de interface (M8)

14 clipes CC0 da Kenney. **Não reencode, não renomeie**: os nomes são o contrato
com `src/sound/catalog.ts` e `src/sound/assets.ts` (um `import` estático por
arquivo — é assim que o Vite os copia para o bundle).

O nivelamento não está nos arquivos: é um ganho por som, aplicado no playback.
Trocar um clipe exige **recalcular esse ganho**.

Procedência, licenças e o passo a passo da troca (com o trecho de código que
mede RMS/pico e devolve o ganho) estão em `ATTRIBUTIONS.md`, na raiz do repo.
