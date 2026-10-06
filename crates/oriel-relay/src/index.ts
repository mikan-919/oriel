export { RelayDevice } from "../build/index.js";
export { AccountRegistry } from "./account";

interface RelayResponse extends Response {
  webSocket: WebSocket | null;
}

interface ObjectNamespace {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): { fetch(request: Request): Promise<RelayResponse> };
}

interface Env {
  ACCOUNTS: ObjectNamespace;
  RELAY: ObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts")).fetch(request);
    }
    const route = /^\/device\/([0-9a-f]{32})\/(host|client)$/.exec(url.pathname);
    if (!route) return new Response("Not Found", { status: 404 });
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (url.search) return new Response("Query parameters are not allowed", { status: 400 });
    const authorized = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts")).fetch(request);
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
