import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { connect, device, hostHeaders, origin, pair, runtime } from "./helpers.mjs";
import { workflowFixture } from "./workflow-fixture.mjs";

// This measures the production implementation with all three connections.
// The previous design measurements remain in usage-measurement.json.
test("Continuous usage with workflow, dashboard and terminal connections", async () => {
  const report = {};
  const accountSource = await readFile(new URL("../src/account.ts", import.meta.url), "utf8");
  const integrationSource = await readFile(new URL("../src/integrations.ts", import.meta.url), "utf8");
  const schema = /this\.sql\.exec\(`([\s\S]*?)`\)/.exec(accountSource)?.[1];
  const integrationSchema = /sql\.exec\(`([\s\S]*?)`\)/.exec(integrationSource)?.[1];
  assert.ok(schema && integrationSchema, "Constructor SQL probe must match the source");
  // A multi-statement cursor reports the final statement. Measure each
  // initialization statement separately rather than omit prior row scans.
  const initializationQueries = [schema, "PRAGMA table_info(devices)", integrationSchema]
    .flatMap(query => query.split(";").map(statement => statement.trim()).filter(Boolean));
  for (const [name, mode] of [["implemented", true]]) {
    const fixture = workflowFixture();
    let outbound = 0;
    const worker = await runtime(fixture.env, request => { outbound++; return fixture.fetch(request); }, mode);
    const sockets = [];
    try {
      const { owner, daemon } = await pair(worker);
      await connect(owner, fixture, "github");
      await connect(owner, fixture, "linear");
      assert.equal((await daemon.api(`/api/integrations/${device}/repository`, { repository: fixture.repository }, hostHeaders)).status, 200);
      const how = fixture.addHow("Todo");
      for (let number = 43; number < 90; number++) fixture.issues.push({ ...fixture.issues[0], number,
        node_id: `I_${number}`, html_url: `https://github.com/octocat/connected/issues/${number}` });
      const cookie = [...owner.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
      const upgrade = async (path, headers) => {
        const response = await worker.dispatchFetch(`${origin}${path}`, { headers: { ...headers, Upgrade: "websocket" } });
        assert.equal(response.status, 101);
        response.webSocket.accept();
        sockets.push(response.webSocket);
        return response.webSocket;
      };
      const host = await upgrade(`/api/workflows/${device}/connect`, hostHeaders);
      const codex = await upgrade(`/api/codex/${device}/host`, hostHeaders);
      const progress = await upgrade("/api/workflow-progress/connect", { Origin: origin, Cookie: cookie });
      const shared = [];
      progress.addEventListener("message", event => {
        const value = JSON.parse(event.data);
        if (value.type === "workflow-snapshot") shared.push(value);
      });
      progress.send("ready:state");
      // Terminal is a separate daemon/process; its presence KV is outside the
      // AccountRegistry SQL cursor counters reported below.
      const terminal = await upgrade(`/device/${device}/host`, hostHeaders);
      terminal.addEventListener("message", event => {
        if (typeof event.data === "string" && event.data.startsWith("oriel-heartbeat:")) terminal.send(event.data);
      });
      const namespace = await worker.getDurableObjectNamespace("ACCOUNTS");
      const account = namespace.get(namespace.idFromName("accounts"));
      const settle = () => new Promise(resolve => setTimeout(resolve, 20));
      let sequence = 0;
      const rpc = payload => new Promise((resolve, reject) => {
        const request_id = `usage-${++sequence}`;
        const timer = setTimeout(() => { host.removeEventListener("message", listener); reject(Error("Usage RPC timed out")); }, 10000);
        const listener = event => {
          if (event.data === "oriel:pong") return;
          const value = JSON.parse(event.data);
          if (value.request_id !== request_id) return;
          clearTimeout(timer); host.removeEventListener("message", listener); resolve(value);
        };
        host.addEventListener("message", listener);
        host.send(JSON.stringify({ ...payload, request_id }));
      });
      const full = await rpc({ type: "snapshot", changes: true });
      const row = full.snapshot.workflows.find(row => row.issue.number === 42);
      const admitted = await rpc({ type: "claim", kind: "implement", issue_number: 42, version: row.version, branch: row.branch });
      assert.equal(admitted.type, "granted");
      const started = await daemon.api(`/api/workflows/${device}/actions`, { lease_id: admitted.lease_id, action: "begin" }, hostHeaders);
      assert.equal(started.status, 200);
      assert.equal(how.state.name, "In Progress");
      const snapshot = async () => {
        const result = await rpc({ type: "snapshot", changes: true, lease_id: admitted.lease_id });
        assert.equal(result.type, "snapshot", JSON.stringify(result));
        return result;
      };
      const samples = {};
      const measure = async (label, operation) => {
        await settle();
        const before = await account.costForTest(), beforeOutbound = outbound;
        const result = await operation();
        await settle();
        const after = await account.costForTest();
        samples[label] = { rowsRead: after.reads - before.reads, rowsWritten: after.writes - before.writes,
          alarmSets: after.alarmSets - before.alarmSets, providerRequests: outbound - beforeOutbound };
        return result;
      };
      await snapshot();
      const running = await measure("activeSnapshot", snapshot);
      assert.equal(running.snapshot.workflows[0].phase, "running");
      assert.equal(shared.at(-1).device_id, device);
      assert.equal(shared.at(-1).issue_number, 42);
      assert.deepEqual(shared.at(-1).snapshot, running.snapshot, "WebSocket checks still supply the dashboard snapshot");
      await measure("activeSnapshotRepeat", snapshot);
      assert.deepEqual(samples.activeSnapshot, samples.activeSnapshotRepeat);
      const page = await measure("webList", () => owner.api(`/api/workflows/${device}`));
      assert.equal(page.status, 200);
      await measure("webListRepeat", () => owner.api(`/api/workflows/${device}`));
      assert.deepEqual(samples.webList, samples.webListRepeat);
      assert.ok(samples.webList.providerRequests <= 50, "The 48-issue listing must fit the Free external request limit");
      await measure("devicesList", () => owner.api("/api/devices"));
      await measure("devicesListRepeat", () => owner.api("/api/devices"));
      await measure("codexOutput", async () => codex.send(JSON.stringify({ type: "event", engine: "usage", message: { method: "item/agentMessage/delta", params: { delta: "x" } } })));
      await measure("deadlineAlarm", () => account.alarmForTest());
      await account.clearAuthRowsForTest();
      await measure("activeSnapshotCold", snapshot);
      await measure("constructorSqlReplay", () => account.replayConstructorSqlForTest(initializationQueries));
      await measure("activeSnapshotAfterConstructorSql", snapshot);
      await measure("devicesListAfterConstructorSql", () => owner.api("/api/devices"));
      how.state = { ...fixture.states.find(state => state.name === "Triage") };
      assert.equal((await snapshot()).snapshot.workflows[0].phase, "triage", "Native approval must never be cached");
      await settle();
      assert.equal(shared.at(-1).snapshot.workflows[0].phase, "triage");
      // The prototype must observe writes through the actual account path;
      // it cannot keep serving the selected repository after disconnection.
      const disconnected = await owner.api("/api/integrations/linear/disconnect", {});
      assert.equal(disconnected.status, 200);
      const denied = await owner.api(`/api/workflows/${device}`);
      assert.notEqual(denied.status, 200);
      await account.shortenSessionsForTest();
      assert.notEqual((await owner.api("/api/session")).data.user, null);
      await new Promise(resolve => setTimeout(resolve, 2100));
      assert.equal((await owner.api("/api/session")).data.user, null, "Cached sessions must expire without another write");
      await account.expireSessionsForTest();
      assert.equal((await owner.api("/api/session")).data.user, null);
      report[name] = samples;
    } finally {
      for (const socket of sockets) try { socket.close(); } catch { /* Closed by revocation. */ }
      await worker.dispose();
    }
  }
  assert.equal(report.implemented.activeSnapshot.rowsRead, 0);
  assert.equal(report.implemented.codexOutput.rowsRead, 0);
  console.log("Continuous usage SQL measurements:", JSON.stringify(report));
  if (process.env.ORIEL_USAGE_REPORT) await writeFile(process.env.ORIEL_USAGE_REPORT, `${JSON.stringify(report, null, 2)}\n`);
});
