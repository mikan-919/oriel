import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("WHAT validates UTF-16 limits before sending, keeps invalid input, and explains planning", async () => {
  const source = readFileSync(new URL("../src/assets/dashboard.js", import.meta.url), "utf8");
  for (const unit of ["a", "日", "😀"]) for (const field of ["title", "body"]) for (const overflow of [false, true]) {
    const limit = field === "title" ? 256 : 60000;
    const value = unit.repeat(limit / unit.length) + (overflow ? "a" : "");
    let calls = 0, message;
    const c = vm.createContext({user: {}, pendingWhat: null, repositoryDeviceId: "device", workflowSnapshot: {}, accountEpoch: 1,
      whatTitle: {value: field === "title" ? value : "Title"}, whatBody: {value: field === "body" ? value : "Body"},
      crypto: {randomUUID: () => "request"}, currentAccount: () => true, refreshWorkflow: async () => {},
      document: {getElementById: () => ({close() {}})}, status: {replaceChildren(...parts) {message = parts;}},
      issueLink: (label, url) => ({label, url}), integrationApi: async () => { calls++; return {issue: {number: 42, url: "https://github.com/example/repo/issues/42"}}; }});
    vm.runInContext(source.slice(source.indexOf("async function createWhat()"), source.indexOf("function sendResize()")), c);
    if (overflow) {
      await assert.rejects(c.createWhat(), new RegExp(String(limit)));
      assert.equal(c[field === "title" ? "whatTitle" : "whatBody"].value, value);
      assert.equal(c.pendingWhat, null);
      assert.equal(calls, 0);
    } else {
      await c.createWhat();
      assert.equal(calls, 1);
      assert.match(message.join(" "), /\/oriel how/);
      assert.equal(message[1].url, "https://github.com/example/repo/issues/42");
    }
  }
});
