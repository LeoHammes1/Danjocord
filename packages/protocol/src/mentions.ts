/**
 * Parser de menções (M11a, item 79) — PURO e COMPARTILHADO.
 *
 * Mora no protocolo, e não no servidor, porque os dois lados precisam da MESMA
 * resposta para perguntas diferentes:
 *
 *   - o servidor resolve no POST para poder CONTAR ("quantas mensagens não
 *     lidas me mencionam?" tem que ser uma query, não uma varredura de texto);
 *   - o cliente resolve na hora de pintar a pílula no texto.
 *
 * Duas implementações divergiriam no primeiro nome com ponto — e a divergência
 * aqui é do pior tipo: a pessoa VÊ a menção destacada e não recebe notificação
 * nenhuma (ou o contrário). Uma função só, testada uma vez.
 *
 * O que fica gravado na mensagem continua sendo o texto que a pessoa digitou —
 * nada de `<@id>` no conteúdo. Quem resolve o nome na tela é o cliente (apelido
 * muda, e mensagem antiga não pode ficar mostrando o nome velho); o servidor
 * guarda só o RESULTADO (ids), que é o que dá para contar.
 */

/** Membro contra o qual o texto é casado: os dois nomes valem (item 55). */
export interface MentionCandidate {
  id: string;
  username: string;
  nickname: string | null;
}

export interface ParsedMentions {
  /** ids na ordem da PRIMEIRA aparição, sem repetição */
  userIds: string[];
  /** `@todos` apareceu fora de bloco de código */
  everyone: boolean;
}

/**
 * A palavra que menciona a guild inteira. É uma só, e em português: aceitar
 * também "@everyone" seria um segundo nome para a mesma coisa, e aí metade das
 * mensagens usaria um e metade o outro — e alguém acabaria descobrindo que só
 * um dos dois notifica.
 */
export const EVERYONE_KEYWORD = "todos";

/**
 * Caractere que pode fazer parte de um nome. `.`, `_` e `-` entram porque
 * username do Discord os aceita — e é exatamente por isso que `\b` do regex NÃO
 * serve de borda: para o regex, `.` e `-` já são fronteira, então "@leo" casaria
 * dentro de "@leo.silva".
 */
const NAME_CHAR = /[\p{L}\p{N}_]/u;

/** Pontuação que um nome pode CONTER mas nunca termina de fato. Ver `borderAfter`. */
const TRAILING = new Set([".", "-"]);

function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && (NAME_CHAR.test(ch) || ch === "." || ch === "-");
}

/**
 * O que vem ANTES do `@` permite começar uma menção? Só o início do texto ou um
 * caractere que não é de nome — senão "contato@leo" viraria menção ao leo, e
 * todo endereço de e-mail notificaria alguém.
 */
function borderBefore(content: string, at: number): boolean {
  return at === 0 || !isNameChar(content[at - 1]);
}

/**
 * O que vem DEPOIS do nome casado encerra a menção?
 *
 * A regra óbvia — "o próximo caractere não é de nome" — resolve o caso que dá
 * nome a esta função: com os membros `leo` e `leonardo`, "@leonardo" não pode
 * mencionar o leo. Mas ela sozinha quebra o caso mais comum de todos: "@leo."
 * no fim de uma frase não mencionaria ninguém, porque `.` é caractere de nome.
 *
 * Então a borda aceita pontuação FINAL: pula os `.`/`-` que vierem em seguida e
 * exige que depois deles não venha letra ou dígito. "@leo." casa; "@leo.silva"
 * (quando `leo.silva` não é membro) não casa — e quando é, o casamento mais
 * longo já venceu antes de chegar aqui.
 */
function borderAfter(content: string, end: number): boolean {
  let i = end;
  while (i < content.length && TRAILING.has(content[i] as string)) i += 1;
  return !isNameChar(content[i]);
}

/**
 * Trechos de código do texto: crase tripla (bloco) e crase simples (inline).
 * Menção dentro deles NÃO conta — quem cola um comando com "@todos" no meio não
 * está chamando a guild inteira.
 *
 * Delimitador não fechado é texto literal, e não "código até o fim": uma crase
 * solta é acidente comum de digitação, e engolir o resto da mensagem por causa
 * dela silenciaria menções de verdade. Mesma decisão do Markdown do item 78 —
 * quando ele chegar, o realce e a menção vão concordar por construção.
 */
function codeRanges(content: string): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < content.length) {
    if (content.startsWith("```", i)) {
      const close = content.indexOf("```", i + 3);
      if (close === -1) break; // fence aberta: o resto é texto comum
      ranges.push([i, close + 3]);
      i = close + 3;
    } else if (content[i] === "`") {
      const close = content.indexOf("`", i + 1);
      if (close === -1) {
        i += 1; // crase solta: literal
        continue;
      }
      ranges.push([i, close + 1]);
      i = close + 1;
    } else {
      i += 1;
    }
  }
  return ranges;
}

/** Candidato normalizado; `userId` null = a palavra-chave de `@todos`. */
interface Key {
  key: string;
  userId: string | null;
}

/**
 * Casa `@nome` contra os membros. Regras (as mesmas nos dois lados):
 *
 *   - borda explícita antes e depois (ver `borderBefore`/`borderAfter`);
 *   - casamento MAIS LONGO primeiro — sem isso `@leo` engoliria `@leonardo`, e
 *     o dono do nome curto levaria as notificações do dono do nome longo;
 *   - vale contra `nickname` E `username` (item 55): quem só conhece o apelido
 *     não pode falhar em mencionar, e quem só conhece o nome do Discord também
 *     não;
 *   - sem distinção de maiúsculas (ninguém digita apelido com a caixa certa);
 *   - nada dentro de bloco/trecho de código.
 */
export function parseMentions(content: string, membros: MentionCandidate[]): ParsedMentions {
  const keys: Key[] = [{ key: EVERYONE_KEYWORD, userId: null }];
  for (const m of membros) {
    keys.push({ key: m.username.toLowerCase(), userId: m.id });
    if (m.nickname !== null && m.nickname.trim() !== "") keys.push({ key: m.nickname.toLowerCase(), userId: m.id });
  }
  // mais longo primeiro; empate → usuário na frente da palavra-chave, para que
  // um membro que se chame literalmente "todos" seja mencionado como pessoa
  keys.sort((a, b) => b.key.length - a.key.length || (a.userId === null ? 1 : -1));

  const lower = content.toLowerCase();
  const ranges = codeRanges(content);
  const inCode = (at: number): boolean => ranges.some(([start, end]) => at >= start && at < end);

  const userIds: string[] = [];
  let everyone = false;

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "@" || !borderBefore(content, i) || inCode(i)) continue;
    const from = i + 1;
    for (const { key, userId } of keys) {
      if (key.length === 0 || !lower.startsWith(key, from)) continue;
      if (!borderAfter(content, from + key.length)) continue;
      if (userId === null) everyone = true;
      else if (!userIds.includes(userId)) userIds.push(userId);
      // pula o nome casado: o `@` de dentro de um apelido com arroba não
      // pode abrir uma segunda menção no meio da primeira
      i = from + key.length - 1;
      break;
    }
  }

  return { userIds, everyone };
}
