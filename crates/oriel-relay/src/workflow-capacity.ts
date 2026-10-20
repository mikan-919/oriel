import type { WorkflowAdmission, WorkflowBinding, WorkflowClaim, WorkflowRow, WorkflowSnapshot } from "./workflow";

export const ATTACHMENT_LIMIT = 16_384;
// Structured-clone has headers, property names and array entries in addition to
// string bytes. Charge each node 16 bytes and strings at their larger JSON/UTF-16
// representation, without credit for shared references. This deliberately reserves
// more than V8's wire format, including for escaped strings and short argv arrays.
export function attachmentBytes(value: unknown): number {
  if (value === undefined) return 16;
  if (typeof value === "string") return 16 + Math.max(new TextEncoder().encode(JSON.stringify(value)).length, value.length * 2);
  if (value === null || typeof value !== "object") return 16;
  if (Array.isArray(value)) return 16 + value.reduce((sum, item) => sum + attachmentBytes(item), 0);
  return 16 + Object.entries(value).reduce((sum, [key, item]) => sum + attachmentBytes(key) + attachmentBytes(item), 0);
}

export function executionAdmission(snapshot: WorkflowSnapshot, row: WorkflowRow, claim: WorkflowClaim): WorkflowAdmission {
  return { ...claim, linear_id: row.linear?.id ?? null,
    task: { issue_number: row.issue.number, title: row.issue.title, url: row.issue.url,
      how_identifier: row.linear?.identifier ?? null, how_url: row.linear?.url ?? null },
    ...(claim.kind === "respond" && row.feedback && row.pull_request ? { feedback: {
      key: row.feedback.key, head_oid: row.pull_request.head_oid, pr_number: row.pull_request.number } } : {}),
    execution: { target_oid: snapshot.target_oid, base_branch: snapshot.base_branch, verification: snapshot.configuration.verification } };
}

export class WorkflowCapacityError extends Error {}

// Reserve the simultaneous grant, progress evidence and paused-task copies.
// All mutable scalar fields use their maximum encoded width.
export function reservedAttachment(binding: WorkflowBinding, admission: WorkflowAdmission, commands = admission.execution?.verification ?? []) {
  const lease_id = "f".repeat(36), timestamp = "9999-12-31T23:59:59.999Z";
  const repository = `${binding.repository.owner}/${binding.repository.name}`;
  return {
    protocol: "oriel/workflow/v2", binding, expires_at: Number.MAX_SAFE_INTEGER,
    grant: { ...admission, execution: admission.execution ? { ...admission.execution, verification: commands } : undefined, lease_id },
    stage: "implementing", task: { ...admission.task, repository }, updated_at: timestamp, changes: true, dirty: true,
    verification: admission.execution ? {
      execution_id: lease_id, repository, device_id: binding.device_id,
      generation: JSON.stringify([binding.repository_generation, binding.github_generation, binding.linear_generation]),
      commands, configuration_id: "f".repeat(64), issue_number: admission.issue_number,
      head_oid: "f".repeat(40), target_oid: admission.execution.target_oid, status: "success",
      completed: 1024, total: 1024, updated_at: timestamp,
    } : undefined,
  };
}

export function capacityError(binding: WorkflowBinding, admission: WorkflowAdmission): string | null {
  const overhead = attachmentBytes(reservedAttachment(binding, admission, []));
  const used = attachmentBytes(reservedAttachment(binding, admission)) - overhead;
  if (overhead + used <= ATTACHMENT_LIMIT) return null;
  const cause = overhead > ATTACHMENT_LIMIT ? "task/binding metadata" : used > ATTACHMENT_LIMIT ? "verification configuration alone" : "task/binding metadata reduces verification capacity";
  return `execution.verification capacity exceeded (${cause}): available ${Math.max(0, ATTACHMENT_LIMIT - overhead)} bytes, used ${used} bytes including progress copy; WebSocket attachment limit ${ATTACHMENT_LIMIT} bytes`;
}
