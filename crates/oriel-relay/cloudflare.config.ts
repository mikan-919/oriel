import {
  bindings,
  defineConfig,
  exports,
} from "cf/config";

// Provision devices explicitly; Device IDs alone never authorize a connection.
// `orield --print-relay-config` emits the JSON value for ORIEL_DEVICE_CREDENTIALS.
// Merge entries by Device ID when registering another daemon; replacing the
// entire secret without merging revokes omitted devices. Upload as a Worker
// secret (not a checked-in env value). For local development, put the value in
// an ignored .dev.vars file: ORIEL_DEVICE_CREDENTIALS='<JSON>'.
// Start orield with ORIEL_RELAY_URL=wss://<relay-origin> (loopback ws:// for dev).
// `orield --print-client-config` provides the Relay URL, Device ID and client
// token to enter in oriel-web. Both print commands expose secrets: do not log,
// commit or share their output; share only the client token with your browser.
// Revocation affects new upgrades; stop active sockets when revoking a device.
// Check `cargo test --workspace` and, here, `npm run build && npm test`.

export default defineConfig({
  worker: {
    name: "oriel-relay",
    entrypoint: "./build/index.js",
    compatibilityDate: "2026-10-05",

    exports: {
      RelayDevice: exports.durableObject({
        // Runtime backend only: RelayDevice never writes terminal frames.
        storage: "sqlite",
      }),
    },

    env: {
      ORIEL_DEVICE_CREDENTIALS: bindings.secret(),
      RELAY: bindings.durableObject({
        worker: "oriel-relay",
        exportName: "RelayDevice",
      }),
    },
  },
});
