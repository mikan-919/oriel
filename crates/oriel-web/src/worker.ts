interface Env {
  RELAY: { fetch(request: Request): Promise<Response> };
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/") || path.startsWith("/device/")) {
      // Preserve Origin, cookies, Set-Cookie and WebSocket upgrade end-to-end.
      return env.RELAY.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
