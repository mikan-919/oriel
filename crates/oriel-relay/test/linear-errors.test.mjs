import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

function reader(response) {
  const c = vm.createContext({ TextEncoder, fetch: async () => response });
  const source = stripTypeScriptTypes(readFileSync(new URL("../src/workflow-reader.ts", import.meta.url), "utf8"), { mode: "transform" });
  vm.runInContext(source.replace(/^import[\s\S]*?;/gm, "").replace(/^export /gm, "") + "\nglobalThis.WorkflowReader = WorkflowReader;", c);
  return new c.WorkflowReader({}, { fail(status, message, retryAfterSeconds) { throw Object.assign(new Error(message), { status, retryAfterSeconds }); } });
}

const context = { linear: "private-token", check() {} };
const missing = { message: "Entity not found: Issue", extensions: { code: "INPUT_ERROR" } };

test("Linear HTTP failures retain operation and known GraphQL codes without upstream messages", async () => {
  for (const [status, code] of [[400, "RATELIMITED"], [400, "GRAPHQL_VALIDATION_FAILED"], [404, "FORBIDDEN"]]) {
    const api = reader(Response.json({ errors: [{ message: "private-provider-diagnostic", extensions: { code } }] }, { status }));
    await assert.rejects(api.workflowLinear(context, "query($after:String){issues(first:100){nodes{id}}}", { after: "private-cursor" }), error => {
      assert.equal(error.status, code === "RATELIMITED" ? 429 : 502);
      assert.ok(error.message.includes(`http_${status}/${code}`), error.message);
      assert.ok(error.message.includes("issues"), error.message);
      assert.doesNotMatch(error.message, /private-/);
      return true;
    });
  }
  const api = reader(Response.json({ errors: [{ message: "private-message", extensions: { code: "PRIVATE_PROVIDER_SECRET" } }] }, { status: 400 }));
  await assert.rejects(api.workflowLinear(context, "query{team{id}}"), error => {
    assert.match(error.message, /http_400/);
    assert.doesNotMatch(error.message, /PRIVATE|private/);
    return true;
  });
});

test("Linear rate limits honor exhausted bucket resets without forwarding provider data", async () => {
  const reset = Date.now() + 180_000;
  for (const bucket of ["Requests", "Complexity", "Endpoint-Requests"]) {
    const headers = {
      [`X-RateLimit-${bucket}-Remaining`]: "0",
      [`X-RateLimit-${bucket}-Reset`]: String(reset),
    };
    const api = reader(Response.json({ errors: [
      { message: "private-provider-error", extensions: { code: "INPUT_ERROR" } },
      { message: "private-provider-error", extensions: { code: "RATELIMITED", retry: "private-token" } },
    ] }, { status: 400, headers }));
    await assert.rejects(api.workflowLinear(context, "query{issue(id:\"how\"){id}}"), error => {
      assert.equal(error.status, 429);
      assert.match(error.message, /RATELIMITED/);
      assert.doesNotMatch(error.message, /private-/);
      assert.ok(error.retryAfterSeconds >= 179 && error.retryAfterSeconds <= 180);
      return true;
    });
  }
  for (const [headers, seconds] of [
    [{}, 60],
    [{ "Retry-After": "120" }, 120],
    [{ "Retry-After": "private-token", "X-RateLimit-Requests-Remaining": "0", "X-RateLimit-Requests-Reset": "NaN" }, 60],
    [{ "X-RateLimit-Requests-Remaining": "5", "X-RateLimit-Requests-Reset": String(reset) }, 60],
    [{ "X-RateLimit-Requests-Remaining": "0", "X-RateLimit-Requests-Reset": "9999999999999999999999" }, 86400],
  ]) {
    await assert.rejects(reader(new Response("private HTML", { status: 429, headers })).workflowLinear(context, "query{issue{id}}"), error => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterSeconds, seconds);
      return true;
    });
  }
});

test("Only native missing-Issue errors on successful or client-error responses mean absent HOW", async () => {
  for (const status of [200, 400, 404]) {
    const api = reader(Response.json({ data: { issue: null }, errors: [missing] }, { status }));
    assert.equal(await api.workflowHow(context, "how-id"), null);
  }
  for (const [status, errors] of [
    [404, [{ ...missing, extensions: { code: "FORBIDDEN" } }]],
    [404, [missing, { message: "private-error", extensions: { code: "RATELIMITED" } }]],
    [503, [missing]],
  ]) {
    const api = reader(Response.json({ data: { issue: null }, errors }, { status }));
    await assert.rejects(api.workflowHow(context, "how-id"));
  }
  await assert.rejects(reader(new Response("private HTML", { status: 404 })).workflowHow(context, "how-id"));
  await assert.rejects(reader(Response.json({ data: { issue: { id: "how-id" } } }, { status: 400 })).workflowLinear(context, "query{issue(id:\"how-id\"){id}}"));
});
