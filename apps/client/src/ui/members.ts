/**
 * Coluna de membros (M7). Substitui o renderMembers() do main.ts, que era um
 * <ul> de <li> com o username em texto puro rolando junto com os canais.
 *
 * Duas seções, "Online — N" e "Offline — N", como no Discord. A ordenação é
 * ALFABÉTICA de propósito: o `state.members` é um Map alimentado pelo READY e
 * pelos MEMBER_ADD, então a ordem de inserção muda a cada reconexão — a lista
 * "embaralhava" sozinha sem ninguém ter entrado ou saído.
 *
 * Re-render total (replaceChildren) a cada chamada, e não diff: renderMembers
 * roda em todo PRESENCE_UPDATE, mas o teto do projeto é 10 pessoas — são ~50
 * nós. O único efeito colateral real do re-render é o foco de teclado, que
 * este módulo devolve na mão (ver focusedMemberId/restoreFocus).
 */
import { avatarEl, type PresenceKind } from "./avatar.js";
import type { UiContext, User } from "./context.js";

/**
 * O nó é resolvido uma vez: o main.ts importa este módulo depois do parse do
 * documento (script type="module" no fim do body), então o #members já existe.
 */
const root = document.getElementById("members")!;

/**
 * Desenha a coluna inteira. `onSelectMember` é OPCIONAL porque o card de
 * perfil é o item 48 do ROADMAP (M10): sem handler a linha nasce `disabled` —
 * um botão que não faz nada mas parece clicável é pior que um desabilitado.
 */
export function renderMembers(ctx: UiContext, onSelectMember?: (userId: string) => void): void {
  const { members, online } = ctx.state;
  const all = [...members.values()].sort(byName);
  const on = all.filter((m) => online.has(m.id));
  const off = all.filter((m) => !online.has(m.id));

  const focused = focusedMemberId();
  const nodes: HTMLElement[] = [headEl(all.length)];
  if (all.length === 0) nodes.push(emptyEl());
  if (on.length > 0) nodes.push(sectionEl("Online", on, "online", onSelectMember));
  if (off.length > 0) nodes.push(sectionEl("Offline", off, "offline", onSelectMember));
  root.replaceChildren(...nodes);
  restoreFocus(focused);
}

/** pt-BR + sensitivity "base": acento e caixa não mandam alguém para o fim. */
function byName(a: User, b: User): number {
  return a.username.localeCompare(b.username, "pt-BR", { sensitivity: "base" });
}

function headEl(total: number): HTMLElement {
  const h = document.createElement("h2");
  h.className = "members-head";
  h.textContent = `Membros — ${total}`;
  return h;
}

function emptyEl(): HTMLElement {
  const p = document.createElement("p");
  p.className = "members-empty";
  p.textContent = "ninguém por aqui ainda";
  return p;
}

function sectionEl(
  label: string,
  users: User[],
  presence: PresenceKind,
  onSelectMember?: (userId: string) => void,
): HTMLElement {
  const section = document.createElement("section");
  section.className = `member-group member-group-${presence}`;

  const title = `${label} — ${users.length}`;
  const head = document.createElement("h3");
  head.className = "member-group-head";
  head.textContent = title;

  const list = document.createElement("ul");
  list.className = "member-list";
  // a <ul> carrega o rótulo da seção: o leitor de tela anuncia "lista Online —
  // 3" ao entrar nela, sem depender de o usuário ter passado pelo <h3>
  list.setAttribute("aria-label", title);
  list.append(...users.map((u) => rowEl(u, presence, onSelectMember)));

  section.append(head, list);
  return section;
}

function rowEl(user: User, presence: PresenceKind, onSelectMember?: (userId: string) => void): HTMLElement {
  const li = document.createElement("li");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "member";
  btn.dataset["userId"] = user.id; // âncora do restoreFocus
  if (onSelectMember === undefined) btn.disabled = true;
  else btn.onclick = () => onSelectMember(user.id);

  btn.append(avatarEl(user, 32, presence));

  const name = document.createElement("span");
  name.className = "member-name";
  name.textContent = user.username;
  btn.append(name);

  // is_admin é opcional no protocolo (ausente = false) e só o servidor popula
  if (user.is_admin === true) {
    const badge = document.createElement("span");
    badge.className = "member-badge";
    badge.textContent = "admin";
    btn.append(badge);
  }

  li.append(btn);
  return li;
}

// --- foco -----------------------------------------------------------------
// O replaceChildren joga fora o elemento focado e o foco volta para o <body>:
// quem estava navegando a lista por Tab/setas era cuspido para o começo da
// página toda vez que alguém ficasse online. Guardar o id e refocar depois
// custa duas funções e resolve.

function focusedMemberId(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  return active.dataset["userId"] ?? null;
}

function restoreFocus(userId: string | null): void {
  if (userId === null) return;
  // CSS.escape: o id é um snowflake em string, e um seletor de atributo com
  // valor não escapado é uma porta aberta que não custa nada fechar
  const again = root.querySelector<HTMLButtonElement>(`.member[data-user-id="${CSS.escape(userId)}"]`);
  again?.focus();
}
