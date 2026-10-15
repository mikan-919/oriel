"""Offline tests: no registry access or publication is performed."""

import importlib.util
import json
import subprocess
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location(
    "release", Path(__file__).with_name("orield-release.py")
)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_only_404_means_missing(self):
        for status in (401, 403, 429, 500):
            with self.subTest(status=status), patch.object(
                release.urllib.request, "urlopen",
                side_effect=urllib.error.HTTPError("url", status, "error", {}, None),
            ):
                with self.assertRaises(urllib.error.HTTPError):
                    release.registry("crates/orield")
        with patch.object(release.urllib.request, "urlopen", side_effect=
                          urllib.error.HTTPError("url", 404, "missing", {}, None)):
            self.assertIsNone(release.registry("crates/orield"))

    def run_release(self, answers):
        return (
            patch.dict(release.os.environ, {
                "ORIELD_CRATES_IO_OWNER": "owner",
                "CARGO_REGISTRY_TOKEN": "test-placeholder",
            }, clear=True),
            patch.object(release, "registry", side_effect=answers),
            patch.object(release.subprocess, "check_output", return_value=json.dumps({
                "packages": [{"name": "orield", "version": "0.1.0"}],
            }).encode()),
            patch.object(release.subprocess, "run"),
            patch.object(release, "report"),
        )

    def test_existing_version_skips_publish_but_verifies(self):
        env, registry, metadata, run, report = self.run_release([
            {}, {"users": [{"login": "owner"}]}, {"version": {"yanked": False}},
        ])
        with env, registry as lookups, metadata, run as command, report as summary:
            command.return_value.returncode = 0
            release.main()
            self.assertEqual(
                [call.args[0] for call in lookups.call_args_list],
                ["crates/orield", "crates/orield/owners", "crates/orield/0.1.0"],
            )
            self.assertEqual(command.call_count, 2)
            self.assertEqual(command.call_args_list[0].args[0][:2], ["cargo", "install"])
            install_args = command.call_args_list[0].args[0]
            self.assertEqual(install_args[install_args.index("--version") + 1], "=0.1.0")
            for call in command.call_args_list:
                self.assertNotIn("CARGO_REGISTRY_TOKEN", call.kwargs["env"])
            help_call = command.call_args_list[1]
            self.assertEqual(
                Path(help_call.args[0][0]).parent.parent,
                Path(help_call.kwargs["cwd"]),
            )
            self.assertIn("Skipped", summary.call_args_list[0].args[0])

    def test_owner_conflict_stops_before_publish_or_install(self):
        env, registry, metadata, run, report = self.run_release([
            {}, {"users": [{"login": "someone-else"}]},
        ])
        with env, registry, metadata, run as command, report:
            with self.assertRaisesRegex(RuntimeError, "another owner"):
                release.main()
            command.assert_not_called()

    def test_missing_version_publishes_before_install(self):
        env, registry, metadata, run, report = self.run_release([None, None])
        with env, registry, metadata, run as command, report:
            command.return_value.returncode = 0
            release.main()
            self.assertEqual(command.call_args_list[0].args[0],
                             ["cargo", "publish", "-p", "orield", "--locked", "--registry", "crates-io"])
            self.assertEqual(command.call_count, 3)

    def test_team_owner_can_verify_existing_version(self):
        env, registry, metadata, run, report = self.run_release([
            {}, {"users": [{"login": "owner", "kind": "team"}]},
            {"version": {"yanked": False}},
        ])
        with env, registry, metadata, run as command, report:
            command.return_value.returncode = 0
            release.main()
            self.assertEqual(command.call_count, 2)
            self.assertEqual(command.call_args_list[0].args[0][:2], ["cargo", "install"])

    def test_owner_lookup_failure_stops_before_publication(self):
        env, registry, metadata, run, report = self.run_release([
            {},
            urllib.error.HTTPError("url", 500, "error", {}, None),
        ])
        with env, registry, metadata, run as command, report:
            with self.assertRaises(urllib.error.HTTPError):
                release.main()
            command.assert_not_called()

    def test_install_retries_are_bounded(self):
        env, registry, metadata, run, report = self.run_release([
            {}, {"users": [{"login": "owner"}]}, {"version": {"yanked": False}},
        ])
        with env, registry, metadata, run as command, report, patch.object(
            release.time, "sleep"
        ) as sleep:
            command.return_value.returncode = 1
            with self.assertRaisesRegex(RuntimeError, "installation failed"):
                release.main()
            self.assertEqual(command.call_count, 10)
            self.assertEqual(sleep.call_count, 9)
            sleep.assert_called_with(30)

    def test_yanked_version_stops_before_publish_or_install(self):
        env, registry, metadata, run, report = self.run_release([
            {}, {"users": [{"login": "owner"}]}, {"version": {"yanked": True}},
        ])
        with env, registry, metadata, run as command, report:
            with self.assertRaisesRegex(RuntimeError, "yanked"):
                release.main()
            command.assert_not_called()

    def test_publish_failure_does_not_attempt_install(self):
        env, registry, metadata, run, report = self.run_release([None, None])
        with env, registry, metadata, run as command, report as summary:
            command.side_effect = subprocess.CalledProcessError(1, "cargo publish")
            with self.assertRaises(subprocess.CalledProcessError):
                release.main()
            self.assertEqual(command.call_count, 1)
            self.assertIn("Publication failed", summary.call_args.args[0])

    def test_help_failure_is_reported_without_retrying_install(self):
        env, registry, metadata, run, report = self.run_release([
            {}, {"users": [{"login": "owner"}]}, {"version": {"yanked": False}},
        ])
        with env, registry, metadata, run as command, report as summary, patch.object(
            release.time, "sleep"
        ) as sleep:
            command.side_effect = [
                subprocess.CompletedProcess("cargo install", 0),
                subprocess.CalledProcessError(1, "orield --help"),
            ]
            with self.assertRaises(subprocess.CalledProcessError):
                release.main()
            self.assertEqual(command.call_count, 2)
            sleep.assert_not_called()
            self.assertIn("Registry verification failed", summary.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
