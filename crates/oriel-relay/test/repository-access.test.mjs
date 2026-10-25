import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

test("repository access stops on a match and fails closed on missing or failed pages", async () => {
  const full = Array.from({length: 100}, (_, id) => ({id: id + 100}));
  for (const [pages, expected, status] of [
    [[[{id: 42}, ...full.slice(1)], null], 1, null],
    [[full, [{id: 42}]], 2, null],
    [[full, []], 2, 403],
    [[full, null], 2, 502],
  ]) {
    let reads = 0, snapshots = 0;
    const context = vm.createContext({TextEncoder, fetch: async () => {
      const rows = pages[reads++];
      return rows ? Response.json({repositories: rows}) : new Response(null, {status: 503});
    }});
    const source = stripTypeScriptTypes(readFileSync(new URL("../src/workflow-reader.ts", import.meta.url), "utf8"), {mode: "transform"});
    vm.runInContext(source.replace(/^import[\s\S]*?;/gm, "").replace(/^export /gm, "") + "\nglobalThis.Reader = WorkflowReader;", context);
    const reader = new context.Reader({}, {fail(status) { throw Object.assign(new Error(), {status}); }});
    reader.snapshot = async () => { snapshots++; return {}; };
    const result = reader.read({context: {repository: {installation_id: 1, repository_id: 42}}, github_user: "fixture"});
    if (status) await assert.rejects(result, {status}); else await result;
    assert.equal(reads, expected);
    assert.equal(snapshots, status ? 0 : 1);
  }
});
