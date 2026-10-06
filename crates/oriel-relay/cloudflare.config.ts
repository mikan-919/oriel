import {
  bindings,
  defineConfig,
  exports,
} from "cf/config";

// Register/sign in at https://oriel-web.mikan-919.workers.dev with a discoverable
// Passkey; add a backup before losing the first authenticator. No ID/token input.
// Run `cargo run -p orield`: first start opens an expiring browser pairing link.
// Browser approval must be followed by typing yes for that account locally.
// Restart reuses the private device.json ID/host secret; legacy files migrate
// without rotating either. Device pairing requires no manual credential input.
// AccountRegistry persists auth/ownership and encrypted provider credentials;
// RelayDevice persists no frames. Relay is the trusted integration credential custodian.
// Authorization is checked before each upgrade; existing sockets end on close.
// PUBLIC_ORIGIN is also the WebAuthn origin; changing it requires re-enrollment.
// Development: .dev.vars PUBLIC_ORIGIN='http://localhost:3001', start both apps
// with `npm run dev`, then ORIEL_RELAY_URL=http://localhost:8787 orield.
// Check `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
// and `npm run build && npm test`. Deploy Relay before web for the service binding.
// Deploy with `npm run deploy`; CI uses `npm run deploy:prebuilt` after building.
// Both adapt this config's build output into Wrangler config and publish it.
// This file is authoritative for text vars and bindings; deployments preserve
// Worker secrets but replace dashboard text vars. cf beta.5's direct deploy
// hardcodes strict uploads and rejects intentional dashboard-to-config migrations.
//
// Integrations: sign in to Oriel Web, connect GitHub/Linear, choose and save the
// repository/team there. Connections belong to the Passkey account and are shared
// by all its paired devices, including devices paired after connecting.
// `orield integrations` reads recent 20 issues through Relay; no local OAuth,
// provider credentials, or Secret Service is required. These commands never start Codex.
// GitHub: register a GitHub App, enable user OAuth, and install it on the chosen
// repository. Repository permissions: Contents, Issues, Pull requests = read/write;
// Metadata = read. Organization installations also need Members = read to verify
// that the consenting GitHub user is an active organization admin.
// Callback: PUBLIC_ORIGIN + /api/integrations/callback/github.
// Set GITHUB_CLIENT_ID and GITHUB_APP_ID below; provision GITHUB_CLIENT_SECRET
// and GITHUB_APP_PRIVATE_KEY as Worker secrets, never committed text bindings.
// For local development supply these values in gitignored .dev.vars.
// Linear: register an OAuth app with PUBLIC_ORIGIN +
// /api/integrations/callback/linear as redirect URI and set LINEAR_CLIENT_ID.
// PKCE requests read/write; no Linear client secret is required.
// Provision INTEGRATION_ENCRYPTION_KEY as a Worker secret: a stable 32-byte
// AES-GCM key encoded as 64 hex characters (generate with `openssl rand -hex 32`).
// Relay encrypts provider access/refresh tokens and PKCE verifiers, binding each
// ciphertext to its account, provider, and purpose; refresh and revocation run there.
// Losing/changing this key requires reconnecting providers. Never commit its value.
// Durable credentials survive logout and AccountRegistry eviction; OAuth callbacks
// require the original live browser session. Legacy device-scoped integrations are
// discarded at cutover: reconnect in Web. Historical .old credential guidance no
// longer applies. Disconnect blocks new access; issued GitHub installation tokens
// can remain valid until expiry (up to 1 hour). New tokens are repository-scoped,
// issued only to account-owned devices after checking the user's current access.
// Browser session cookies are Lax for top-level OAuth callbacks; all browser
// mutations require exact Origin and callbacks require the approved live session.

export default defineConfig({
  worker: {
    name: "oriel-relay",
    entrypoint: "./src/index.ts",
    compatibilityDate: "2026-10-05",
    compatibilityFlags: ["nodejs_compat"],

    exports: {
      RelayDevice: exports.durableObject({
        // Runtime backend only: RelayDevice never writes terminal frames.
        storage: "sqlite",
      }),
      AccountRegistry: exports.durableObject({ storage: "sqlite" }),
    },

    env: {
      PUBLIC_ORIGIN: bindings.text("https://oriel-web.mikan-919.workers.dev"),
      // Set IDs in this config (or .dev.vars locally); never commit app secrets.
      GITHUB_CLIENT_ID: bindings.text("Iv23liLe7gluNc45KCEI"),
      GITHUB_APP_ID: bindings.text("4632357"),
      LINEAR_CLIENT_ID: bindings.text("40f52e9ba7f8a44e3e29fba5c5d08f60"),
      GITHUB_CLIENT_SECRET: bindings.secret(),
      GITHUB_APP_PRIVATE_KEY: bindings.secret(),
      INTEGRATION_ENCRYPTION_KEY: bindings.secret(),
      ACCOUNTS: bindings.durableObject({
        worker: "oriel-relay",
        exportName: "AccountRegistry",
      }),
      RELAY: bindings.durableObject({
        worker: "oriel-relay",
        exportName: "RelayDevice",
      }),
    },
  },
});
