import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

function reader(response) {
  const c = vm.createContext({ TextEncoder, fetch: async () => response });
  const source = stripTypeScriptTypes(readFileSync(new URL("../src/workflow-reader.ts", import.meta.url), "utf8"), { mode: "transform" });
  vm.runInContext(source.replace(/^import[\s\S]*?;/gm, "").replace(/^export /gm, "") + "\nglobalThis.WorkflowReader = WorkflowReader;", c);
  return new c.WorkflowReader({}, { fail(status, message) { throw Object.assign(new Error(message), { status }); } });
}

const context = { linear: "private-token", check() {} };
const missing = { message: "Entity not found: Issue", extensions: { code: "INPUT_ERROR" } };

test("Linear HTTP failures retain operation and known GraphQL codes without upstream messages", async () => {
  for (const [status, code] of [[400, "RATELIMITED"], [400, "GRAPHQL_VALIDATION_FAILED"], [404, "FORBIDDEN"]]) {
    const api = reader(Response.json({ errors: [{ message: "private-provider-diagnostic", extensions: { code } }] }, { status }));
    await assert.rejects(api.workflowLinear(context, "query($after:String){issues(first:100){nodes{id}}}", { after: "private-cursor" }), error => {
      assert.equal(error.status, 502);
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
