import assert from "node:assert/strict";
import { serialize } from "node:v8";
import test from "node:test";
import { attachmentBytes, ATTACHMENT_LIMIT, capacityError, reservedAttachment, workflowGrant } from "../src/workflow-capacity.ts";

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


test("full reservation includes both command copies and dominates persisted lifecycle states", () => {
  for (const commands of [[["true"]], [["printf", "文😀\\\"\n".repeat(100)]], Array.from({ length: 40 }, () => ["x"])]) {
    const grant = admission(commands);
    grant.task.title = "長い task".repeat(40);
    const reserved = reservedAttachment(binding, grant);
    assert.equal(capacityError(binding, grant), null);
    assert.ok(attachmentBytes(reserved) >= serialize(reserved).length);
    const active = { ...reserved, task: null, stage: "verifying" };
    const paused = { ...reserved, grant: null, stage: "paused" };
    for (const state of [active, paused]) {
      assert.ok(attachmentBytes(state) <= attachmentBytes(reserved));
      assert.ok(serialize(state).length <= ATTACHMENT_LIMIT);
    }
    assert.deepEqual(reserved.grant.execution.verification, commands);
    assert.deepEqual(reserved.verification.commands, commands);
    assert.equal(reserved.verification.target_oid, grant.execution.target_oid);
  }
});


test("claim grant and reserved grant preserve identical execution and feedback fields", () => {
  for (const kind of ["implement", "respond", "plan"]) {
    const value = { ...admission([["printf", "文😀\\\"\n"]]), kind };
    if (kind === "plan") delete value.execution;
    if (kind === "respond") value.feedback = { key: "feedback", head_oid: "b".repeat(40), pr_number: 90 };
    const lease = "f".repeat(36);
    const claimed = workflowGrant(value, lease);
    assert.deepEqual(reservedAttachment(binding, value).grant, claimed);
    assert.deepEqual(claimed, { ...value, lease_id: lease });
    assert.equal(Object.hasOwn(claimed, "execution"), kind !== "plan");
  }
});
