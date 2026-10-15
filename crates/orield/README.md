# orield

`orield` connects local Codex sessions to Oriel's browser and relay services.
Codex and a running Oriel Web/relay deployment are required separately; installing
this crate does not install or deploy them. Workflow features also require the
GitHub and Linear integrations to be configured.

`orield workflow` keeps HOW planning read-only and requires human approval in
Linear Todo plus repository opt-in before implementation. Approved implementation
uses Codex's `auto_review` reviewer with the `on-request` approval policy, so
eligible execution requests are reviewed automatically. Sandbox boundaries still
apply; rejected actions and questions requiring a human decision can still block
progress. The installed `codex` must support `auto_review`. Read-only planning and
manual conversations continue to use the user reviewer.

Once a version has been published to crates.io, install without a checkout:

```sh
cargo install orield --locked --version '=0.1.0'
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

## Enable automatic publication (release owner)

First publication and CI execution are owner tasks after repository review.
Confirm 0.1.0, MIT, supported OS/CPU and Rust version, and record the named
release/version-update owner before enabling publication. CI currently validates
Ubuntu x86_64 with stable Rust; no minimum Rust version is promised.

Create the GitHub environment `crates-io`. Configure its secret
`ORIELD_CRATES_IO_TOKEN` with a crates.io token scoped to publishing `orield`, and
its variable `ORIELD_CRATES_IO_OWNER` with the exact crates.io owner login (user
or team). Supply these settings through the hosting UI; never put the token in
repository files or logs. This implementation uses a scoped token; rotate it
according to the owner's policy. For automatic publication, permit main in the
environment without a required reviewer. Finally set the repository variable
`ORIELD_RELEASE_ENABLED` to `true`. Leaving it unset keeps validation active
while publication is disabled.

Every relevant main push then publishes after validation, serialized across
release jobs. The script checks existing crate ownership and the exact version
immediately before publishing. An ownership conflict, lookup failure, or yanked
version fails the job; an existing version skips publication successfully. A
404 does not reserve the name: a competing first publication can still make
`cargo publish` fail, requiring owner review. Only `orield` is published.

Both new and skipped versions undergo registry installation in an empty install
root with an exact version requirement and `--help` verification. This prevents
verification from installing a newer release instead of the version just checked.
Installation is retried at most ten times, with
30 seconds between attempts. Job summaries distinguish publication, publication
failure, skip, and registry verification failure. Initial lookup errors also fail
the job with their diagnostic. After the first enabled main push, check these
results and rerun the publish job at the same version to confirm the skip path.
A failed verification after successful publication cannot undo the release;
rerun verification and investigate before changing the version.

Manually update the workspace version for the next release through review.
Use the workflow's manual trigger to rerun validation only; manual runs and pull
requests never publish. Re-run failed main-push jobs from the hosting UI when
needed, including to verify an already published version.
