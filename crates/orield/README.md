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

The initial release targets Linux x86_64 with stable Rust. The package validation
workflow checks Ubuntu x86_64. The daemon contains Unix-specific code; other
OS/CPU combinations and a minimum Rust version are not covered by release checks.
Release acceptance checks installation and `--help`; it does not validate normal
startup, pairing, integrations, or workflow execution.

## Release preparation

The initial manifest inherits version `0.1.0` and MIT licensing from the workspace.
The release owner is `mikan-919`. Publication is restricted to crates.io. The
release script checks the crate's name/ownership and the exact version before
uploading, and verifies installation from crates.io afterward.

Versions are updated manually in the root `Cargo.toml` under
`[workspace.package]`; that changes the inherited version of all workspace
packages. Only `orield` is intended for publication. The dedicated workflow runs
formatting, Clippy, tests, packaging, a publishing dry run, and installation from
the unpacked package on relevant pull requests and main pushes. The existing
Web/relay deployment workflow is independent.

## Enable automatic publication (release owner)

Sign in to crates.io with the `mikan-919` GitHub account and verify the account's
email address. Create a token that can publish the new `orield` crate and future
versions. Keep the token out of source, command arguments and chat messages.

Create the GitHub environment `crates-io` and restrict its deployment branches to
`main`. Configure its secret
`ORIELD_CRATES_IO_TOKEN` with a crates.io token scoped to publishing `orield`, and
its variable `ORIELD_CRATES_IO_OWNER` with the exact crates.io owner login (user
or team). Supply these settings through the hosting UI; never put the token in
repository files or logs. This implementation uses a scoped token; rotate it
according to the owner's policy. For automatic publication, permit `main` in the
environment without a required reviewer. Finally set the repository variable
`ORIELD_RELEASE_ENABLED` to `true`. Leaving it unset keeps validation active
while publication is disabled.

After merging the workflow into `main`, perform the first publication with:

```sh
gh workflow run orield.yml --ref main -f publish=true
gh run list --workflow orield.yml --branch main --limit 1
gh run watch <run-id> --exit-status
```

The manual publication runs the same validation as automatic publication. Leave
the `publish` input false for validation only. Pull requests and non-main branches
cannot publish. Check the `Publish missing version and verify registry installation`
step and the job summary before treating a release as published.

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

For the next release, update `[workspace.package].version` in the root
`Cargo.toml` and the corresponding workspace entries in `Cargo.lock`, then merge
to `main`. A version bump is required for new code: a push with the same version
verifies the existing release without overwriting it. Re-run a failed publication
with the manual trigger above; already published versions are verified again.
