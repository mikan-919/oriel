import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Miniflare } from "miniflare";

const device = "a".repeat(32);
const hostToken = "b".repeat(64);
const clientToken = "c".repeat(64);

// Exercise the compiled Rust Worker and real DO, including fetched 101 headers.
// Run `npm run build` first; no credentials, sockets or storage survive this test.
test("authenticated upgrades preserve opaque forwarding; denied upgrades cannot evict sockets", { timeout: 15000 }, async () => {
  const runtime = new Miniflare({
    workers: [{
      config: {
        name: "relay-test",
        compatibilityDate: "2026-10-05",
        manifest: {
          mainModule: "index.js",
          modules: {
            "index.js": { type: "esm", contents: await readFile("build/index.js", "utf8") },
            "index_bg.wasm": { type: "wasm", contents: await readFile("build/index_bg.wasm") },
          },
        },
        exports: { RelayDevice: { type: "durable-object", storage: "sqlite" } },
        env: {
          RELAY: { type: "durable-object", worker: "relay-test", exportName: "RelayDevice" },
          ORIEL_DEVICE_CREDENTIALS: {
            type: "text",
            value: JSON.stringify({
              [device]: { host_token: hostToken, client_token: clientToken },
            }),
          },
        },
      },
    }],
  });
  const upgrade = (role, headers = {}) => runtime.dispatchFetch(
    `https://relay.example/device/${device}/${role}`,
    { headers: { Upgrade: "websocket", ...headers } },
  );
  try {
    const host = await upgrade("host", { Authorization: `Bearer ${hostToken}` });
    assert.equal(host.status, 101);
    host.webSocket.accept();
    const client = await upgrade("client", {
      "Sec-WebSocket-Protocol": `oriel-client, oriel-auth.${clientToken}`,
    });
    assert.equal(client.status, 101);
    assert.equal(client.headers.get("Sec-WebSocket-Protocol"), "oriel-client");
    client.webSocket.accept();

    assert.equal((await upgrade("host")).status, 401);
    assert.equal((await upgrade("client")).status, 401);
    assert.equal((await upgrade("host", { Authorization: `Bearer ${clientToken}` })).status, 403);
    assert.equal((await upgrade("client", {
      "Sec-WebSocket-Protocol": `oriel-client, oriel-auth.${hostToken}`,
    })).status, 403);

    const receive = (socket) => new Promise((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(event.data), { once: true });
      socket.addEventListener("close", () => reject(new Error("authorized socket evicted")), { once: true });
    });
    const input = new Uint8Array([0, 255, 27, 13, 128]);
    const atHost = receive(host.webSocket);
    client.webSocket.send(input);
    assert.deepEqual(new Uint8Array(await atHost), input);
    const atClient = receive(client.webSocket);
    host.webSocket.send("opaque terminal-independent frame");
    assert.equal(await atClient, "opaque terminal-independent frame");
  } finally {
    await runtime.dispose();
  }
});
