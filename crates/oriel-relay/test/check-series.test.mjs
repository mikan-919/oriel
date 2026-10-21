import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const head = "2".repeat(40), oldHead = "8".repeat(40);
const context = { path: "/repos/owner/repo", repository: { repository_id: 501 }, team: { team_id: "team" }, check() {} };
function setup() {
  const scope = vm.createContext({ TextEncoder, TextDecoder, atob, btoa, crypto: webcrypto, digest: async value => hash(value), OID: /^[a-f0-9]{40}$/ });
  const source = stripTypeScriptTypes(readFileSync(new URL("../src/workflow-reader.ts", import.meta.url), "utf8"), { mode: "transform" });
  vm.runInContext(source.replace(/^import[\s\S]*?;/gm, "").replace(/^export /gm, "") + "\nglobalThis.Reader = WorkflowReader;", scope);
  const reader = new scope.Reader({ INTEGRATION_ENCRYPTION_KEY: "a".repeat(64) }, { fail(status, message) { throw new Error(`${status}: ${message}`); } });
  const runs = [], comments = [], statuses = [];
  reader.workflowGithub = async (_context, path) => path.includes("/pulls/")
    ? { number: 42, state: "open", draft: false, merged_at: null, mergeable: true,
      head: { ref: "work", sha: head, repo: { id: 501 } }, base: { ref: "main", sha: "1".repeat(40), repo: { id: 501 } } }
    : path.includes("/commits/")
    ? { check_runs: runs.filter(run => run.head_sha === path.split("/commits/")[1].split("/")[0]) }
    : runs.find(run => run.id === Number(path.split("/").at(-1))) ?? null;
  reader.workflowList = async (_context, path) => path.includes("/issues/") ? comments : path.endsWith("/statuses") ? statuses : [];
  const add = (overrides = {}) => {
    const run = { app: { id: 101 }, id: Math.max(0, ...runs.map(run => run.id)) + 1, name: "test", head_sha: head, status: "completed", conclusion: "failure", completed_at: "2026-01-01T00:00:00Z", output: {}, ...overrides };
    runs.push(run); return run;
  };
  const read = async requested => {
    const ci = {}, exhausted = [];
    const feedback = await reader.workflowFeedback(context, { number: 42, head_oid: head, branch: "work", base_branch: "main" }, "1".repeat(40), requested, exhausted, ci);
    return { feedback, ci: ci.value, exhausted };
  };
  const record = async key => comments.push({ created_at: "2026-02-01T00:00:00Z", body: await reader.workflowMarker(context, "response", key) + await reader.workflowMarker(context, "response-head", `${key}:${oldHead}`) });
  return { runs, statuses, comments, add, read, record };
}

test("App series select the latest current-head run independently of input order and reject stale keys", async () => {
  const s = setup(); s.add(); s.add({ app: { id: 202 }, conclusion: "success" });
  const first = await s.read();
  assert.equal(first.ci.status, "failure"); assert.equal(first.ci.checks.length, 2);
  assert.equal(first.feedback.key, `check:${hash(JSON.stringify(["check-run", 101, "test"]))}:1:${head}`);
  s.runs.reverse(); assert.equal((await s.read()).feedback.key, first.feedback.key);
  const rerun = s.add({ id: 3, conclusion: "success" });
  assert.equal((await s.read(first.feedback.key)).feedback, null);
  rerun.status = "queued"; rerun.conclusion = null;
  assert.equal((await s.read()).feedback, null); assert.equal((await s.read()).ci.status, "pending");
  rerun.head_sha = oldHead;
  assert.equal((await s.read()).feedback.key, first.feedback.key);
});

test("legacy signed attempts recover across heads, isolate apps and statuses, and fail closed when unavailable", async () => {
  const s = setup(); s.add(); const other = s.add({ app: { id: 202 }, conclusion: "success" });
  for (let id = 10; id < 13; id++) {
    s.add({ id, head_sha: oldHead }); await s.record(`check:${hash("test")}:${id}:${oldHead}`);
  }
  assert.equal((await s.read()).feedback, null);
  other.conclusion = "failure";
  assert.equal((await s.read()).feedback.key.split(":")[2], "2");
  other.conclusion = "success";
  s.statuses.push({ id: 1, context: "test", state: "failure", created_at: "2026-01-01T00:00:00Z" });
  assert.match((await s.read()).feedback.key, /:status-1:/);
  s.statuses.length = 0;
  for (const conclusion of ["success", "neutral", "skipped"]) {
    s.add({ conclusion, completed_at: "2099-01-01T00:00:00Z" }); const failure = s.add();
    assert.equal((await s.read()).feedback.key.split(":")[2], String(failure.id));
  }
  s.runs.find(run => run.id === 10).app = null;
  assert.equal((await s.read()).feedback, null); assert.match((await s.read()).exhausted.join(), /history origin unavailable/);
  s.comments.length = 0; s.runs.length = 0; s.add({ app: null });
  assert.equal((await s.read()).ci.status, "failure"); assert.equal((await s.read()).feedback, null);
  assert.match((await s.read()).exhausted.join(), /App ID unavailable/);
});

test("new series keys and legacy aliases count once while status attempts never consume check attempts", async () => {
  const s = setup(); s.add();
  for (let id = 10; id < 12; id++) {
    s.add({ id, head_sha: oldHead });
    await s.record(`check:${hash("test")}:${id}:${oldHead}`);
    await s.record(`check:${hash(JSON.stringify(["check-run", 101, "test"]))}:${id}:${oldHead}`);
  }
  for (let id = 1; id <= 3; id++) await s.record(`check:${hash("test")}:status-${id}:${oldHead}`);
  assert.ok((await s.read()).feedback, "Two unique check attempts remain below the limit");
  s.add({ id: 12, head_sha: oldHead });
  await s.record(`check:${hash(JSON.stringify(["check-run", 101, "test"]))}:12:${oldHead}`);
  assert.equal((await s.read()).feedback, null);
  assert.match((await s.read()).exhausted.join(), /3 verified attempts/);
});
