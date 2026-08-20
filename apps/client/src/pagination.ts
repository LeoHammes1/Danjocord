/**
 * A decisão de "pedir mais uma página agora" — pura, porque ela já foi um laço
 * infinito e um laço infinito não se vê lendo código, se vê num teste.
 *
 * O `maybeLoadOlder` termina com uma chamada a si mesmo, e a razão é boa: se o
 * viewport for mais alto que a página carregada, não existe rolagem para gerar
 * o próximo evento de scroll, e sem esta linha o histórico ficaria parado num
 * canal quase vazio numa janela grande.
 *
 * O que estava errado era a CONDIÇÃO. Ela olhava só "ainda estou perto do topo
 * e ainda há histórico" — e as duas continuam verdadeiras quando a tentativa
 * anterior NÃO trouxe nada para a tela:
 *
 *   1. o fetch falhou (429, 5xx, rede caiu). Nada é prependado, o `scrollTop`
 *      não se mexe — a linha rearmava na hora, sem backoff e sem teto. Uma
 *      requisição por RTT, para sempre, sem depender de evento nenhum. O
 *      comentário do `catch` dizia "sem retry automático"; a linha seguinte era
 *      o retry automático.
 *   2. a página veio inteira de gente bloqueada (item 54, filtro é local). O
 *      cursor `before` sai do DOM, o DOM não mudou, e a mesma página é pedida
 *      de novo — mesmo laço, sem erro nenhum acontecendo.
 *
 * A condição certa é PROGRESSO: só rearma se a última tentativa realmente pôs
 * mensagem na tela. Falhou ou veio vazia, para — e o próximo scroll de verdade
 * tenta de novo, que é o que o comentário sempre prometeu.
 */
export interface EstadoRearme {
  /** a view ainda é a mesma (não trocou de canal nem houve resync no meio) */
  mesmaView: boolean;
  /** o servidor já disse que não há mais histórico acima */
  reachedStart: boolean;
  scrollTop: number;
  topThreshold: number;
  /** a tentativa que acabou RENDERIZOU pelo menos uma mensagem */
  avancou: boolean;
}

export function deveRearmarPaginacao(e: EstadoRearme): boolean {
  return e.mesmaView && !e.reachedStart && e.avancou && e.scrollTop <= e.topThreshold;
}
