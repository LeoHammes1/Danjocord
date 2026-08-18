/**
 * URLs dos clipes (M8). Um `import` estático por som — feio, e de propósito:
 * é assim que o Vite ENXERGA a dependência, fingerprinta o arquivo e o copia
 * para o bundle (importante no desktop, onde o renderer é servido pelo scheme
 * `app://` a partir de renderer-dist). Um `import.meta.glob` ou uma URL
 * montada por string funcionaria no dev e sumiria no build.
 *
 * Este módulo existe SEPARADO do catálogo porque ele é o único que toca em
 * .ogg: assim `policy.ts` importa só dados e roda no Node, sob `node --test`.
 */
import { CATALOG, SOUND_NAMES, type SoundName } from "./catalog.js";

import disconnectedUrl from "../../assets/sounds/disconnected.ogg";
import errorUrl from "../../assets/sounds/error.ogg";
import mentionUrl from "../../assets/sounds/mention.ogg";
import messageUrl from "../../assets/sounds/message.ogg";
import pttOffUrl from "../../assets/sounds/ptt-off.ogg";
import pttOnUrl from "../../assets/sounds/ptt-on.ogg";
import reconnectedUrl from "../../assets/sounds/reconnected.ogg";
import selfDeafenUrl from "../../assets/sounds/self-deafen.ogg";
import selfMuteUrl from "../../assets/sounds/self-mute.ogg";
import selfUndeafenUrl from "../../assets/sounds/self-undeafen.ogg";
import selfUnmuteUrl from "../../assets/sounds/self-unmute.ogg";
import streamStartUrl from "../../assets/sounds/stream-start.ogg";
import voiceJoinUrl from "../../assets/sounds/voice-join.ogg";
import voiceLeaveUrl from "../../assets/sounds/voice-leave.ogg";

export const SOUND_URL: Record<SoundName, string> = {
  "voice-join": voiceJoinUrl,
  "voice-leave": voiceLeaveUrl,
  "stream-start": streamStartUrl,
  message: messageUrl,
  mention: mentionUrl,
  "self-mute": selfMuteUrl,
  "self-unmute": selfUnmuteUrl,
  "self-deafen": selfDeafenUrl,
  "self-undeafen": selfUndeafenUrl,
  "ptt-on": pttOnUrl,
  "ptt-off": pttOffUrl,
  disconnected: disconnectedUrl,
  reconnected: reconnectedUrl,
  error: errorUrl,
};

// O `Record<SoundName, string>` já garante que os 14 nomes existem aqui; o que
// ele NÃO garante é que cada um aponta para o arquivo certo do catálogo (um
// copy-paste trocado passaria batido e só apareceria como "som errado"). Em
// dev isso falha alto; em produção não vale derrubar o app por um som.
if (import.meta.env.DEV) {
  for (const name of SOUND_NAMES) {
    const url = SOUND_URL[name];
    const expected = CATALOG[name].file;
    // clipe pequeno o bastante vira data: URI e perde o nome — aí não há o que
    // conferir (não acontece no dev server, mas a checagem não pode ser frágil)
    if (url.startsWith("data:")) continue;
    if (!url.includes(expected.replace(/\.ogg$/, ""))) {
      throw new Error(`sound/assets: "${name}" não aponta para ${expected}`);
    }
  }
}
