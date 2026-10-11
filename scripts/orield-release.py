"""CI-only release entry point; never treats registry failures as absence."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def registry(path):
    request = urllib.request.Request(
        "https://crates.io/api/v1/" + path,
        headers={"User-Agent": "orield-release (https://github.com/mikan-919/oriel)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def report(message):
    print(message, flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as output:
            output.write(message + "\n")


def main():
    owner = os.environ.get("ORIELD_CRATES_IO_OWNER", "")
    if not owner or not os.environ.get("CARGO_REGISTRY_TOKEN"):
        raise RuntimeError("Release owner and scoped crates.io token must be configured")
    metadata = json.loads(subprocess.check_output([
        "cargo", "metadata", "--no-deps", "--format-version", "1", "--locked",
    ]))
    version = next(p["version"] for p in metadata["packages"] if p["name"] == "orield")
    crate = registry("crates/orield")
    if crate is not None:
        owners = registry("crates/orield/owners")
        if owners is None or owner not in {user["login"] for user in owners["users"]}:
            raise RuntimeError("orield name belongs to another owner; human review required")
    existing = registry("crates/orield/" + version)
    if existing is not None:
        if existing["version"]["yanked"]:
            raise RuntimeError("Existing version is yanked; human review required")
        report(f"Skipped publication: orield {version} already exists.")
    else:
        try:
            subprocess.run(["cargo", "publish", "-p", "orield", "--locked"], check=True)
        except subprocess.CalledProcessError:
            report(f"Publication failed: orield {version}.")
            raise
        report(f"Published orield {version}.")

    # Keep authentication out of installation and help subprocesses.
    install_env = os.environ.copy()
    install_env.pop("CARGO_REGISTRY_TOKEN", None)
    for attempt in range(10):
        with tempfile.TemporaryDirectory(prefix="orield-registry-install-") as root:
            result = subprocess.run([
                "cargo", "install", "orield", "--locked", "--version", version,
                "--root", root,
            ], env=install_env)
            if result.returncode == 0:
                try:
                    subprocess.run([str(Path(root) / "bin" / "orield"), "--help"],
                                   env=install_env, check=True)
                except subprocess.CalledProcessError:
                    report(f"Registry verification failed: orield {version} --help.")
                    raise
                report(f"Registry installation and --help succeeded: orield {version}.")
                return
        if attempt < 9:
            time.sleep(30)
    report(f"Registry verification failed after 10 attempts: orield {version}.")
    raise RuntimeError("Registry installation failed")


if __name__ == "__main__":
    main()
