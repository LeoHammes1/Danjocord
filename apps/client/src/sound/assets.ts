/**
 * URLs dos clipes (M8). Um `import` estático por som — feio, e de propósito:
 * é assim que o Vite ENXERGA a dependência, fingerprinta o arquivo e o copia
 * para o bundle (importante no desktop, onde o renderer é servido pelo scheme
 * `app://` a partir de renderer-dist). Um `import.meta.glob` ou uma URL
 * montada por string funcionaria no dev e sumiria no build.
 *
 * Este módulo existe SEPARADO do catálogo porque ele é o único que toca nos
 * arquivos: assim `policy.ts` importa só dados e roda no Node, sob
 * `node --test`. As extensões são duas de propósito (12 .mp3 do Discord + 2
 * .wav sintetizados, ver catalog.ts) — o que muda aqui é só o nome do arquivo;
 * o Vite trata os dois formatos igual, e o `decodeAudioData` também.
 */
import { CATALOG, SOUND_NAMES, type SoundName } from "./catalog.js";

import disconnectedUrl from "../../assets/sounds/disconnected.mp3";
import errorUrl from "../../assets/sounds/error.wav";
import mentionUrl from "../../assets/sounds/mention.mp3";
import messageUrl from "../../assets/sounds/message.mp3";
import pttOffUrl from "../../assets/sounds/ptt-off.mp3";
import pttOnUrl from "../../assets/sounds/ptt-on.mp3";
import reconnectedUrl from "../../assets/sounds/reconnected.mp3";
import selfDeafenUrl from "../../assets/sounds/self-deafen.mp3";
import selfMuteUrl from "../../assets/sounds/self-mute.mp3";
import selfUndeafenUrl from "../../assets/sounds/self-undeafen.mp3";
import selfUnmuteUrl from "../../assets/sounds/self-unmute.mp3";
import streamStartUrl from "../../assets/sounds/stream-start.wav";
import voiceJoinUrl from "../../assets/sounds/voice-join.mp3";
import voiceLeaveUrl from "../../assets/sounds/voice-leave.mp3";

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
    if (!url.includes(expected.replace(/\.(mp3|wav)$/, ""))) {
      throw new Error(`sound/assets: "${name}" não aponta para ${expected}`);
    }
  }
}
