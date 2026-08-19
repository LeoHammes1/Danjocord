import type { Message, MessageType } from "@danjocord/protocol";
import type { Gateway } from "./gateway.js";
import type { Store } from "./store.js";

/**
 * Mensagens de sistema (M11a, item 92): "fulano entrou", "fulano saiu".
 *
 * São o rastro que faz o servidor parecer vivo — e são o que responde "quem é
 * essa pessoa que apareceu na lista?" seis meses depois, quando ninguém lembra
 * do convite. Entram na tabela `messages` como qualquer outra: é isso que as
 * faz aparecer na paginação, no histórico e no replay do Resume sem uma única
 * linha de código especial nos dois lados.
 *
 * Três decisões que valem a pena estar escritas:
 *
 *   - O AUTOR é o sujeito do evento (quem entrou/saiu), não um usuário-robô: o
 *     cliente já sabe desenhar avatar e nome a partir do author_id, e um autor
 *     falso exigiria um membro fantasma na lista de todo mundo.
 *   - O CONTEÚDO é vazio. A frase é montada na tela porque o nome exibido muda
 *     quando a pessoa troca de apelido (item 55) — texto gravado envelheceria
 *     dentro do histórico, e o histórico é para sempre.
 *   - Vai para o primeiro canal de texto, e só. Espalhar o mesmo aviso por
 *     todos os canais seria N badges para um evento só.
 */
export function announce(store: Store, gateway: Gateway, type: MessageType, userId: string): Message | null {
  // "user" não é anúncio: quem cria mensagem normal é o POST do dono dela
  if (type === "user") return null;
  const channelId = store.defaultTextChannelId();
  if (channelId === null) return null;

  // conteúdo vazio de propósito (ver acima) e sem menção nenhuma: um aviso do
  // servidor não pode acender a badge de menção de quem quer que seja
  const message = store.createMessage(channelId, userId, "", { type });
  gateway.broadcast("MESSAGE_CREATE", message);
  return message;
}
