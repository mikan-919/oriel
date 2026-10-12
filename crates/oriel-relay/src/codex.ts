import type { Device } from "./integrations";

const TAG = "codex";
const PROTOCOL = "oriel/codex/v1";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const METHODS = new Set(["engines/list", "workflow/pause", "workflow/resume", "workflow/model", "model/list", "thread/list", "thread/read",
  "thread/start", "thread/resume", "thread/fork", "thread/archive", "thread/unarchive", "thread/name/set",
  "turn/start", "turn/steer", "turn/interrupt", "review/start", "skills/list", "mcpServerStatus/list",
  "mcpServer/oauth/login", "mcp/configure", "request/respond"]);
type Attachment = {
  protocol: typeof PROTOCOL; role: "host" | "browser"; device_id: string; user_id: string;
  host_hash: string; repository_generation: string; client_id: string; session_hash: string;
  expires_at: number; pending: string[];
};

/** Authenticated control only. Transcripts and Codex credentials remain on the device. */
export class CodexConnections {
  constructor(private ctx: DurableObjectState, private device: (id: string) => Device | undefined,
    private sessionExpiry: (hash: string, user: string) => number | null) {}

  owns(ws: WebSocket): boolean { return (ws.deserializeAttachment() as Attachment | null)?.protocol === PROTOCOL; }
  private close(ws: WebSocket): void {
    try { ws.close(1008, "Codex connection ended"); } catch { /* Already closed. */ }
  }
  private live(ws: WebSocket): Attachment {
    const a = ws.deserializeAttachment() as Attachment | null;
    const d = a && this.device(a.device_id);
    const expiry = a?.role === "browser" ? this.sessionExpiry(a.session_hash, a.user_id) : a?.expires_at;
    if (!a || a.protocol !== PROTOCOL || ws.readyState !== WebSocket.OPEN || !d ||
      d.user_id !== a.user_id || d.host_hash !== a.host_hash || d.repository_generation !== a.repository_generation ||
      !expiry || expiry <= Date.now()) { this.close(ws); throw new Error("Codex connection is unavailable"); }
    return a;
  }
  private sockets(): WebSocket[] { return this.ctx.getWebSockets(TAG).filter(ws => { try { this.live(ws); return true; } catch { return false; } }); }
  private host(deviceId: string): WebSocket | undefined {
    return this.sockets().find(ws => { try { const a = this.live(ws); return a.role === "host" && a.device_id === deviceId; } catch { return false; } });
  }
  connect(device: Device, session?: { hash: string; user: { id: string } }): Response {
    if (!device.user_id || session && session.user.id !== device.user_id) throw new Error("Device belongs to another account");
    const role = session ? "browser" : "host";
    if (role === "host") for (const ws of this.sockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.role === "host" && a.device_id === device.device_id) this.close(ws);
    }
    const expiresAt = session ? this.sessionExpiry(session.hash, session.user.id) : Date.now() + 45_000;
    if (!expiresAt || expiresAt <= Date.now()) throw new Error("Session expired");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [TAG]);
    pair[1].serializeAttachment({ protocol: PROTOCOL, role, device_id: device.device_id, user_id: device.user_id,
      host_hash: device.host_hash, repository_generation: device.repository_generation, client_id: crypto.randomUUID(),
      session_hash: session?.hash ?? "", expires_at: expiresAt, pending: [] } satisfies Attachment);
    if (session) {
      const host = this.host(device.device_id);
      this.send(pair[1], host ? { type: "state", engines: [] } : { type: "offline" });
      if (host) this.send(host, { type: "snapshot" });
    }
    this.ctx.waitUntil(this.schedule());
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private send(ws: WebSocket, message: unknown): void { try { ws.send(JSON.stringify(message)); } catch { this.close(ws); } }
  message(ws: WebSocket, raw: string | ArrayBuffer): void {
    try {
      const a = this.live(ws);
      if (typeof raw !== "string" || raw.length > 512 * 1024) throw new Error();
      const message = JSON.parse(raw);
      if (a.role === "host") {
        a.expires_at = Date.now() + 45_000;
        if (message.type === "heartbeat") this.send(ws, { type: "heartbeat" });
        else if (message.type === "state" && Array.isArray(message.engines) && message.engines.length <= 32) {
          for (const peer of this.sockets()) {
            const p = this.live(peer);
            if (p.role === "browser" && p.device_id === a.device_id) this.send(peer, message);
          }
        } else if (message.type === "event" && typeof message.engine === "string" && message.message?.method) {
          for (const peer of this.sockets()) {
            const p = this.live(peer);
            if (p.role === "browser" && p.device_id === a.device_id) this.send(peer, message);
          }
        } else if (message.type === "response" && UUID.test(message.client) && UUID.test(message.request_id)) {
          for (const peer of this.sockets()) {
            const p = this.live(peer);
            if (p.role === "browser" && p.device_id === a.device_id && p.client_id === message.client && p.pending.includes(message.request_id)) {
              p.pending = p.pending.filter(id => id !== message.request_id); peer.serializeAttachment(p);
              this.send(peer, { type: "response", request_id: message.request_id, result: message.result, error: message.error });
            }
          }
        } else throw new Error();
        ws.serializeAttachment(a);
      } else {
        if (message.type !== "rpc" || !UUID.test(message.request_id) || !METHODS.has(message.method) ||
          typeof message.engine !== "string" || message.engine.length > 80 || !message.params ||
          typeof message.params !== "object" || Array.isArray(message.params) || a.pending.length >= 16 || a.pending.includes(message.request_id)) throw new Error();
        const host = this.host(a.device_id);
        if (!host) { this.send(ws, { type: "response", request_id: message.request_id, error: "Codex is offline" }); return; }
        a.pending.push(message.request_id); ws.serializeAttachment(a);
        this.send(host, { type: "request", client: a.client_id, request_id: message.request_id,
          engine: message.engine, method: message.method, params: message.params });
      }
    } catch {
      this.send(ws, { type: "rejected", error: "Codex request rejected" });
    }
  }
  ended(ws: WebSocket): void {
    const a = ws.deserializeAttachment() as Attachment | null;
    this.close(ws);
    if (a?.role === "host" && !this.host(a.device_id)) for (const peer of this.sockets()) {
      try { const p = this.live(peer); if (p.role === "browser" && p.device_id === a.device_id) {
        p.pending = []; peer.serializeAttachment(p); this.send(peer, { type: "offline" });
      } } catch { /* Revoked peer closed. */ }
    }
  }
  private async schedule(): Promise<void> {
    const live = this.sockets().flatMap(ws => { try { return [this.live(ws)]; } catch { return []; } });
    if (!live.length) return;
    const deadline = Math.min(Date.now() + 10_000, ...live.map(a => a.role === "browser" ? this.sessionExpiry(a.session_hash, a.user_id) ?? Date.now() : a.expires_at));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > deadline) await this.ctx.storage.setAlarm(deadline);
  }
  async alarm(): Promise<void> { for (const ws of this.ctx.getWebSockets(TAG)) { try { this.live(ws); } catch { this.ended(ws); } } await this.schedule(); }
}
