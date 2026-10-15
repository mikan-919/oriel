import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import vm from "node:vm";

const message = "Exceeded allowed rows read in Durable Objects free tier.";
const quota = stripTypeScriptTypes(readFileSync(new URL("../src/quota.ts", import.meta.url), "utf8"), {mode:"transform"}).replace(/^export /gm, "");

test("Database quota returns a bounded reset time even when object construction fails", async () => {
  const now = Date.parse("2026-10-13T16:00:00Z");
  const c = vm.createContext({Response, URL, Date:class extends Date {static now(){return now;}}});
  const source = stripTypeScriptTypes(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), {mode:"transform"});
  vm.runInContext(quota + source.replace(/^import.*;/gm, "").replace(/^export \{.*;/gm, "").replace("export default", "globalThis.worker ="), c);
  let failure = new Error(message);
  const env = {ACCOUNTS:{idFromName:()=>"accounts", get:()=>({fetch:async()=>{throw failure;}})}};
  const response = await c.worker.fetch(new Request("https://oriel.example/api/pair/start", {method:"POST"}), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "28800");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {code:"durable_objects_daily_read_limit",
    error:"Cloudflare Durable Objects daily database read limit exceeded. The free limit resets at 00:00 UTC.", retry_at:"2026-10-14T00:00:00.000Z"});
  failure = new Error("private unrelated failure");
  await assert.rejects(c.worker.fetch(new Request("https://oriel.example/api/session"), env), error=>error===failure);
});

test("Quota inside the account handler closes control without more storage reads", async () => {
  const c = vm.createContext({Response, URL, TextEncoder, DurableObject:class {}, console});
  const source = stripTypeScriptTypes(readFileSync(new URL("../src/account.ts", import.meta.url), "utf8"), {mode:"transform"});
  vm.runInContext(quota + source.replace(/^import[\s\S]*?;/gm, "").replace(/^export /gm, "") + "\nglobalThis.AccountRegistry = AccountRegistry;", c);
  const account = Object.create(c.AccountRegistry.prototype);
  const closed = [];
  account.ctx = {getWebSockets:()=>[{close:(...args)=>closed.push(args)}]};
  account.workflows = {publish(){assert.fail("Quota cannot publish SQL-backed authority");}};
  account.pairDaemon = async()=>{throw new Error(message);};
  const response = await account.fetch(new Request(`https://oriel.example/api/pair/${"a".repeat(32)}/status`));
  assert.equal(response.status, 503);
  assert.deepEqual(closed, [[1013, "Daily database read limit exceeded"]]);
});

test("Local workflow authority stays fresh with bounded SQL reads", async () => {
  const c = vm.createContext({TextEncoder, TextDecoder, URL, crypto, WorkflowReader:class {}});
  const source = stripTypeScriptTypes(readFileSync(new URL("../src/integrations.ts", import.meta.url), "utf8"), {mode:"transform"});
  vm.runInContext(source.replace(/^import[\s\S]*?;/gm, "").replace(/^export /gm, "") + "\nglobalThis.Integrations = Integrations;", c);
  const integrations = Object.create(c.Integrations.prototype);
  const device = {device_id:"device", user_id:"user", host_hash:"host", repository_generation:"revision", repository:JSON.stringify({owner:"owner", name:"repo"})};
  const repository = {owner:"owner", name:"repo", repository_id:1};
  const connections = {
    github:{user_id:"user", provider:"github", generation:"github", active:"github-secret", target:JSON.stringify(repository)},
    linear:{user_id:"user", provider:"linear", generation:"linear", active:"linear-secret", target:JSON.stringify({team_id:"team"})},
  };
  let reads = 0;
  integrations.sql = {exec:(query, ...args)=>{
    reads++;
    return {toArray:()=>query.includes("FROM devices") ? [{...device}] : [{...connections[args[1]]}]};
  }};
  integrations.auth = {fail:(_status,message)=>{throw Error(message);}};
  integrations.installationToken = async()=>({token:"token", repository});
  integrations.credential = async()=>({access_token:"token"});
  // The leased control guard reads its device and checks the current binding.
  const check = ()=>{integrations.sql.exec("SELECT * FROM devices WHERE device_id = ?", device.device_id);integrations.workflowBinding(device);};
  const context = await integrations.workflowContext(device, check);
  reads = 0;
  context.check();
  assert.ok(reads <= 8, `Live guard used ${reads} SQL reads; synchronous checks must not repeat`);
  connections.linear.active = "changed";
  assert.throws(()=>context.check(), /Provider connection changed/);
  connections.linear.active = "linear-secret";
  connections.github.generation = "replacement";
  assert.throws(()=>context.check(), /Workflow binding changed/);
  connections.github.generation = "github";
  device.repository_generation = "replacement";
  assert.throws(()=>context.check(), /Workflow binding changed/);
});
