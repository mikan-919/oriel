export { RelayDevice } from "../build/index.js";
export { AccountRegistry } from "./account";
import { quotaResponse } from "./quota";
import { workflowChange, type WebhookEnv } from "./webhook";
import { WorkflowReader } from "./workflow-reader";
import { digest, type WorkflowSnapshot } from "./workflow";
import type { IntegrationEnv, SnapshotPreparation } from "./integrations";

interface RelayResponse extends Response {
  webSocket: WebSocket | null;
}

interface ObjectNamespace {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): { fetch(request: Request): Promise<RelayResponse> };
}

interface Env extends WebhookEnv, IntegrationEnv {
  ACCOUNTS: Omit<ObjectNamespace, "get"> & { get(id: { toString(): string }): {
    fetch(request: Request): Promise<RelayResponse>;
    prepareSnapshot(request: Request): Promise<{ value: SnapshotPreparation } | { error: string; status: number }>;
    finishSnapshot(request: Request, fence: string, snapshot: WorkflowSnapshot, snapshotHash: string, issueNumber?: number): Promise<{ value: boolean } | { error: string; status: number }>;
  } };
  RELAY: ObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const snapshot = /^\/api\/workflows\/[a-f0-9]{32}(\/snapshot)?$/.exec(url.pathname);
    if (snapshot && request.method === (snapshot[1] ? "POST" : "GET")) {
      const account = env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts"));
      const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
      try {
        const prepared = await account.prepareSnapshot(request.clone());
        if ("error" in prepared) return json({ error: prepared.error }, prepared.status);
        const reader = new WorkflowReader(env, { fail: (status, message) => { throw Object.assign(new Error(message), { status }); } });
        const value = await reader.read(prepared.value);
        const finished = await account.finishSnapshot(request, prepared.value.fence, value, await digest(value), prepared.value.issue_number);
        if ("error" in finished) return json({ error: finished.error }, finished.status);
        return json(snapshot[1] ? { snapshot: value, poll_after_seconds: prepared.value.poll_after_seconds } : value);
      } catch (error) {
        const quota = quotaResponse(error);
        if (quota) return quota;
        const known = error instanceof Error && "status" in error && typeof error.status === "number";
        return json({ error: known ? error.message : "Workflow provider state could not be confirmed; no approval was inferred" }, known ? error.status as number : 502);
      }
    }
    // Preserve the original provider URLs as well as the /api routes.
    const hook = /^(?:\/api)?\/webhooks\/(github|linear)$/.exec(url.pathname);
    if (hook) {
      const change = await workflowChange(request, env, hook[1] as "github" | "linear");
      if (change instanceof Response) return change;
      return env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts")).fetch(new Request("https://internal/workflow-change", {
        method:"POST", body:JSON.stringify(change),
      })).catch(error => quotaResponse(error) ?? Promise.reject(error));
    }
    if (url.pathname.startsWith("/api/")) {
      return env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts")).fetch(request)
        .catch(error => quotaResponse(error) ?? Promise.reject(error));
    }
    const route = /^\/device\/([0-9a-f]{32})\/(host|client)$/.exec(url.pathname);
    if (!route) return new Response("Not Found", { status: 404 });
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (url.search) return new Response("Query parameters are not allowed", { status: 400 });
    const authorized = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts")).fetch(request)
      .catch(error => quotaResponse(error) ?? Promise.reject(error));
    if (authorized.status !== 200) return authorized;
    // The frame object sees no browser/daemon credentials or account metadata.
    const headers = new Headers(request.headers);
    headers.delete("Authorization");
    headers.delete("Cookie");
    headers.delete("Sec-WebSocket-Protocol");
    const relay = env.RELAY.get(env.RELAY.idFromName(route[1]));
    const response = await relay.fetch(new Request(request, { headers }));
    if (route[2] !== "client" || response.status !== 101) return response;
    const upgradedHeaders = new Headers(response.headers);
    upgradedHeaders.set("Sec-WebSocket-Protocol", "oriel-client");
    const options: ResponseInit & { webSocket: WebSocket | null } = {
      status: 101,
      headers: upgradedHeaders,
      webSocket: response.webSocket,
    };
    return new Response(null, options);
  },
};
