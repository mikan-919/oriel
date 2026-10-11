"""Offline tests: no registry access or publication is performed."""

import importlib.util
import json
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
        with env, registry, metadata, run as command, report as summary:
            command.return_value.returncode = 0
            release.main()
            self.assertEqual(command.call_count, 2)
            self.assertEqual(command.call_args_list[0].args[0][:2], ["cargo", "install"])
            for call in command.call_args_list:
                self.assertNotIn("CARGO_REGISTRY_TOKEN", call.kwargs["env"])
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
                             ["cargo", "publish", "-p", "orield", "--locked"])
            self.assertEqual(command.call_count, 3)

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


if __name__ == "__main__":
    unittest.main()
