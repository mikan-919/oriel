import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import vm from "node:vm";

test("command completion preserves deltas only when aggregate output is absent and isolates threads", () => {
  const source = readFileSync(new URL("../src/assets/codex.js", import.meta.url), "utf8");
  const c = vm.createContext({engineId: "engine", threadId: "first", items: new Map(),
    node: () => ({dataset: {}, textContent: ""}), ui: {output: {children: [], append(element) { this.children.push(element); }}}});
  vm.runInContext(source.slice(source.indexOf("    function outputItem("), source.indexOf("    function receiveEvent(")), c);
  const command = {id: "item", type: "commandExecution", command: "ls", aggregatedOutput: null};
  c.outputItem(command);
  const output = c.ui.output.children[0];
  output.textContent += "hello";
  c.outputItem(command);
  assert.equal(output.textContent, "$ ls\nhello");
  c.outputItem({...command, aggregatedOutput: "hello"});
  assert.equal(output.textContent, "$ ls\nhello");
  c.outputItem({...command, aggregatedOutput: ""});
  assert.equal(output.textContent, "$ ls\n");
  c.threadId = "second";
  c.outputItem(command);
  assert.equal(c.ui.output.children[1].textContent, "$ ls\n");
});

test("consultation host offline replaces preparation with startup guidance", async () => {
  const nodes = new Map();
  const element = () => ({
    value: "", textContent: "", disabled: false, listeners: {}, parentElement: {hidden: false},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    replaceChildren() {}, append() {}, querySelector() { return element(); }
  });
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  let socket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    listeners = {};
    constructor() { socket = this; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    close() {}
    send() {}
  }
  const context = vm.createContext({
    document: {getElementById: get, createElement: element},
    WebSocket: Socket, URL,
    location: {origin: "https://fixture.invalid", protocol: "https:"},
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}
  });
  vm.runInContext(readFileSync(new URL("../src/assets/codex.js", import.meta.url), "utf8")
    .replace("export function mountCodex", "function mountCodex"), context);
  const page = vm.runInContext("mountCodex()", context);
  page.setContext({id: "owner"}, [{device_id: "fixture", name: "Fixture"}]);
  get("codex-device").value = "fixture";
  await get("codex-connect").listeners.click();
  socket.listeners.message({data: JSON.stringify({type: "state", engines: []})});
  assert.match(get("codex-status").textContent, /準備/);
  socket.listeners.message({data: JSON.stringify({type: "offline"})});
  assert.match(get("codex-status").textContent, /orield codex/);
  assert.doesNotMatch(get("codex-status").textContent, /準備/);
  assert.equal(get("codex-new").disabled, true);
});
