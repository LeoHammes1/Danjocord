/**
 * Avatar — o ÚNICO lugar do cliente que desenha a bolinha de uma pessoa.
 *
 * Até o M6 havia três tratamentos diferentes para a mesma coisa: o renderMe()
 * escondia a <img> quando avatar_url era null (o painel ficava sem nada), o
 * voiceUserEl() desenhava um círculo com a inicial e a lista de membros não
 * tinha avatar nenhum. Como sidebar, membros e mensagens desenham o mesmo
 * círculo em tamanhos diferentes, ele virou um módulo só — MÓDULO
 * COMPARTILHADO: os estilos vivem em styles/members.css (parte 1 do arquivo).
 *
 * Duas decisões que não são óbvias:
 *
 * 1. `avatar_url` aponta para o CDN do Discord e caduca — quem troca de foto
 *    deixa a URL antiga em 404. Sem o `onerror` isso viraria um quadrado
 *    quebrado permanente na lista; com ele, a imagem morta cai para o mesmo
 *    fallback de quem nunca teve foto.
 *
 * 2. A cor do fallback é DERIVADA do id, não sorteada nem guardada: a mesma
 *    pessoa tem sempre a mesma cor, em qualquer sessão e em qualquer máquina,
 *    sem nenhum estado persistido. É por isso que `avatarColor` é exportada —
 *    o nome do autor na mensagem usa exatamente a mesma cor.
 */
import { displayName, type PresenceStatus } from "@danjocord/protocol";
import type { User } from "./context.js";

/**
 * O avatar não precisa do usuário inteiro — só do que ele desenha. O
 * `nickname` é OPCIONAL (e não `Pick<User, "nickname">`) porque metade dos
 * chamadores desenha um placeholder montado à mão, de quem só se sabe o id:
 * exigir o campo obrigaria todos eles a escrever `nickname: null` sem motivo.
 */
type AvatarUser = Pick<User, "id" | "username" | "avatar_url"> & Partial<Pick<User, "nickname">>;

/**
 * Presença desenhada como bolinha recortada; ausente = sem bolinha.
 *
 * M10 (item 56): eram dois valores (o booleano `online`), agora são os quatro
 * do protocolo. O alias continua existindo porque quem desenha um avatar não
 * precisa saber que a fonte é o `PresenceStatus` do gateway — e porque
 * `avatarEl(user, 32, "online")` de antes segue válido, palavra por palavra.
 */
export type PresenceKind = PresenceStatus;

/**
 * Quantas cores a paleta do fallback tem. Os valores em si são
 * `--av-c0`…`--av-c5` no members.css: cor literal não entra em JS pelo mesmo
 * motivo que não entra em CSS de componente — o tema tem uma fonte só.
 */
const PALETTE_SIZE = 6;

/**
 * Cor determinística da pessoa. Hash multiplicativo (31, o mesmo do
 * String.hashCode do Java) — não precisa ser criptográfico, precisa ser
 * estável e espalhar bem ids que só diferem nos últimos dígitos, que é
 * exatamente o caso dos snowflakes.
 */
export function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return `var(--av-c${Math.abs(h) % PALETTE_SIZE})`;
}

/**
 * Monta o avatar. Devolve SEMPRE um invólucro (e não a <img> direto) porque a
 * bolinha de presença precisa de um pai posicionado — e uma API que às vezes
 * devolve <img> e às vezes <span> obriga todo chamador a saber a diferença.
 *
 * `size` é o diâmetro em px; ele vira `--avatar-size`, a variável que o
 * .avatar do base.css lê (o CDN do Discord entrega 1024px se ninguém mandar).
 */
export function avatarEl(user: AvatarUser, size: number, presence?: PresenceKind): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = presence === undefined ? "av" : "av av-cut";
  wrap.style.setProperty("--avatar-size", `${size}px`);
  wrap.style.setProperty("--av", avatarColor(user.id));
  wrap.append(user.avatar_url === null ? initialEl(user) : imgEl(user, user.avatar_url));

  if (presence !== undefined) {
    // aria-hidden: quem diz "online" para o leitor de tela é o cabeçalho da
    // seção (ou o contexto de quem chama), nunca um pixel colorido
    const dot = document.createElement("span");
    dot.className = `av-dot av-${presence}`;
    dot.setAttribute("aria-hidden", "true");
    wrap.append(dot);
  }
  return wrap;
}

function imgEl(user: AvatarUser, url: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "avatar";
  img.alt = ""; // decorativo: o nome da pessoa está sempre ao lado
  img.loading = "lazy";
  // handler ANTES do src: uma imagem já em cache pode falhar de forma
  // síncrona, e aí o onerror atribuído depois nunca rodaria
  img.onerror = () => {
    img.replaceWith(initialEl(user));
  };
  img.src = url;
  return img;
}

/** Fallback: círculo tingido com a inicial. A cor vem do `--av` do invólucro. */
function initialEl(user: AvatarUser): HTMLElement {
  const span = document.createElement("span");
  span.className = "avatar av-initial";
  span.setAttribute("aria-hidden", "true");
  // a inicial é a do nome EXIBIDO (item 55): com apelido, o círculo do "Zé"
  // mostrando "L" de "leonardo" seria a única peça da tela discordando do resto
  span.textContent = displayName({ username: user.username, nickname: user.nickname ?? null }).trim().charAt(0).toUpperCase() || "?";
  return span;
}
