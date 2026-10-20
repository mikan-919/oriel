import assert from "node:assert/strict";
import { serialize } from "node:v8";
import test from "node:test";
import { attachmentBytes, ATTACHMENT_LIMIT, capacityError } from "../src/workflow-capacity.ts";

const binding = { user_id: "u", device_id: "d", host_hash: "h", repository_generation: "r", github_generation: "g", linear_generation: "l", repository_id: 1, team_id: "t", repository: { owner: "owner", name: "repo" } };
const admission = commands => ({ kind: "implement", issue_number: 42, version: "a".repeat(64), branch: "work", linear_id: "id", task: { issue_number: 42, title: "Task", url: "https://example.test/42", how_identifier: null, how_url: null }, execution: { target_oid: "a".repeat(40), base_branch: "main", verification: commands } });

test("conservative attachment estimate covers V8 strings, escaping and array overhead", () => {
  for (const value of ["日本語😀".repeat(100), '\"\n\\'.repeat(100), Array.from({length: 1024}, () => ["x"]), binding, admission([["true"]])]) {
    assert.ok(attachmentBytes(value) >= serialize(value).length);
  }
  const escaped = "\n".repeat((ATTACHMENT_LIMIT - 18) / 2);
  for (const delta of [-1, 0, 1]) {
    const value = delta === -1 ? escaped.slice(1) + "x" : escaped + (delta === 1 ? "x" : "");
    assert.equal(attachmentBytes(value), ATTACHMENT_LIMIT + delta);
    assert.ok(serialize(value).length <= ATTACHMENT_LIMIT);
  }
});

test("reservation rejects oversized configuration and metadata and has a stable boundary", () => {
  assert.equal(capacityError(binding, admission([["true"]])), null);
  assert.match(capacityError(binding, admission([["printf", "x".repeat(20000)]])), /available .* used .*16384/);
  const largeTask = admission([["true"]]); largeTask.task.title = "文".repeat(20000);
  assert.match(capacityError(binding, largeTask), /task\/binding metadata/);
  for (const atom of ["x", "文", '\"\n', "😀"]) {
    let n = 0;
    while (capacityError(binding, admission([[atom.repeat(n + 1) || "x"]])) === null) n++;
    assert.equal(capacityError(binding, admission([[atom.repeat(n)]])), null);
    assert.ok(capacityError(binding, admission([[atom.repeat(n + 1)]])));
  }
});
