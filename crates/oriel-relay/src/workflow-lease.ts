import type { Device, Integrations } from "./integrations";
import type { WorkflowAdmission, WorkflowBinding, WorkflowClaim, WorkflowGrant } from "./workflow";

const SOCKET_TAG = "workflow";
const PROTOCOL = "oriel/workflow/v1";
const HEARTBEAT_MS = 10_000;
const EXPIRY_MS = 45_000;
type Attachment = {
  protocol: typeof PROTOCOL;
  binding: WorkflowBinding;
  expires_at: number;
  grant: (WorkflowAdmission & { lease_id: string }) | null;
};

export class WorkflowLeaseError extends Error {
  readonly status = 409;
  constructor() { super("Workflow lease is unavailable"); }
}

function sameBinding(left: WorkflowBinding, right: WorkflowBinding): boolean {
  return left.user_id === right.user_id && left.device_id === right.device_id &&
    left.host_hash === right.host_hash && left.repository_generation === right.repository_generation &&
    left.github_generation === right.github_generation && left.linear_generation === right.linear_generation &&
    left.repository_id === right.repository_id && left.team_id === right.team_id &&
    left.repository.owner === right.repository.owner && left.repository.name === right.repository.name;
}

/** Ownership lives only in hibernating WebSocket attachments, never in SQL. */
export class WorkflowLeases {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly integrations: Integrations,
    private readonly device: (id: string) => Device | undefined,
  ) {}

  private attachment(ws: WebSocket): Attachment | null {
    const value = ws.deserializeAttachment() as Attachment | null;
    return value?.protocol === PROTOCOL ? value : null;
  }

  private stop(ws: WebSocket): void {
    try { ws.serializeAttachment(null); } catch { /* Closed sockets cannot retain grants. */ }
    try { ws.close(1008, "Workflow connection ended"); } catch { /* Already closed. */ }
  }

  private live(ws: WebSocket): Attachment {
    const attachment = this.attachment(ws);
    try {
      if (!attachment || attachment.expires_at <= Date.now() || ws.readyState !== WebSocket.OPEN) {
        throw new WorkflowLeaseError();
      }
      const current = this.device(attachment.binding.device_id);
      if (!current || !sameBinding(attachment.binding, this.integrations.workflowBinding(current))) {
        throw new WorkflowLeaseError();
      }
      return attachment;
    } catch {
      this.stop(ws);
      throw new WorkflowLeaseError();
    }
  }

  private schedule(): void {
    this.ctx.waitUntil((async () => {
      const scheduled = await this.ctx.storage.getAlarm();
      const deadline = Date.now() + HEARTBEAT_MS;
      if (scheduled === null || scheduled > deadline) await this.ctx.storage.setAlarm(deadline);
    })().catch(() => {
      for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) this.stop(ws);
    }));
  }

  connect(device: Device): Response {
    const binding = this.integrations.workflowBinding(device);
    for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
      if (this.attachment(ws)?.binding.device_id === device.device_id) this.stop(ws);
    }
    const pair = new WebSocketPair();
    const attachment: Attachment = { protocol: PROTOCOL, binding, expires_at: Date.now() + EXPIRY_MS, grant: null };
    this.ctx.acceptWebSocket(pair[1], [SOCKET_TAG]);
    try { pair[1].serializeAttachment(attachment); }
    catch { this.stop(pair[1]); throw new WorkflowLeaseError(); }
    this.schedule();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  verify(device: Device, leaseId: string): WorkflowGrant {
    if (typeof leaseId !== "string" || !/^[a-f0-9-]{36}$/.test(leaseId)) throw new WorkflowLeaseError();
    for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
      let attachment: Attachment;
      try { attachment = this.live(ws); } catch { continue; }
      if (attachment.binding.device_id !== device.device_id || attachment.binding.user_id !== device.user_id ||
          attachment.binding.host_hash !== device.host_hash || attachment.binding.repository_generation !== device.repository_generation ||
          attachment.grant?.lease_id !== leaseId) continue;
      if (!sameBinding(attachment.binding, this.integrations.workflowBinding(device))) throw new WorkflowLeaseError();
      return { ...attachment.grant, binding: attachment.binding };
    }
    throw new WorkflowLeaseError();
  }

  private send(ws: WebSocket, response: Record<string, unknown>): void {
    try { ws.send(JSON.stringify(response)); } catch { this.stop(ws); }
  }

  async message(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let requestId: string | null = null;
    try {
      if (typeof message !== "string" || message.length > 4096) throw new Error();
      const request = JSON.parse(message) as Record<string, unknown>;
      if (!request || typeof request !== "object" || Array.isArray(request) ||
          typeof request.request_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.request_id)) throw new Error();
      requestId = request.request_id;
      let attachment = this.live(ws);
      if (request.type === "heartbeat") {
        attachment.expires_at = Date.now() + EXPIRY_MS;
        ws.serializeAttachment(attachment);
        this.schedule();
        this.send(ws, { type: "heartbeat", request_id: requestId });
        return;
      }
      if (request.type === "check" || request.type === "release") {
        if (typeof request.lease_id !== "string" || attachment.grant?.lease_id !== request.lease_id) {
          throw new WorkflowLeaseError();
        }
        const leaseId = attachment.grant.lease_id;
        if (request.type === "release") {
          attachment.grant = null;
          ws.serializeAttachment(attachment);
        }
        this.send(ws, { type: request.type === "check" ? "checked" : "released", request_id: requestId, lease_id: leaseId });
        return;
      }
      if (request.type !== "claim" || attachment.grant ||
          !["plan", "implement", "respond", "reconcile"].includes(request.kind as string) ||
          !Number.isSafeInteger(request.issue_number) || (request.issue_number as number) <= 0 ||
          typeof request.version !== "string" || !/^[a-f0-9]{64}$/.test(request.version) ||
          !(request.branch === null || typeof request.branch === "string" && request.branch.length <= 255)) throw new Error();
      const claim: WorkflowClaim = {
        kind: request.kind as WorkflowClaim["kind"], issue_number: request.issue_number as number,
        version: request.version, branch: request.branch as string | null,
      };
      const binding = attachment.binding;
      const check = () => {
        if (!sameBinding(binding, this.live(ws).binding)) throw new WorkflowLeaseError();
      };
      const current = this.device(binding.device_id);
      if (!current) throw new WorkflowLeaseError();
      const admitted = await this.integrations.workflowAdmission(current, claim, check);
      // No await from this binding check through peer comparison and attachment update.
      check();
      attachment = this.live(ws);
      if (attachment.grant) throw new WorkflowLeaseError();
      for (const peer of this.ctx.getWebSockets(SOCKET_TAG)) {
        if (peer === ws) continue;
        let other: Attachment;
        try { other = this.live(peer); } catch { continue; }
        if (other.binding.repository_id === binding.repository_id && other.grant &&
            (other.grant.issue_number === admitted.issue_number ||
             admitted.branch !== null && other.grant.branch === admitted.branch)) throw new WorkflowLeaseError();
      }
      const leaseId = crypto.randomUUID();
      attachment.grant = { ...admitted, lease_id: leaseId };
      ws.serializeAttachment(attachment);
      this.send(ws, { type: "granted", request_id: requestId, lease_id: leaseId });
    } catch {
      this.send(ws, { type: "rejected", request_id: requestId, error: "Workflow request rejected" });
    }
  }

  close(ws: WebSocket): void {
    this.stop(ws);
  }

  async alarm(): Promise<void> {
    let deadline: number | null = null;
    for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
      try {
        const attachment = this.live(ws);
        deadline = Math.min(deadline ?? Date.now() + HEARTBEAT_MS, attachment.expires_at);
      } catch { /* Expired or changed bindings are already closed. */ }
    }
    if (deadline !== null) {
      try { await this.ctx.storage.setAlarm(deadline); }
      catch { for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) this.stop(ws); }
    }
  }
}
