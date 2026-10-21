# WebSocket attachment capacity verification

The control attachment keeps the complete grant, approved verification commands,
and target commit. Admission reserves both command copies, progress metadata,
paused task metadata and mutable scalar fields against the 16,384 byte limit.
Claims and reservations share the persisted grant constructor. A regression test
checks implement, respond (including feedback), and plan grant shapes.

Verification on 2026-10-21 after integrating source base
`b641f869b2fbd449bd9201c0c6f2aec2bdc726c6`:

- `node --test crates/oriel-relay/test/workflow-capacity.test.mjs`: passed.
- `cargo clippy --offline --all-targets`: passed.
- Relay `npm test`: attempted; runtime suites cannot load missing npm dependencies.
- Relay `npm run build`: attempted; `cf` is unavailable.
- Offline npm installation for Relay and Web was attempted, including the
  repository-configured cache. Both lack the cached `zod-4.4.3.tgz` dependency.

Host verification must restore dependencies and run the full Relay suite and
build, including the workerd serialization boundary and hibernation tests.
No external deployment was performed.
