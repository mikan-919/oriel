import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/main.rs", import.meta.url), "utf8");
const refresh = source.slice(source.indexOf("async function refreshDevices()"), source.indexOf("async function inspectPair()"));
function screen(api) {
  const context = vm.createContext({ api, clearTimeout, user: { id: "owner" }, accountEpoch: 1,
    deviceRefresh: null, deviceListFailed: false, devices: [], deviceRows: new Map(),
    progressSnapshot: new Map(), repositoryDeviceId: "a", repositoryRequest: 0,
    workflowSnapshot: { task: "retained" }, repositoryIssues: { replaceChildren() {} },
    repositoryDetails: {}, repositoryStatus: {}, deviceSummary: {}, deviceList: { append() {} },
    busy: false, pairClaimed: false, pairInfo: null, pairOwner: { id: "owner" }, pairing: {}, pairStatus: {},
    currentAccount(epoch) { return context.accountEpoch === epoch && !!context.user; },
    renderProgressCards() {},
    createDeviceRow(device) { return { device, item: { remove() {} }, label: {}, repository: {}, open: {}, work: {} }; },
  });
  vm.runInContext(refresh, context);
  return context;
}
const registration = status => ({ device_id: "a", name: "host", repository: null, terminal_status: status });
test("offline registration preserves workflow and selection; online enables terminal", async () => {
  let state = "offline";
  const c = screen(async () => ({ devices: [registration(state)] }));
  await c.refreshDevices();
  const row = c.deviceRows.get("a");
  assert.match(row.label.textContent, /使用不可/);
  assert.equal(row.open.disabled, true);
  assert.equal(c.repositoryDeviceId, "a");
  assert.equal(c.workflowSnapshot.task, "retained");
  state = "online";
  await c.refreshDevices();
  assert.equal(c.deviceRows.get("a"), row);
  assert.equal(row.open.disabled, false);
});
test("grace and unknown disable terminal", async () => {
  for (const state of ["grace", "unknown"]) {
    const c = screen(async () => ({ devices: [registration(state)] }));
    await c.refreshDevices();
    assert.equal(c.deviceRows.get("a").open.disabled, true);
    assert.match(c.deviceRows.get("a").label.textContent, state === "grace" ? /再接続中/ : /状態確認中/);
  }
});
test("failed refresh retains rows and disables terminal", async () => {
  let fail = false;
  const c = screen(async () => { if (fail) throw Error("failed"); return { devices: [registration("online")] }; });
  await c.refreshDevices();
  fail = true;
  await assert.rejects(c.refreshDevices());
  assert.equal(c.deviceRows.size, 1);
  assert.equal(c.deviceRows.get("a").open.disabled, true);
  assert.equal(c.workflowSnapshot.task, "retained");
});
test("requests coalesce and stale account responses do not change screen", async () => {
  let resolve, calls = 0;
  const c = screen(() => { calls++; return new Promise(done => { resolve = done; }); });
  const first = c.refreshDevices();
  const second = c.refreshDevices();
  assert.equal(calls, 1);
  c.accountEpoch++;
  resolve({ devices: [registration("online")] });
  await Promise.all([first, second]);
  assert.equal(c.deviceRows.size, 0);
});
test("offline registration completes pairing without promising terminal availability", async () => {
  const c = screen(async () => ({ devices: [registration("offline")] }));
  c.pairClaimed = true;
  c.pairInfo = { device_id: "a" };
  c.pairing.token = "pending";
  c.pairTimer = 0;
  await c.refreshDevices();
  assert.equal(c.pairing.token, null);
  assert.doesNotMatch(c.pairStatus.textContent, /now open/);
});

test("shared refresh expires pending pairing", async () => {
  const c = screen(async () => ({ devices: [] }));
  c.pairClaimed = true;
  c.pairInfo = { device_id: "a", expires_at: 0 };
  c.pairing.token = "pending";
  await c.refreshDevices();
  assert.equal(c.pairing.token, null);
  assert.match(c.pairStatus.textContent, /expiry/);
});
