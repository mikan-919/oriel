import { bindings, defineConfig } from "cf/config";

// Public app: https://oriel-web.mikan-919.workers.dev
// `npm run build` renders the Topcoat view into build/index.html and terminal.js.
// `npm run dev` serves http://localhost:3001; `npm run deploy` publishes assets.
// Deploy uses the shared build-output adapter and Wrangler, not cf's strict upload.
// CI can use `npm run deploy:prebuilt` after building; this stays the only config.
// Same-origin API/WebSocket requests use the private Relay service binding.
// No credentials are embedded in static assets. Rebuild after Rust view edits.
export default defineConfig({
  worker: {
    name: "oriel-web",
    compatibilityDate: "2026-10-05",
    entrypoint: "./src/worker.ts",
    env: {
      RELAY: bindings.worker({ worker: "oriel-relay" }),
      ASSETS: bindings.assets(),
    },
    assets: {
      notFoundHandling: "none",
      runWorkerFirst: ["/api/*", "/device/*"],
    },
  },
});
