export type GatewaySocket = {
  send(data: string): void;
  close(code?: number): void;
  onMessage(cb: (data: string) => void): void;
  onClose?(cb: (code: number) => void): void;
  onError?(cb: () => void): void;
};

export const DISCORD_INTENTS_GUILDS = 1;
export const DISCORD_INTENTS_GUILD_MESSAGES = 1 << 9;
export const DISCORD_INTENTS_MESSAGE_CONTENT = 1 << 15;

export const openDiscordGateway = (url = "wss://gateway.discord.gg/?v=10&encoding=json"): GatewaySocket => {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: (code = 4000) => ws.close(code),
    onMessage: (cb) => { ws.addEventListener("message", (event) => cb(String(event.data))); },
    onClose: (cb) => { ws.addEventListener("close", (event) => cb(event.code)); },
    onError: (cb) => { ws.addEventListener("error", cb); },
  };
};

type GatewayOptions = {
  readonly messageContent?: boolean;
  readonly onMessage?: (data: unknown) => Promise<void>;
  /** MESSAGE_UPDATE, only while Message Content is requested (otherwise the edited text is withheld). */
  readonly onMessageUpdate?: (data: unknown) => Promise<void>;
  /** MESSAGE_DELETE carries only ids, so it is delivered with or without Message Content. */
  readonly onMessageDelete?: (data: unknown) => Promise<void>;
  readonly onReady?: () => Promise<void>;
  /** Synchronous view of every dispatch (op 0) before its specific handler, e.g. to cache thread parents. */
  readonly onDispatch?: (type: string, data: unknown) => void;
  readonly log?: (line: string) => void;
  readonly random?: () => number;
  /** A close code no reconnect can fix (see DISCORD_FATAL_CLOSE): the gateway stops reconnecting and calls this once. */
  readonly onFatal?: (code: number, reason: string) => void;
  /** A session an earlier process left (see GatewaySession): the first connect RESUMEs it, so Discord replays what it missed. */
  readonly resume?: GatewaySession;
};

/** What RESUME needs: the session id, the last sequence number seen and the session's resume gateway URL. */
export type GatewaySession = { readonly session: string; readonly seq: number; readonly url: string };

/**
 * Close codes Discord documents as not to be reconnected after: retrying only burns the daily IDENTIFY budget until
 * someone fixes the token, sharding or intents. 4014 is fatal only once Message Content is no longer requested.
 */
