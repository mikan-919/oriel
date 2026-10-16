# Terminal session authorization

Browser terminal connections carry an internal grant containing the owning session
hash (never its cookie), user, device, expiry in milliseconds, and a unique
connection ID. The public Worker removes any supplied `X-Oriel-Terminal` header
and forwards only AccountRegistry's grant, stripping cookies and bearer tokens.
The internal `/terminal-session`, `/terminal-release` and `/internal/revoke`
endpoints have no public Worker route.

## Ordering and races

AccountRegistry rechecks the session and registers `(session, device, connection,
expiry)` synchronously before returning an upgrade grant. RelayDevice checks the
session again before accepting a browser. Each forwarded input or output frame
makes a new AccountRegistry request and an uncached SQL session/ownership query.
After the await, RelayDevice rechecks socket state, revocation, expiry, host
presence and generation. It stores no terminal frames.

Logout deletes the session before awaiting revocation of each registered device.
RelayDevice marks matching browser attachments revoked and closes their sockets
before acknowledging. An in-memory expiry-bounded revocation map also invalidates
upgrade/frame checks already in flight. A pending upgrade cannot install a socket
between the final check and attachment installation because that section has no
await. Logout returns 200 only after all device acknowledgments. Frames already
forwarded before logout completed cannot be recalled.

A failed notification leaves session deletion in effect, returns a non-success
response, and retains targets for retry with the original cookie. Cookie clearing
happens only on success. Session replacement by passkey registration/login also
revokes the previous session. Other sessions and host sockets are unaffected.

Close/error cleanup deletes registrations only if the connection ID still matches;
an old close cannot remove a replacement's registration. Registration happens
before upgrade, so failed upgrades can leave a conservative target until expiry.
Expired targets are pruned during existing account cleanup. Failed close cleanup
can similarly leave harmless extra targets, without restoring authority.

Browser attachments survive hibernation; missing, revoked or expired attachments
are closed on wake. The alarm schedules the earlier of host liveness and browser
expiry, including when the host is offline. Every frame independently enforces
expiry, so a late alarm cannot extend authority. Existing single-connection-per-role
replacement and host presence generations remain in effect.

## Verification and load

Each upgrade and each forwarded browser input or host output adds an internal
AccountRegistry fetch and SQL authorization lookup. Positive results are not
cached between frames. This is separate from the existing zero-read/write host
presence path. Session registration/cleanup adds writes only at connection
boundaries; terminal output is never written to storage.

Regression coverage in `terminal-presence.test.mjs` includes both frame formats,
logout and reconnect rejection, pending input/output authorization and upgrade
races, idle expiry with/without hibernation, account lookup failure, retry after
notification failure, session replacement/isolation, stale host generation and
per-frame SQL accounting. Existing relay and host presence tests remain required.

Implementation-worktree checks:

- `cargo clippy -p oriel-relay --target wasm32-unknown-unknown --locked -- -D warnings`: passed.
- `cargo test -p oriel-relay --lib --locked --offline`: both Rust unit tests passed.
- TypeScript esbuild transforms, test JavaScript syntax and test injection anchors: passed.
- `npm ci --offline`: esbuild install validation was denied by the sandbox;
  `npm ci --offline --ignore-scripts` succeeded.
- `npm run build`: blocked because wasm-bindgen 0.2.129 is not installed in the
  available worker-build cache and its download cannot resolve the network host.
  Build output was therefore unavailable; the relay/presence Node test invocation
  failed and is not claimed as passing.

The trusted host must build and run `npm test` in `crates/oriel-relay` with its
normal cached build tools before publishing these commits. Review, merge and
release remain owner steps.
