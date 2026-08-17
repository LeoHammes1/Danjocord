/**
 * Indicador de "fulano está digitando…" (M2). Duas metades independentes:
 *
 *  - TypingTracker: lado RECEPTOR. Estado POR CANAL (trocar de canal não pode
 *    vazar o indicador do anterior); cada usuário expira 10s depois do ÚLTIMO
 *    TYPING_START dele — o servidor não manda "typing stop", a expiração é
 *    responsabilidade do cliente (contrato do M2).
 *
 *  - TypingSender: lado EMISSOR. Throttle de 8s POR CANAL — 8 < 10 de
 *    propósito: quem digita sem parar renova a janela dos receptores antes
 *    de ela vencer, sem inundar o servidor (1 POST a cada 8s no pior caso).
 *
 * Nada aqui persiste nem toca rede diretamente: o main.ts injeta os efeitos
 * (render e POST) por callback, o que mantém este módulo testável e sem
 * dependência do DOM.
 */

export class TypingTracker {
  /** channel_id → (user_id → timer de expiração) */
  private readonly byChannel = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();

  constructor(
    private readonly ttlMs: number,
    /** chamada sempre que o conjunto de digitadores de um canal MUDA (não a cada renovação) */
    private readonly onChange: (channelId: string) => void,
  ) {}

  /** TYPING_START recebido: (re)abre a janela de ttlMs para este usuário neste canal. */
  start(channelId: string, userId: string): void {
    let channel = this.byChannel.get(channelId);
    if (channel === undefined) {
      channel = new Map();
      this.byChannel.set(channelId, channel);
    }
    const existing = channel.get(userId);
    if (existing !== undefined) clearTimeout(existing);
    channel.set(userId, setTimeout(() => this.stop(channelId, userId), this.ttlMs));
    // renovação não muda o conjunto visível — só avisa quando alguém ENTRA
    if (existing === undefined) this.onChange(channelId);
  }

  /** Remove antes da expiração (MESSAGE_CREATE do mesmo autor) ou na expiração. */
  stop(channelId: string, userId: string): void {
    const channel = this.byChannel.get(channelId);
    const timer = channel?.get(userId);
    if (channel === undefined || timer === undefined) return;
    clearTimeout(timer);
    channel.delete(userId);
    if (channel.size === 0) this.byChannel.delete(channelId);
    this.onChange(channelId);
  }

  /** Quem está digitando AGORA neste canal (ids, na ordem de chegada). */
  typers(channelId: string): string[] {
    return [...(this.byChannel.get(channelId)?.keys() ?? [])];
  }

  /** Logout/reset: mata todos os timers pendentes (senão disparariam no vazio). */
  clear(): void {
    for (const channel of this.byChannel.values()) {
      for (const timer of channel.values()) clearTimeout(timer);
    }
    this.byChannel.clear();
  }
}

export class TypingSender {
  /** channel_id → timestamp do último POST — o cursor do throttle é por canal */
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly intervalMs: number,
    private readonly post: (channelId: string) => void,
  ) {}

  /** Chamada a cada tecla no composer; só vira POST quando a janela do throttle abre. */
  typed(channelId: string): void {
    const now = Date.now();
    if (now - (this.lastSentAt.get(channelId) ?? 0) < this.intervalMs) return;
    this.lastSentAt.set(channelId, now);
    this.post(channelId);
  }

  /**
   * Mensagem enviada: zera o cursor do throttle. O indicador nos outros
   * clientes some via MESSAGE_CREATE; se o usuário recomeçar a digitar, o
   * próximo TYPING_START sai na hora em vez de esperar o resto da janela.
   */
  sent(channelId: string): void {
    this.lastSentAt.delete(channelId);
  }

  clear(): void {
    this.lastSentAt.clear();
  }
}

/** Texto da barra, nas três formas pedidas pelo M2 (0/1/2/3+ digitadores). */
export function typingLabel(names: string[]): string {
  const [first, second] = names;
  if (first === undefined) return "";
  if (names.length === 1) return `${first} está digitando…`;
  if (second !== undefined && names.length === 2) return `${first} e ${second} estão digitando…`;
  return "várias pessoas estão digitando…";
}
