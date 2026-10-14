export interface WebhookEnv {
  GITHUB_APP_WEBHOOK_SECRET?: string;
  LINEAR_WEBHOOK_SECRET?: string;
}
export type WorkflowChange = { provider: "github" | "linear"; scope: string };

/** Verify at the Worker edge, before waking the database object. Events are
 * invalidation hints, never approval facts or instructions for the agent. */
export async function workflowChange(request: Request, env: WebhookEnv, provider: "github" | "linear"): Promise<WorkflowChange | Response> {
  if (request.method !== "POST" || new URL(request.url).search) return new Response(null, {status:400});
  const secret = provider === "github" ? env.GITHUB_APP_WEBHOOK_SECRET : env.LINEAR_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook is not configured", {status:503});
  const signature = request.headers.get(provider === "github" ? "x-hub-signature-256" : "linear-signature") ?? "";
  const hex = provider === "github" ? /^sha256=([a-f0-9]{64})$/.exec(signature)?.[1] : /^[a-f0-9]{64}$/.test(signature) ? signature : undefined;
  if (!hex || !request.body) return new Response(null, {status:401});
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1_048_576) { await reader.cancel(); return new Response(null, {status:413}); }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC", hash:"SHA-256"}, false, ["verify"]);
  if (!await crypto.subtle.verify("HMAC", key, Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16)), body)) return new Response(null, {status:401});
  let payload;
  try { payload = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(body)); }
  catch { return new Response(null, {status:400}); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return new Response(null, {status:400});
  if (provider === "github") {
    if (!["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment", "check_run", "check_suite", "workflow_run", "status", "push", "create", "delete", "repository"].includes(request.headers.get("x-github-event") ?? "")) return new Response(null, {status:200});
    if (!Number.isSafeInteger(payload.repository?.id) || payload.repository.id <= 0) return new Response(null, {status:400});
    return {provider, scope:String(payload.repository.id)};
  }
  // Linear signs the timestamp in the payload, not merely the request header.
  if (!Number.isSafeInteger(payload.webhookTimestamp) || Math.abs(Date.now() - payload.webhookTimestamp) > 300_000) return new Response(null, {status:401});
  if (!["Issue", "Comment", "Attachment", "IssueAttachment", "OAuthApp"].includes(payload.type)) return new Response(null, {status:200});
  if (typeof payload.organizationId !== "string" || !/^[a-f0-9-]{36}$/i.test(payload.organizationId)) return new Response(null, {status:400});
  return {provider, scope:payload.organizationId};
}