export const DISCORD_FATAL_CLOSE: Readonly<Record<number, string>> = {
  4004: "authentication-failed",
  4010: "invalid-shard",
  4011: "sharding-required",
  4012: "invalid-api-version",
  4013: "invalid-intents",
  4014: "disallowed-intents",
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A single owned connection, including while reconnecting or degrading privileged intents. */
export const discordPresence = (
  open: (url?: string) => GatewaySocket,
  token: string,
  clock: { setInterval: (cb: () => void, ms: number) => unknown; clearInterval: (h: unknown) => void },
  onInteraction?: (data: unknown) => Promise<void>,
  options: GatewayOptions = {},
) => {
  let ws: GatewaySocket | undefined;
  let seq: number | null = options.resume?.seq ?? null;
  let session: string | undefined = options.resume?.session;
  let resumeUrl: string | undefined = options.resume?.url;
  let beat: unknown;
  let firstBeat: unknown;
  let retry: unknown;
  let handshake: unknown;
  let failures = 0;
  let stopped = false;
  let fatal: number | undefined;
  let healthy = false;
  let acknowledged = true;
  let content = options.messageContent === true;
  const handlers = new Set<Promise<void>>();
  const log = options.log ?? console.error;
  const dispatch = (work: (() => Promise<void>) | undefined) => {
    if (!work || stopped) return;
    const pending = Promise.resolve().then(work).catch(() => log("DISCORD_GATEWAY_ERROR event handler failed"));
    handlers.add(pending);
    void pending.finally(() => handlers.delete(pending));
  };
  const clearConnection = () => {
    healthy = false;
    if (beat !== undefined) clock.clearInterval(beat);
    if (firstBeat !== undefined) clock.clearInterval(firstBeat);
    if (handshake !== undefined) clock.clearInterval(handshake);
    beat = undefined;
    firstBeat = undefined;
    handshake = undefined;
  };
  const resetSession = () => { session = undefined; seq = null; resumeUrl = undefined; };
  const reconnect = (socket?: GatewaySocket) => {
    if (stopped || fatal !== undefined || (socket && socket !== ws)) return;
    clearConnection();
    const previous = ws;
    ws = undefined;
    // Clear identity first: close callbacks from this socket cannot schedule a second retry.
    previous?.close();
    if (retry !== undefined) return;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6));
    log(`DISCORD_GATEWAY reconnect in ${delay}ms`);
    retry = clock.setInterval(() => {
      clock.clearInterval(retry);
      retry = undefined;
      connect();
    }, delay);
  };
  const connect = () => {
    if (stopped) return;
    try {
      const socket = open(resumeUrl);
      ws = socket;
      acknowledged = true;
      socket.onClose?.((code) => {
        if (stopped || socket !== ws) return;
        const reason = DISCORD_FATAL_CLOSE[code];
        if (reason && !(code === 4014 && content)) {
          fatal = code;
          clearConnection();
          ws = undefined;
          log(`DISCORD_GATEWAY_FATAL close=${code} ${reason}; not reconnecting`);
          try { options.onFatal?.(code, reason); }
          catch { log("DISCORD_GATEWAY_ERROR fatal close handler failed"); }
          return;
        }
        if (code === 4014 && content) {
          content = false;
          resetSession();
          log('DISCORD_GATEWAY enable "Message Content Intent" in the Developer Portal (Bot tab); using presence/interactions with REST inbound fallback');
        } else if ([4007, 4009].includes(code)) resetSession();
        reconnect(socket);
      });
      socket.onError?.(() => reconnect(socket));
      if (socket.onClose) {
        handshake = clock.setInterval(() => reconnect(socket), 30_000);
      }
      socket.onMessage((raw) => {
        if (stopped || socket !== ws) return;
        try {
          const m: unknown = JSON.parse(raw);
          if (!record(m) || typeof m.op !== "number") throw new TypeError("Invalid gateway frame");
          if (typeof m.s === "number") seq = m.s;
          switch (m.op) {
            case 0:
              if (typeof m.t === "string" && options.onDispatch) {
                try { options.onDispatch(m.t, m.d); }
                catch { log("DISCORD_GATEWAY_ERROR dispatch observer failed"); }
              }
              if (m.t === "READY" || m.t === "RESUMED") {
                if (m.t === "READY" && record(m.d)) {
                  if (typeof m.d.session_id === "string") session = m.d.session_id;
                  if (typeof m.d.resume_gateway_url === "string") resumeUrl = `${m.d.resume_gateway_url.replace(/\/$/, "")}/?v=10&encoding=json`;
                }
                if (handshake !== undefined) clock.clearInterval(handshake);
                handshake = undefined;
                healthy = true;
                failures = 0;
                dispatch(options.onReady);
              }
              if (m.t === "INTERACTION_CREATE") dispatch(onInteraction ? () => onInteraction(m.d) : undefined);
              if (m.t === "MESSAGE_CREATE" && content) dispatch(options.onMessage ? () => options.onMessage?.(m.d) ?? Promise.resolve() : undefined);
              if (m.t === "MESSAGE_UPDATE" && content) dispatch(options.onMessageUpdate ? () => options.onMessageUpdate?.(m.d) ?? Promise.resolve() : undefined);
              if (m.t === "MESSAGE_DELETE") dispatch(options.onMessageDelete ? () => options.onMessageDelete?.(m.d) ?? Promise.resolve() : undefined);
              break;
            case 1:
              socket.send(JSON.stringify({ op: 1, d: seq }));
              acknowledged = false;
              break;
            case 7:
              reconnect(socket);
              break;
            case 9:
              if (m.d !== true) resetSession();
              reconnect(socket);
              break;
            case 10:
              if (!record(m.d) || typeof m.d.heartbeat_interval !== "number" || m.d.heartbeat_interval <= 0) throw new TypeError("Invalid gateway heartbeat");
              if (beat !== undefined) clock.clearInterval(beat);
              if (firstBeat !== undefined) clock.clearInterval(firstBeat);
              const heartbeat = () => {
                if (!acknowledged) { reconnect(socket); return; }
                try { socket.send(JSON.stringify({ op: 1, d: seq })); acknowledged = false; }
                catch { reconnect(socket); }
              };
              const interval = m.d.heartbeat_interval;
              if (socket.onClose) {
                firstBeat = clock.setInterval(() => {
                  clock.clearInterval(firstBeat);
                  firstBeat = undefined;
                  heartbeat();
                  if (ws === socket && !stopped) beat = clock.setInterval(heartbeat, interval);
                }, interval * (options.random ?? Math.random)());
              } else beat = clock.setInterval(heartbeat, interval);
              if (session && seq !== null) socket.send(JSON.stringify({ op: 6, d: { token, session_id: session, seq } }));
              else socket.send(JSON.stringify({ op: 2, d: {
                token,
                intents: DISCORD_INTENTS_GUILDS | DISCORD_INTENTS_GUILD_MESSAGES | (content ? DISCORD_INTENTS_MESSAGE_CONTENT : 0),
                properties: { os: process.platform, browser: "dori", device: "dori" },
                presence: { status: "online", since: null, activities: [], afk: false },
              } }));
              break;
            case 11:
              acknowledged = true;
              break;
          }
        } catch {
          log("DISCORD_GATEWAY_ERROR invalid frame or socket failure");
          reconnect(socket);
        }
      });
    } catch {
      log("DISCORD_GATEWAY_ERROR connection failed");
      reconnect();
    }
  };
  connect();
  return {
    get healthy() { return healthy && content; },
    /** Raw socket state for the status file: connected, and whether Message Content is still requested. */
    get connected() { return healthy; },
    get messageContent() { return content; },
    /** The fatal close code that stopped reconnecting, if any. */
    get fatal() { return fatal; },
    async settled() { await Promise.all(handlers); },
    /** The session a later process can resume, when this one has a READY session. */
    session(): GatewaySession | undefined {
      return session !== undefined && seq !== null && resumeUrl !== undefined ? { session, seq, url: resumeUrl } : undefined;
    },
    close() {
      stopped = true;
      clearConnection();
      if (retry !== undefined) clock.clearInterval(retry);
      ws?.close();
      ws = undefined;
    },
  };
};
