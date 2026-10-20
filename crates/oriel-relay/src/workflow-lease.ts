import { attachmentBytes, ATTACHMENT_LIMIT, capacityError, WorkflowCapacityError } from "./workflow-capacity";
import type { Device, Integrations } from "./integrations";
import { digest } from "./workflow";
import type { WorkflowAdmission, WorkflowBinding, WorkflowClaim, WorkflowGrant, WorkflowTask, WorkflowSnapshot } from "./workflow";

const SOCKET_TAG = "workflow";
const WATCH_TAG = "workflow-progress";
const PROTOCOL = "oriel/workflow/v2";
const WATCH_PROTOCOL = "oriel/workflow-progress/v1";
const EXPIRY_MS = 45_000;
const STAGES = ["idle", "discovering", "preparing", "planning", "discussing", "implementing", "reviewing", "verifying",
  "integrating", "pushing", "publishing", "reconciling", "paused"] as const;
type Stage = typeof STAGES[number];
type Verification = { execution_id: string; repository: string; device_id: string; generation: string; commands: string[][]; configuration_id: string; issue_number: number; head_oid: string; target_oid: string; status: "running" | "success" | "failure"; completed: number; total: number; updated_at: string };
type ProgressTask = WorkflowTask & { repository: string };
type ProgressDevice = {
  execution_id?: string;
  generation?: string;
  verification?: Verification;
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
  last_snapshot?: string;
  changes?: boolean;
  state?: boolean;
};
type Attachment = {
  verification?: Verification;
  protocol: typeof PROTOCOL;
  binding: WorkflowBinding;
  expires_at: number;
  grant: (WorkflowAdmission & { lease_id: string }) | null;
  stage: Stage;
  task: ProgressTask | null;
  updated_at: string;
  changes?: boolean;
  dirty?: boolean;
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

// Fence browser evidence across repository and provider connection replacement.
function evidenceGeneration(binding: WorkflowBinding): string {
  return JSON.stringify([binding.repository_generation, binding.github_generation, binding.linear_generation]);
}

/** Ownership lives only in hibernating WebSocket attachments, never in SQL. */
export class WorkflowLeases {
  private lastFacts = new Map<string, string>();
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly integrations: Integrations,
    private readonly device: (id: string) => Device | undefined,
    private readonly ownedDevices: (userId: string) => Pick<Device, "device_id">[],
    private readonly sessionExpiry: (sessionHash: string, userId: string) => number | null,
    private readonly schedule: () => void,
    private readonly eventDriven: () => boolean = () => false,
  ) {}

  private saveControl(ws: WebSocket, attachment: Attachment): void {
    const used = attachmentBytes(attachment);
    if (used > ATTACHMENT_LIMIT) throw new WorkflowCapacityError(
      `execution.verification capacity exceeded: WebSocket attachment used ${used} bytes, limit ${ATTACHMENT_LIMIT} bytes`);
    ws.serializeAttachment(attachment);
  }

  private attachment(ws: WebSocket): Attachment | null {
    const value = ws.deserializeAttachment() as Attachment | null;
    return value?.protocol === PROTOCOL ? value : null;
  }

  private stop(ws: WebSocket, reason = "Workflow connection ended"): void {
    try { ws.serializeAttachment(null); } catch { /* Closed sockets cannot retain grants. */ }
    try { ws.close(1008, reason); } catch { /* Already closed. */ }
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
  private snapshot(userId: string): string {
    const controls = new Map<string, Attachment>();
    for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
      try { const a = this.live(ws); controls.set(a.binding.device_id, a); }
      catch { /* Invalid control authority is closed before any snapshot is sent. */ }
    }
    const devices = this.ownedDevices(userId).map((device): ProgressDevice => {
      const control = controls.get(device.device_id);
      if (!control || control.binding.user_id !== userId) {
        return { device_id: device.device_id, state: "offline", stage: null, task: null, updated_at: null };
      }
      return { device_id: device.device_id, execution_id: control.grant?.lease_id, generation: evidenceGeneration(control.binding),
        state: control.stage === "paused" ? "paused" : control.stage === "idle" ? "idle" : "running",
        stage: control.stage, task: control.grant
          ? { repository: `${control.binding.repository.owner}/${control.binding.repository.name}`, ...control.grant.task }
          : control.task, updated_at: control.updated_at, ...(control.verification ? {verification:control.verification} : {}) };
    });
    return JSON.stringify({ type: "workflow-progress", devices, poll_after_seconds:this.eventDriven() ? 900 : 60 });
  }

  private async notify(ws: WebSocket): Promise<void> {
    for (;;) {
      let watcher: WatchAttachment;
      try { watcher = this.liveWatch(ws); } catch { return; }
      const payload = this.snapshot(watcher.user_id);
      const hash = await digest(payload);
      try { watcher = this.liveWatch(ws); } catch { return; }
      // Recheck ownership and metadata across hashing; only send current data.
      if (payload !== this.snapshot(watcher.user_id)) continue;
      if (watcher.last_snapshot === hash) return;
      // The browser can disconnect while the snapshot is being hashed. Its
      // transport failure must not reach publish's authority-failure handler.
      try {
        ws.serializeAttachment({ ...watcher, last_snapshot: hash });
        ws.send(payload);
      } catch { this.stop(ws); }
      return;
    }
  }

  publish(): void {
    for (const ws of this.ctx.getWebSockets(WATCH_TAG)) {
      // Persist only a hash, so unchanged progress stays silent after hibernation.
      this.ctx.waitUntil(this.notify(ws).catch(() => this.stopAll()));
    }
  }

  publishFacts(device: Device, snapshot: WorkflowSnapshot, hash: string, issueNumber?: number): void {
    const payload = JSON.stringify({ type: "workflow-snapshot", device_id: device.device_id, issue_number: issueNumber, snapshot });
    const key = `${device.device_id}:${issueNumber ?? "all"}`;
    if (this.lastFacts.get(key) === hash) return;
    if (this.lastFacts.size >= 64) this.lastFacts.clear();
    this.lastFacts.set(key, hash);
    for (const ws of this.ctx.getWebSockets(WATCH_TAG)) {
      try { const watcher = this.liveWatch(ws); if (watcher.state && watcher.user_id === device.user_id) ws.send(payload); }
      catch { /* Revoked sessions cannot receive provider facts. */ }
    }
  }

  deviceChanged(userId: string): void {
    for (const ws of this.ctx.getWebSockets(WATCH_TAG)) {
      try { const watcher = this.liveWatch(ws); if (watcher.state && watcher.user_id === userId) this.send(ws, { type: "device-changed" }); }
      catch { /* Revoked. */ }
    }
  }

  changed(users: Set<string>): void {
    for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
      const saved = this.attachment(ws);
      if (!saved?.changes || saved.dirty || !users.has(saved.binding.user_id)) continue;
      try {
        const current = this.live(ws);
        this.saveControl(ws, {...current, dirty:true});
        this.send(ws, {type:"changed"});
      } catch { /* Revoked connections cannot receive notifications. */ }
    }
    for (const ws of this.ctx.getWebSockets(WATCH_TAG)) {
      const saved = ws.deserializeAttachment() as WatchAttachment | null;
      if (!saved?.changes || !users.has(saved.user_id)) continue;
      try { this.liveWatch(ws); this.send(ws, {type:"workflow-changed"}); } catch { /* Revoked. */ }
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
      if (attachment) attachment.expires_at = Math.max(attachment.expires_at,
        (this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0) + EXPIRY_MS);
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

  deadline(): number | null {
    let deadline: number | null = null;
    for (const ws of this.ctx.getWebSockets(WATCH_TAG)) {
      try { deadline = Math.min(deadline ?? Infinity, this.liveWatch(ws).expires_at); } catch { /* Revoked watcher closed. */ }
    }
    for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
      try { deadline = Math.min(deadline ?? Infinity, this.live(ws).expires_at); } catch { /* Invalid control closed. */ }
    }
    return deadline;
  }

  connect(device: Device): Response {
    const binding = this.integrations.workflowBinding(device);
    for (const ws of this.ctx.getWebSockets(SOCKET_TAG)) {
      if (this.attachment(ws)?.binding.device_id === device.device_id) this.stop(ws, "Workflow host replaced by another connection");
    }
    const pair = new WebSocketPair();
    const attachment: Attachment = { protocol: PROTOCOL, binding, expires_at: Date.now() + EXPIRY_MS, grant: null,
      stage: "idle", task: null, updated_at: new Date().toISOString() };
    this.ctx.acceptWebSocket(pair[1], [SOCKET_TAG]);
    try { this.saveControl(pair[1], attachment); }
    catch { this.stop(pair[1]); throw new WorkflowLeaseError(); }
    this.publish();
    this.schedule();
    return new Response(null, { status: 101, webSocket: pair[0], headers: { "X-Oriel-Snapshot-Transport": "http", "X-Oriel-Verification": "1" } });
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

  readScope(device: Device, leaseId: unknown, renew = false): { issue_number?: number; check: () => void } {
    const ws = this.ctx.getWebSockets(SOCKET_TAG).find(socket => this.attachment(socket)?.binding.device_id === device.device_id);
    if (!ws) throw new WorkflowLeaseError();
    const check = () => {
      const current = this.live(ws);
      if (current.grant?.lease_id !== leaseId) throw new WorkflowLeaseError();
      if (current.binding.user_id !== device.user_id || current.binding.host_hash !== device.host_hash ||
          current.binding.repository_generation !== device.repository_generation) throw new WorkflowLeaseError();
    };
    check();
    const current = this.live(ws);
    if (renew) {
      this.saveControl(ws, { ...current, expires_at: Date.now() + EXPIRY_MS, changes: true, dirty: false });
      this.schedule();
    }
    return { issue_number: current.grant?.issue_number, check };
  }

  private send(ws: WebSocket, response: Record<string, unknown>): void {
    try { ws.send(JSON.stringify(response)); } catch { this.stop(ws); }
  }

  async message(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.ctx.getTags(ws).includes(WATCH_TAG)) {
      if (message === "ready" || message === "ready:changes" || message === "ready:state") {
        ws.serializeAttachment({...this.liveWatch(ws), changes:message !== "ready", state:message === "ready:state"});
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
      if (request.type === "snapshot") {
        if (Object.keys(request).some(key => !["type", "request_id", "lease_id", "changes"].includes(key)) ||
            request.changes !== undefined && request.changes !== true) throw new Error();
        const binding = attachment.binding;
        const leaseId = attachment.grant?.lease_id;
        const check = () => {
          const current = this.live(ws);
          if (!sameBinding(binding, current.binding) || current.grant?.lease_id !== leaseId ||
              request.lease_id !== leaseId) throw new WorkflowLeaseError();
        };
        try {
          check();
          attachment.expires_at = Date.now() + EXPIRY_MS;
          attachment.changes = request.changes === true;
          attachment.dirty = false;
          this.saveControl(ws, attachment);
          this.schedule();
          const device = this.device(binding.device_id);
          if (!device) throw new WorkflowLeaseError();
          // A lease guards one WHAT. Keep all link/PR ambiguity checks, but do
          // not reread every unrelated issue and its discussion while it runs.
          const snapshot = await this.integrations.workflowSnapshot(device, check, attachment.grant?.issue_number);
          const hash = await digest(snapshot);
          check();
          this.send(ws, { type: "snapshot", request_id: requestId, snapshot, poll_after_seconds:this.eventDriven() ? 900 : 60 });
          this.publishFacts(device, snapshot, hash, attachment.grant?.issue_number);
        } catch (error) {
          const known = error instanceof Error && "status" in error;
          this.send(ws, { type: "error", request_id: requestId,
            status: known ? error.status : 502,
            ...(known && "retryAfterSeconds" in error ? { retry_after_seconds: error.retryAfterSeconds } : {}),
            error: known ? error.message : "Workflow provider state could not be confirmed; no approval was inferred" });
        }
        return;
      }
      if (request.type === "heartbeat") {
        attachment.expires_at = Date.now() + EXPIRY_MS;
        this.saveControl(ws, attachment);
        this.schedule();
        this.send(ws, { type: "heartbeat", request_id: requestId });
        return;
      }
      if (request.type === "progress") {
        if (Object.keys(request).some(key => !["type", "request_id", "stage", "lease_id", "verification"].includes(key)) ||
            !STAGES.includes(request.stage as Stage)) throw new Error();
        if (attachment.grant) {
          if (request.lease_id !== attachment.grant.lease_id) throw new WorkflowLeaseError();
        } else if (!["idle", "discovering", "paused"].includes(request.stage as string) ||
                   request.lease_id !== undefined) throw new WorkflowLeaseError();
        if (request.verification !== undefined) {
          const binding = attachment.binding;
          const value = request.verification as Record<string, unknown>;
          if (!value || typeof value !== "object" || Array.isArray(value) || !attachment.grant || request.stage !== "verifying" ||
              Object.keys(value).some(key => !["head_oid","target_oid","status","completed","total"].includes(key)) ||
              typeof value.head_oid !== "string" || !/^[a-f0-9]{40}$/.test(value.head_oid) ||
              typeof value.target_oid !== "string" || !/^[a-f0-9]{40}$/.test(value.target_oid) ||
              !["running","success","failure"].includes(value.status as string) ||
              !Number.isSafeInteger(value.total) || (value.total as number) < 1 || (value.total as number) > 1024 ||
              !Number.isSafeInteger(value.completed) || (value.completed as number) < 0 || (value.completed as number) > (value.total as number) ||
              (!attachment.grant.execution || value.target_oid !== attachment.grant.execution.target_oid || value.total !== attachment.grant.execution.verification.length) ||
              value.status === "success" && value.completed !== value.total) throw new Error();
          const configurationId = await digest(attachment.grant.execution!.verification);
          const current = this.live(ws);
          if (!sameBinding(binding, current.binding) || current.grant?.lease_id !== attachment.grant.lease_id) throw new WorkflowLeaseError();
          attachment.verification = { ...value,
            execution_id: attachment.grant.lease_id,
            repository: `${binding.repository.owner}/${binding.repository.name}`,
            device_id: binding.device_id,
            generation: evidenceGeneration(binding),
            commands: attachment.grant.execution!.verification,
            configuration_id: configurationId,
            issue_number:attachment.grant.issue_number, updated_at:new Date().toISOString() } as Verification;
        }
        if (attachment.stage === request.stage && request.verification === undefined) {
          this.send(ws, { type: "progressed", request_id: requestId });
          return;
        }
        attachment.stage = request.stage as Stage;
        if (!attachment.grant && attachment.stage !== "paused") attachment.task = null;
        attachment.updated_at = new Date().toISOString();
        this.saveControl(ws, attachment);
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
          this.saveControl(ws, attachment);
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
      const capacity = capacityError(binding, admitted);
      if (capacity) throw new WorkflowCapacityError(capacity);
      const leaseId = crypto.randomUUID();
      attachment.grant = { ...admitted, lease_id: leaseId };
      attachment.verification = undefined;
      attachment.stage = "preparing";
      attachment.task = null;
      attachment.updated_at = new Date().toISOString();
      this.saveControl(ws, attachment);
      this.send(ws, { type: "granted", request_id: requestId, lease_id: leaseId });
    } catch (error) {
      if (error instanceof Error && "status" in error && typeof error.status === "number" &&
          (error.status === 429 || error.status >= 500 && error.status <= 599)) {
        this.send(ws, { type: "error", request_id: requestId, status: error.status, error: error.message,
          ...("retryAfterSeconds" in error ? { retry_after_seconds: error.retryAfterSeconds } : {}) });
      } else {
        this.send(ws, { type: "rejected", request_id: requestId, error: error instanceof WorkflowCapacityError || error instanceof Error && error.message.startsWith("execution.verification capacity exceeded") ? error.message : "Workflow request rejected" });
      }
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
  }
}
