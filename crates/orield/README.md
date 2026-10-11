# orield

`orield` connects local Codex sessions to Oriel's browser and relay services.
Codex and a running Oriel Web/relay deployment are required separately; installing
this crate does not install or deploy them. Workflow features also require the
GitHub and Linear integrations to be configured.

Once a version has been published to crates.io, install without a checkout:

```sh
cargo install orield --locked --version 0.1.0
orield --help
```

For a source checkout before publication:

```sh
cargo install --path crates/orield --locked
orield --help
```

The package validation workflow checks Ubuntu x86_64 with stable Rust. This is a
validation environment, not a promise of support for other environments or a
minimum Rust version. The daemon contains Unix-specific code. Supported OS/CPU
combinations and the minimum Rust version still need a release-owner decision.
Release acceptance checks installation and `--help`; it does not validate normal
startup, pairing, integrations, or workflow execution.

## Release preparation

The current manifest inherits version `0.1.0` and MIT licensing from the workspace.
Before the first release, confirm these values, supported environments, the
release owner, and the CI authentication method. Do not publish until those
decisions and the crates.io name/ownership check have been completed.

Versions are updated manually in the root `Cargo.toml` under
`[workspace.package]`; that changes the inherited version of all workspace
packages. Only `orield` is intended for publication. The dedicated workflow runs
formatting, Clippy, tests, packaging, a publishing dry run, and installation from
the unpacked package on relevant pull requests and main pushes. The existing
Web/relay deployment workflow is independent.

Automatic publication is pending the release decisions above. Its required
behavior is to serialize main-push releases after successful validation, query
the exact version immediately before publishing, skip an existing version, and
fail on lookup errors rather than treating them as absence. A name conflict must
stop the release for human review. After publication, verify registry installation
and `--help` in an empty install root, allowing at most ten attempts separated by
30 seconds for registry propagation. Re-run the same version to verify the skip
path. Record publication failure, post-publication verification failure, and skip
separately. Re-run validation through the workflow's manual trigger when needed;
manual validation does not publish.
