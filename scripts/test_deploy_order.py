"""Offline deployment ordering checks; no production credentials or services."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / 'scripts/check-deploy-head.sh'


class DeploymentOrder(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.git('init', '--bare', 'origin.git')
        self.git('init', 'checkout')
        self.checkout = self.repo / 'checkout'
        self.git('-C', str(self.checkout), 'remote', 'add', 'origin', str(self.repo / 'origin.git'))
        # Real commit objects and refs, without user identity or hooks.
        tree = self.git('--git-dir', str(self.repo / 'origin.git'), 'mktree', input='').strip()
        self.a = self.commit(tree, 'A')
        self.b = self.commit(tree, 'B', self.a)
        self.publish(self.a)
        self.calls = []

    def git(self, *args, input=None):
        return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', *args],
                                       cwd=self.repo, input=input, text=True, stderr=subprocess.DEVNULL)

    def commit(self, tree, message, parent=None):
        env = dict(os.environ, GIT_AUTHOR_NAME='Test', GIT_AUTHOR_EMAIL='test@example.invalid',
                   GIT_COMMITTER_NAME='Test', GIT_COMMITTER_EMAIL='test@example.invalid')
        args = ['git', '-c', 'core.hooksPath=/dev/null', 'commit-tree', tree]
        if parent:
            args += ['-p', parent]
        return subprocess.check_output(args, cwd=self.repo / 'origin.git', env=env, input=message, text=True).strip()

    def publish(self, sha):
        self.git('--git-dir', str(self.repo / 'origin.git'), 'update-ref', 'refs/heads/main', sha)

    def check(self, sha, **extra):
        output = self.repo / 'output'
        output.write_text('')
        env = dict(os.environ, DEPLOY_SHA=sha, GITHUB_OUTPUT=str(output), **extra)
        result = subprocess.run(['bash', str(CHECK)], cwd=self.checkout, env=env,
                                capture_output=True, text=True)
        return result, output.read_text() == 'deploy=true\n'

    def deploy(self, sha, fail=None, after_relay=None):
        result, allowed = self.check(sha)
        if result.returncode or not allowed:
            return
        for target in ['Relay', 'Web']:
            self.calls.append((sha, target))  # Deployment stub.
            if target == fail:
                return
            if target == 'Relay' and after_relay:
                after_relay()

    def test_delayed_old_run_and_rerun(self):
        self.publish(self.b)
        self.deploy(self.a)
        self.deploy(self.b)
        self.deploy(self.a)
        self.assertEqual(self.calls, [(self.b, 'Relay'), (self.b, 'Web')])
        result, allowed = self.check(self.a)
        self.assertFalse(allowed)
        self.assertIn('Skipping stale deployment ' + self.a, result.stdout)

    def test_new_head_during_deployment_finishes_pair(self):
        # The job lock admits the next run only after this pair completes.
        self.deploy(self.a, after_relay=lambda: self.publish(self.b))
        self.deploy(self.b)
        self.assertEqual(self.calls, [(s, t) for s in [self.a, self.b] for t in ['Relay', 'Web']])

    def test_relay_failure_stops_web(self):
        self.deploy(self.a, fail='Relay')
        self.assertEqual(self.calls, [(self.a, 'Relay')])

    def test_transport_failure_blocks(self):
        self.git('-C', str(self.checkout), 'remote', 'set-url', 'origin', str(self.repo / 'missing'))
        result, allowed = self.check(self.a)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(allowed)

    def test_invalid_deployment_sha_blocks(self):
        for sha in ['', 'invalid', self.a + '\n', 'a' * 39]:
            with self.subTest(sha=sha):
                result, allowed = self.check(sha)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(allowed)
                self.assertIn('Invalid deployment SHA', result.stderr)

    def test_transport_diagnostics_are_not_logged(self):
        stub = self.repo / 'bin'
        stub.mkdir()
        git = stub / 'git'
        git.write_text('#!/bin/sh\necho sensitive-transport-diagnostic >&2\nexit 1\n')
        git.chmod(0o755)
        result, allowed = self.check(self.a, PATH=str(stub) + ':' + os.environ['PATH'])
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(allowed)
        self.assertIn('Failed to retrieve main head', result.stderr)
        self.assertNotIn('sensitive-transport-diagnostic', result.stdout + result.stderr)

    def test_empty_malformed_and_multiple_responses_block(self):
        stub = self.repo / 'bin'
        stub.mkdir()
        git = stub / 'git'
        for response in ['', 'invalid', self.a + '\trefs/heads/other',
                         (self.a + '\trefs/heads/main\n') * 2]:
            with self.subTest(response=response):
                git.write_text('#!/bin/sh\ncat <<\'RESPONSE\'\n' + response + '\nRESPONSE\n')
                git.chmod(0o755)
                result, allowed = self.check(self.a, PATH=str(stub) + ':' + os.environ['PATH'])
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(allowed)

    def test_workflow_failures_stop_all_later_steps(self):
        # Interpret the workflow's implicit success() and explicit output gate.
        # Stub all service/build commands; execute the real head check locally.
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        steps = [s for s in workflow.split('      - ') if s.startswith('name: ')]
        for failure in ['Build Relay', 'Verify authentication boundaries',
                        'Check main head before deployment',
                        'Deploy Relay before its Browser client', 'Build Browser']:
            with self.subTest(failure=failure):
                succeeded, allowed, deployed = True, False, []
                for step in steps:
                    name = step.splitlines()[0].removeprefix('name: ')
                    if not succeeded:
                        continue
                    if "if: steps.deploy-head.outputs.deploy == 'true'" in step and not allowed:
                        continue
                    if name == failure:
                        succeeded = False
                        continue
                    if name == 'Check main head before deployment':
                        result, allowed = self.check(self.a)
                        succeeded = result.returncode == 0
                    if 'run: npm run deploy:prebuilt' in step:
                        deployed.append(name)
                expected = (['Deploy Relay before its Browser client']
                            if failure == 'Build Browser' else [])
                self.assertEqual(deployed, expected)

    def test_workflow_lock_and_success_conditions(self):
        text = (ROOT / '.github/workflows/ci.yml').read_text()
        self.assertIn('  deploy:\n    concurrency:\n      group: production-cloudflare-apps\n      cancel-in-progress: false\n', text)
        self.assertNotIn('always()', text)
        self.assertNotIn('continue-on-error', text)
        steps = text.split('      - ')
        names = ['Build Relay', 'Verify authentication boundaries', 'Check main head before deployment',
                 'Deploy Relay before its Browser client', 'Install Browser dependencies', 'Build Browser', 'Deploy Browser']
        positions = [text.index('name: ' + name + '\n') for name in names]
        self.assertEqual(positions, sorted(positions))
        for name in names[3:]:
            step = next(s for s in steps if s.startswith('name: ' + name + '\n'))
            self.assertIn("        if: steps.deploy-head.outputs.deploy == 'true'\n", step)
        head = next(s for s in steps if s.startswith('name: Check main head before deployment\n'))
        self.assertIn('working-directory: .\n', head)
        self.assertIn('DEPLOY_SHA: ${{ github.sha }}', head)
        self.assertIn('run: bash scripts/check-deploy-head.sh', head)


if __name__ == '__main__':
    unittest.main()
