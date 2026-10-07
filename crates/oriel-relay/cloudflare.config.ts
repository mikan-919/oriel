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
// `orield integrations` remains read-only linked-HOW discovery. Web's per-device
// Development workflow creates GitHub WHATs and shows WHAT/HOW/PR/current blockers.
// `orield workflow` explicitly starts read-only Codex HOW planning; `--once` scans
// once. HOW is created in native Linear Triage with the exact GitHub Issue attachment.
// Review/edit HOW, then move it to native Todo to approve code. Oriel never sets Todo
// or merges. @oriel comments in Triage request HOW refinement; PR reviews/comments
// and failed checks drive verified fixes on the same canonical branch. Human merge
// is required before Linear Done, including WHATs auto-closed by that merge.
// Discovery paginates actual links; ambiguous/foreign HOWs block rather than match
// titles. Native GitHub issue synchronization is not required.
// The last reported repository remains visible while a device is offline; starting
// outside a recognized GitHub checkout clears it. Browser ownership and the device
// bearer protect discovery/reporting. No local OAuth or Secret Service is required.
// GitHub: register a GitHub App, enable user OAuth, and install it on the chosen
// repository. Repository permissions: Contents, Issues, Pull requests = read/write;
// Checks, Commit statuses, Metadata = read. Approve new installation permissions
// after changing the App. Organization installations also need Members = read to
// verify that the consenting GitHub user is an active organization admin.
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
// can remain valid until expiry (up to 1 hour). Git tokens are contents-only,
// repository-scoped and require a current account-owned device's live workflow lease.
// Browser session cookies are Lax for top-level OAuth callbacks; all browser
// mutations require exact Origin and callbacks require the approved live session.
// GET /api/integrations includes each provider's durable authorization outcome.
// Failures expose only the processing step and allowlisted provider error codes;
// provider response text, OAuth state, authorization codes and tokens stay private.
// Web shows these outcomes after reload; target=null alone is not an auth result.
// Issue retrieval reports private-key import failures separately from GitHub token
// request HTTP errors: 401 points to App ID/key matching; 422 to requested grants.
// Correct the key/installation permissions, then Refresh workflow or Refresh recent
// issues; keep the existing repository connection. Provider errors/tokens stay private.
//
// Code opt-in: commit .oriel.yaml on the repository's default target branch:
//   schemaVersion: 1
//   execution:
//     backend: worktree
//     autonomous: true
//     verification:
//       - ["cargo", "test", "--workspace"]
//       - ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"]
// At least one nonempty argv verification is required. Verification must not
// change tracked/staged source or introduce nonignored files. Missing/invalid
// opt-in blocks code but not explicitly started read-only HOW planning.
// modelCapabilities assertions are refused until Codex supplies verifiable metadata.
// Install/authenticate `codex` locally (codex login or OPENAI_API_KEY), then run
// `orield workflow` from the checkout. User config/rules/MCP/hooks are not imported;
// repositories with executable .codex/.mcp authority are refused, not silently used.
// Live socket grants fence repository/WHAT and canonical branch across devices.
// Loss/uncertainty stops children before new writes. Approval edits return HOW to
// Triage and require human reapproval; ambiguous prior seals need manual resolution.
// Private worktrees under XDG_STATE_HOME (or ~/.local/state/oriel) retain dirty or
// unpushed WIP on failure. Worktrees isolate Git work, not same-UID filesystem secrets.
// Target integration is non-destructive; conflict/divergence requires human resolution.
// Completed Git checkpoints can be reverified/published after interruption without
// rerunning the model. Push uses expected remote SHA, never unconditional force.

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
