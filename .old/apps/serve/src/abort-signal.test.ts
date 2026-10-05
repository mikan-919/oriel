import { expect, test } from "bun:test";

import { onAbort } from "./abort-signal";

test("onAbort calls the listener immediately when the signal is already aborted", () => {
  const controller = new AbortController();

  controller.abort();

  let calls = 0;

  onAbort(controller.signal, () => {
    calls += 1;
  });

  expect(calls).toBe(1);
});

test("onAbort calls the listener once the signal later aborts", () => {
  const controller = new AbortController();

  let calls = 0;

  onAbort(controller.signal, () => {
    calls += 1;
  });
  expect(calls).toBe(0);

  controller.abort();
  expect(calls).toBe(1);
});

test("onAbort is a no-op without a signal", () => {
  expect(() => onAbort(undefined, () => {})).not.toThrow();
});
