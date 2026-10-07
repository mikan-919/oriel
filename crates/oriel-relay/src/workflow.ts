import { parseDocument } from "yaml";
import type { Device } from "./integrations";

export type WorkflowKind = "plan" | "implement" | "respond" | "reconcile";
export type WorkflowBinding = {
  user_id: string; device_id: string; host_hash: string; repository_generation: string;
  github_generation: string; linear_generation: string; repository_id: number; team_id: string;
  repository: { owner: string; name: string };
};
export type WorkflowClaim = { kind: WorkflowKind; issue_number: number; version: string; branch: string | null };
export type WorkflowAdmission = WorkflowClaim & {
  linear_id: string | null;
  feedback?: { key: string; head_oid: string; pr_number: number };
  recovery?: { branch: string };
  execution?: { target_oid: string; base_branch: string; verification: string[][] };
};
export type WorkflowGrant = WorkflowAdmission & { lease_id: string; binding: WorkflowBinding };
export type WorkflowAuthority = { verify(device: Device, leaseId: string): WorkflowGrant };
export type GithubWhat = { number: number; node_id: string; title: string; body: string | null; url: string; state: "open" | "closed" };
export type LinearState = { id: string; name: string; type: string };
export type LinearHow = { id: string; identifier: string; title: string; description: string | null; url: string; state: LinearState };
export type PullRequest = { number: number; url: string; branch: string; head_oid: string; base_branch: string; state: "open" | "closed"; merged: boolean; draft: boolean };
export type Feedback = { key: string; kind: "review" | "comment" | "check_failure"; body: string; comments: { path: string | null; line: number | null; body: string }[] };
export type WorkflowRow = {
  issue: GithubWhat; linear: LinearHow | null; version: string; fingerprint: string | null;
  branch: string | null; canonical_oid: string | null; pull_request: PullRequest | null;
  phase: "needs-how" | "triage" | "approved" | "running" | "review" | "merged" | "done" | "closed" | "blocked";
  blocked_reason: string | null; feedback: Feedback | null; how_feedback: { key: string; body: string } | null;
  recovery: "invalidate" | null;
};
export type Configuration = { autonomous: boolean; verification: string[][]; error: string | null };
export type WorkflowSnapshot = {
  repository: { owner: string; name: string }; repository_id: number; repository_node_id: string;
  base_branch: string; target_oid: string; team: { team_id: string; team_name: string; workspace_id: string };
  configuration: Configuration; workflows: WorkflowRow[];
};

export const OID = /^[a-f0-9]{40}$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function validBranch(branch: string): boolean {
  return branch.length > 0 && !branch.startsWith("/") && !branch.endsWith("/") && !branch.endsWith(".") &&
    !branch.includes("..") && !branch.includes("@{") && !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) &&
    branch !== "@" && branch.split("/").every(part => !!part && !part.startsWith(".") && !part.endsWith(".lock"));
}
/** Only native, canonical Issue paths establish identity; aliases never confer approval. */
export function githubIssueLink(value: string): { owner: string; name: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/issues\/([1-9][0-9]*)$/.exec(value);
  if (!match || match[2] === "." || match[2] === "..") return null;
  const number = Number(match[3]);
  return Number.isSafeInteger(number) ? { owner: match[1].toLowerCase(), name: match[2].toLowerCase(), number } : null;
}
export function parseConfiguration(source: string | null): Configuration {
  const invalid = (error: string): Configuration => ({ autonomous: false, verification: [], error });
  if (source === null) return invalid("Target commit has no .oriel.yaml; autonomous execution is not enabled");
  let value: unknown;
  try {
    const document = parseDocument(source, { version: "1.2", schema: "core", customTags: [], uniqueKeys: true });
    if (document.errors.length || document.warnings.length) return invalid(".oriel.yaml is not strict YAML 1.2 core");
    value = document.toJS();
  } catch { return invalid(".oriel.yaml is not strict YAML 1.2 core"); }
  const object = (input: unknown): input is Record<string, unknown> => !!input && typeof input === "object" && !Array.isArray(input);
  if (!object(value) || Object.keys(value).some(key => !["schemaVersion", "execution", "modelCapabilities"].includes(key)) || value.schemaVersion !== 1 || !object(value.execution)) return invalid(".oriel.yaml schema violation");
  if ("modelCapabilities" in value) return invalid("modelCapabilities requirements are unsupported: installed Codex metadata cannot establish them");
  const execution = value.execution;
  if (Object.keys(execution).some(key => !["backend", "autonomous", "verification"].includes(key)) || execution.backend !== "worktree" || execution.autonomous !== true || !Array.isArray(execution.verification) || !execution.verification.length || !execution.verification.every(command => Array.isArray(command) && command.length && command.every(arg => typeof arg === "string" && arg.length > 0 && !arg.includes("\0")))) return invalid(".oriel.yaml requires worktree, autonomous: true and nonempty argv verification commands");
  return { autonomous: true, verification: execution.verification as string[][], error: null };
}
