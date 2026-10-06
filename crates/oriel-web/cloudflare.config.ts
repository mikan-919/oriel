import { defineConfig } from "cf/config";

// Public app: https://oriel-web.mikan-919.workers.dev
// `npm run build` renders the Topcoat view into build/index.html and terminal.js.
// `npm run dev` serves http://localhost:3001; `npm run deploy` publishes assets.
// No Rust server runs in production. Device tokens remain browser-entered;
// this public Worker receives no Relay secret or terminal frames.
// Use a wss:// Relay origin when opening the public HTTPS app; loopback ws://
// is for local development. Rebuild with `npm run build` after Rust view edits.
export default defineConfig({
  worker: {
    name: "oriel-web",
    compatibilityDate: "2026-10-05",
    assets: {
      notFoundHandling: "none",
    },
  },
});
