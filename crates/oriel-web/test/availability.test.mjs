import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../src/main.rs', import.meta.url), 'utf8');
const script = source.split('const TERMINAL_JS: &str = r#"')[1]?.split('"#;')[0];
test('browser script parses', () => {
  assert.ok(script);
  new vm.Script(script);
});
const refresh = source.slice(source.indexOf('function refreshDevices() {'), source.indexOf('async function updateDevices() {'));
function harness() {
  let resolve, reject;
  const request = new Promise((yes, no) => { resolve = yes; reject = no; });
  const row = { device: { terminal_status: 'online' }, availability: {}, open: {} };
  const context = vm.createContext({ user: {}, deviceRefresh: null, accountEpoch: 1,
    updateDevices: () => request, currentAccount: epoch => context.accountEpoch === epoch,
    deviceRows: new Map([['a', row]]), deviceSummary: {}, errorText: String });
  vm.runInContext(refresh, context);
  return { context, row, resolve, reject };
}
test('manual and periodic refresh share one request', async () => {
  const { context, resolve } = harness();
  const first = context.refreshDevices();
  assert.equal(first, context.refreshDevices());
  resolve(); await first;
  assert.equal(context.deviceRefresh, null);
});
test('failed lookup retains row and disables terminal', async () => {
  const { context, row, reject } = harness();
  const pending = context.refreshDevices(); reject(new Error('lookup failed'));
  await assert.rejects(pending);
  assert.equal(context.deviceRows.size, 1);
  assert.equal(row.device.terminal_status, 'unknown');
  assert.equal(row.open.disabled, true);
});
test('old account failure cannot change current rows', async () => {
  const { context, row, reject } = harness();
  const pending = context.refreshDevices(); context.accountEpoch++;
  reject(new Error('old lookup')); await assert.rejects(pending);
  assert.equal(row.device.terminal_status, 'online');
});
