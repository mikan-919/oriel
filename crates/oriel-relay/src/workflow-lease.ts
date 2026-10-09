import type { Device, Integrations } from "./integrations";
import type { WorkflowAdmission, WorkflowBinding, WorkflowClaim, WorkflowGrant, WorkflowTask } from "./workflow";

const SOCKET_TAG = "workflow";
const WATCH_TAG = "workflow-progress";
const PROTOCOL = "oriel/workflow/v2";
const WATCH_PROTOCOL = "oriel/workflow-progress/v1";
const HEARTBEAT_MS = 10_000;
const EXPIRY_MS = 45_000;
const STAGES = ["idle", "discovering", "preparing", "planning", "discussing", "implementing", "reviewing", "verifying",
  "integrating", "pushing", "publishing", "reconciling", "paused"] as const;
type Stage = typeof STAGES[number];
type ProgressTask = WorkflowTask & { repository: string };
type ProgressDevice = {
  device_id: string;
  state: "offline" | "idle" | "running" | "paused";
  stage: Stage | null;
  task: ProgressTask | null;
  updated_at: string | null;
};
type WatchAttachment = {
  protocol: typeof WATCH_PROTOCOL;
  session_hash: string;
  user_id: string;
  expires_at: number;
};
type Attachment = {
  protocol: typeof PROTOCOL;
  binding: WorkflowBinding;
  expires_at: number;
  grant: (WorkflowAdmission & { lease_id: string }) | null;
  stage: Stage;
  task: ProgressTask | null;
  updated_at: string;
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
    private readonly ownedDevices: (userId: string) => Pick<Device, "device_id">[],
    private readonly sessionExpiry: (sessionHash: string, userId: string) => number | null,
  ) {}

  private attachment(ws: WebSocket): Attachment | null {
    const value = ws.deserializeAttachment() as Attachment | null;
    return value?.protocol === PROTOCOL ? value : null;
  }

  private stop(ws: WebSocket): void {
    try { ws.serializeAttachment(null); } catch { /* Closed sockets cannot retain grants. */ }
    try { ws.close(1008, "Workflow connection ended"); } catch { /* Already closed. */ }
  }

  private stopAll(): void {
    for (const ws of [...this.ctx.getWebSockets(SOCKET_TAG), ...this.ctx.getWebSockets(WATCH_TAG)]) this.stop(ws);
  }

  private liveWatch(ws: WebSocket): WatchAttachment {
    try {
      const attachment = ws.deserializeAttachment() as WatchAttachment | null;
      if (!attachment || attachment.protocol !== WATCH_PROTOCOL || ws.readyState !== WebSocket.OPEN) throw new Error();
      const expiry = this.sessionExpiry(attachment.session_hash, attachment.user_id);
      if (expiry === null || expiry <= Date.now()) throw new Error();
      return { ...attachment, expires_at: expiry };
    } catch {
      this.stop(ws);
      throw new WorkflowLeaseError();
    }
  }

  /** Read-only owner snapshots come only from paired-device rows and live control attachments. */
  publish(): void {
    try {
      const controls = new Map<string, Attachment>();
      for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
        try {
          const attachment = this.live(ws);
          controls.set(attachment.binding.device_id, attachment);
        } catch { /* Invalid control authority is closed before any snapshot is sent. */ }
      }
      for (const ws of this.ctx.getWebSockets(WATCH_TAG)) {
        let watcher: WatchAttachment;
        try { watcher = this.liveWatch(ws); } catch { continue; }
        const devices = this.ownedDevices(watcher.user_id).map((device): ProgressDevice => {
          const control = controls.get(device.device_id);
          if (!control || control.binding.user_id !== watcher.user_id) {
            return { device_id: device.device_id, state: "offline", stage: null, task: null, updated_at: null };
          }
          return { device_id: device.device_id,
            state: control.stage === "paused" ? "paused" : control.stage === "idle" ? "idle" : "running",
            stage: control.stage, task: control.grant
              ? { repository: `${control.binding.repository.owner}/${control.binding.repository.name}`, ...control.grant.task }
              : control.task, updated_at: control.updated_at };
        });
        this.send(ws, { type: "workflow-progress", devices });
      }
    } catch {
      // SQL/session failures must never leave a browser claiming an authoritative live stream.
      this.stopAll();
    }
  }

  watch(sessionHash: string, userId: string): Response {
    const expiresAt = this.sessionExpiry(sessionHash, userId);
    if (expiresAt === null || expiresAt <= Date.now()) throw new WorkflowLeaseError();
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [WATCH_TAG]);
    try {
      pair[1].serializeAttachment({
        protocol: WATCH_PROTOCOL, session_hash: sessionHash, user_id: userId, expires_at: expiresAt,
      } satisfies WatchAttachment);
    } catch { this.stop(pair[1]); throw new WorkflowLeaseError(); }
    this.publish();
    this.schedule();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private live(ws: WebSocket): Attachment {
    try {
      const attachment = this.attachment(ws);
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
    try {
      let deadline = Date.now() + HEARTBEAT_MS;
      for (const ws of this.ctx.getWebSockets(WATCH_TAG)) {
        try { deadline = Math.min(deadline, this.liveWatch(ws).expires_at); } catch { /* Revoked watcher closed. */ }
      }
      for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
        try { deadline = Math.min(deadline, this.live(ws).expires_at); } catch { /* Invalid control closed. */ }
      }
      // Compute and enqueue without an await: older reads must not overwrite a shortened session deadline.
      this.ctx.waitUntil(this.ctx.storage.setAlarm(deadline).catch(() => this.stopAll()));
    } catch {
      this.stopAll();
    }
  }

  connect(device: Device): Response {
    const binding = this.integrations.workflowBinding(device);
    for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
      if (this.attachment(ws)?.binding.device_id === device.device_id) this.stop(ws);
    }
    const pair = new WebSocketPair();
    const attachment: Attachment = { protocol: PROTOCOL, binding, expires_at: Date.now() + EXPIRY_MS, grant: null,
      stage: "idle", task: null, updated_at: new Date().toISOString() };
    this.ctx.acceptWebSocket(pair[1], [SOCKET_TAG]);
    try { pair[1].serializeAttachment(attachment); }
    catch { this.stop(pair[1]); throw new WorkflowLeaseError(); }
    this.publish();
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
    if (this.ctx.getTags(ws).includes(WATCH_TAG)) {
      if (message === "ready") {
        this.publish();
        this.schedule();
        return;
      }
      this.stop(ws);
      return;
    }
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
      if (request.type === "progress") {
        if (Object.keys(request).some(key => !["type", "request_id", "stage", "lease_id"].includes(key)) ||
            !STAGES.includes(request.stage as Stage)) throw new Error();
        if (attachment.grant) {
          if (request.lease_id !== attachment.grant.lease_id) throw new WorkflowLeaseError();
        } else if (!["idle", "discovering", "paused"].includes(request.stage as string) ||
                   request.lease_id !== undefined) throw new WorkflowLeaseError();
        attachment.stage = request.stage as Stage;
        if (!attachment.grant && attachment.stage !== "paused") attachment.task = null;
        attachment.updated_at = new Date().toISOString();
        ws.serializeAttachment(attachment);
        this.send(ws, { type: "progressed", request_id: requestId });
        return;
      }
      if (request.type === "check" || request.type === "release") {
        if (typeof request.lease_id !== "string" || attachment.grant?.lease_id !== request.lease_id) {
          throw new WorkflowLeaseError();
        }
        const leaseId = attachment.grant.lease_id;
        if (request.type === "release") {
          if (attachment.stage === "paused") {
            attachment.task = { repository: `${attachment.binding.repository.owner}/${attachment.binding.repository.name}`,
              ...attachment.grant.task };
          }
          attachment.grant = null;
          if (attachment.stage !== "paused") {
            attachment.stage = "idle";
            attachment.task = null;
          }
          attachment.updated_at = new Date().toISOString();
          ws.serializeAttachment(attachment);
        }
        this.send(ws, { type: request.type === "check" ? "checked" : "released", request_id: requestId, lease_id: leaseId });
        return;
      }
      if (request.type !== "claim" || attachment.grant ||
          !["plan", "discuss", "implement", "respond", "reconcile"].includes(request.kind as string) ||
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
      attachment.stage = "preparing";
      attachment.task = null;
      attachment.updated_at = new Date().toISOString();
      ws.serializeAttachment(attachment);
      this.send(ws, { type: "granted", request_id: requestId, lease_id: leaseId });
    } catch {
      this.send(ws, { type: "rejected", request_id: requestId, error: "Workflow request rejected" });
    } finally {
      this.publish();
    }
  }

  close(ws: WebSocket): void {
    this.stop(ws);
    this.publish();
  }

  async alarm(): Promise<void> {
    this.publish();
    let deadline: number | null = null;
    for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
      try {
        const attachment = this.live(ws);
        deadline = Math.min(deadline ?? Date.now() + HEARTBEAT_MS, attachment.expires_at);
      } catch { /* Expired or changed bindings are already closed. */ }
    }
    for (const ws of this.ctx.getWebSockets(WATCH_TAG)) {
      try { deadline = Math.min(deadline ?? Date.now() + HEARTBEAT_MS, this.liveWatch(ws).expires_at); }
      catch { /* Expired or revoked watchers are already closed. */ }
    }
    if (deadline !== null) {
      try { await this.ctx.storage.setAlarm(deadline); }
      catch { this.stopAll(); }
    }
  }
}
