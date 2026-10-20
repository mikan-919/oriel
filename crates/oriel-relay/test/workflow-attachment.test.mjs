import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import { attachmentBytes, ATTACHMENT_LIMIT, reservedAttachment } from "../src/workflow-capacity.ts";

// Exercise workerd's actual structured-clone attachment limit, not JSON size.
test("reserved attachments at the admission boundary serialize in workerd", async () => {
  const worker = new Miniflare({ modules: true, compatibilityDate: "2026-10-01",
    durableObjects: { STORE: "Store" }, script: `
      export class Store {
        async fetch(request) {
          const pair = new WebSocketPair();
          pair[1].accept();
          try {
            const value = await request.json();
            pair[1].serializeAttachment(value);
            return Response.json(pair[1].deserializeAttachment());
          } finally { pair[1].close(); }
        }
      }
      export default { fetch(request, env) { return env.STORE.get(env.STORE.idFromName("test")).fetch(request); } };
    ` });
  const binding = { user_id: "u", device_id: "d", host_hash: "h", repository_generation: "r", github_generation: "g", linear_generation: "l", repository_id: 1, team_id: "t", repository: { owner: "owner", name: "repo" } };
  const admission = { kind: "implement", issue_number: 42, version: "a".repeat(64), branch: "work", linear_id: "id",
    task: { issue_number: 42, title: "Task", url: "https://example.test/42", how_identifier: null, how_url: null },
    execution: { target_oid: "a".repeat(40), base_branch: "main", verification: [] } };
  try {
    for (const atom of ["x", "文😀", '\"\n\\']) {
      let low = 0, high = ATTACHMENT_LIMIT;
      const candidate = n => reservedAttachment(binding, admission, [["printf", atom.repeat(n)]]);
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (attachmentBytes(candidate(middle)) <= ATTACHMENT_LIMIT) low = middle; else high = middle;
      }
      assert.ok(attachmentBytes(candidate(high)) > ATTACHMENT_LIMIT);
      for (const n of [low - 1, low]) {
        const value = candidate(n);
        const response = await worker.dispatchFetch("https://example.test", { method: "POST", body: JSON.stringify(value) });
        assert.equal(response.status, 200);
        // JSON transport omits undefined; compare the same wire representation.
        assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(value)));
      }
    }
    // Test the estimator's exact byte boundary independently of the grant's
    // even-sized duplicated strings. All accepted estimates must be storable.
    const escaped = "\n".repeat((ATTACHMENT_LIMIT - 18) / 2);
    for (const [value, delta] of [[escaped.slice(1) + "x", -1], [escaped, 0], [escaped + "x", 1]]) {
      assert.equal(attachmentBytes(value), ATTACHMENT_LIMIT + delta);
      if (delta > 0) continue;
      const response = await worker.dispatchFetch("https://example.test", { method: "POST", body: JSON.stringify(value) });
      assert.equal(response.status, 200);
      assert.equal(await response.json(), value);
    }
  } finally { await worker.dispose(); }
});
