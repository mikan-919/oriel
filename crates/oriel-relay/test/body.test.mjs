import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/account.ts", import.meta.url), "utf8");
const context = vm.createContext({ TextDecoder, fail(status, message) { throw Object.assign(new Error(message), { status }); } });
vm.runInContext(stripTypeScriptTypes(source.slice(source.indexOf("async function readBody("), source.indexOf("\nfunction label(")), { mode: "transform" }) + "\nglobalThis.readBody = readBody;", context);
const encode = text => new TextEncoder().encode(text);
function input(chunks, { open = false, cancel = () => {}, length } = {}) {
  let reads = 0;
  let cancelled = false;
  // highWaterMark zero disables source prefetch: pulls correspond to app reads.
  const body = new ReadableStream({
    pull(controller) {
      reads++;
      if (chunks.length) controller.enqueue(chunks.shift());
      else if (!open) controller.close();
    },
    cancel() { cancelled = true; return cancel(); },
  }, { highWaterMark: 0 });
  const headers = new Headers({ "Content-Type": "application/json" });
  if (length !== undefined) headers.set("Content-Length", length);
  return { request: { headers, body }, get reads() { return reads; }, get cancelled() { return cancelled; } };
}
const bounded = promise => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error("body waited for EOF/cancel")), 1000);
  timer.unref();
})]);
const rejects = (request, status) => assert.rejects(bounded(context.readBody(request)), error => error.status === status);

test("JSON UTF-16 boundaries preserve ASCII, Japanese and emoji with arbitrary UTF-8 splits and BOM", async () => {
  for (const character of ["a", "日", "😀"]) {
    const value = character.repeat(Math.floor((65536 - 8) / character.length));
    const text = JSON.stringify({ x: value });
    assert.equal(text.length, 65536);
    const bytes = encode("\uFEFF" + text);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 17) chunks.push(bytes.subarray(i, i + 17));
    assert.equal((await context.readBody(input(chunks).request)).x, value);
    await rejects(input([encode(text + " ")]).request, 413);
  }
});

test("oversize streams stop app reads, cancel and unlock without awaiting EOF or cancellation", async () => {
  for (const cancel of [() => {}, () => Promise.reject(new Error("cancel failed")), () => new Promise(() => {})]) {
    for (const length of [undefined, "1", "9999999"]) {
      const stream = input([encode(" ".repeat(65536)), encode(" "), encode("unread")], { open: true, cancel, length });
      await rejects(stream.request, 413);
      assert.equal(stream.reads, 2);
      assert.equal(stream.cancelled, true);
      assert.equal(stream.request.body.locked, false);
    }
  }
});

test("single huge chunk and raw byte cap reject before decoding", async () => {
  // The raw byte guard also applies to an oversized single runtime chunk.
  for (const chunks of [[new Uint8Array(262145)], [encode(" ".repeat(65537))],
    [new Uint8Array(262144), new Uint8Array(1)]]) {
    const stream = input(chunks, { open: true });
    await rejects(stream.request, 413);
    assert.equal(stream.cancelled, true);
  }
});

test("EOF decoder flush, replacement decoding, empty and non-object JSON retain validation", async () => {
  for (const text of ["", "[1]", "null", "true", "{bad}"]) await rejects(input([encode(text)]).request, 400);
  const bytes = encode('{"x":"');
  const stream = input([bytes, new Uint8Array([0xff]), encode('"}')]);
  assert.equal((await context.readBody(stream.request)).x, "�");
  await rejects(input([encode(" ".repeat(65536)), new Uint8Array([0xe3])]).request, 413);
  const request = input([]).request;
  request.headers.set("Content-Type", "text/plain");
  await rejects(request, 415);
  assert.equal((await context.readBody(input([encode('{}')]).request)).constructor.name, "Object");
});
