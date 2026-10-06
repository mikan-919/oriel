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
// Run `orield` from a GitHub checkout: it reports only origin's owner/repository,
// never the local path, remote credentials, or provider secrets. HTTPS and standard
// SSH GitHub remotes are recognized through `git remote get-url origin`.
// `orield integrations` reads the selected team's Linear issues with GitHub Issue
// link attachments for this working repository; it never starts Codex. Web's device
// view shows the same links, HOW description, and current Linear state. Discovery
// includes older/archived matches and all pages; unrelated team tasks and PR links
// are excluded. Add GitHub Issue URLs as link attachments in Linear; native issue
// synchronization is not required and no text is copied between WHAT and HOW.
// The last reported repository remains visible while a device is offline; starting
// outside a recognized GitHub checkout clears it. Browser ownership and the device
// bearer protect discovery/reporting. No local OAuth or Secret Service is required.
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
// GET /api/integrations includes each provider's durable authorization outcome.
// Failures expose only the processing step and allowlisted provider error codes;
// provider response text, OAuth state, authorization codes and tokens stay private.
// Web shows these outcomes after reload; target=null alone is not an auth result.
// Issue retrieval reports private-key import failures separately from GitHub token
// request HTTP errors: 401 points to App ID/key matching; 422 to requested grants.
// Correct the key/installation permissions, then Refresh recent issues; keep the
// existing repository connection. Provider error bodies and tokens are not echoed.

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
