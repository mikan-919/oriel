import { expect, test } from "bun:test";

import { openServeLocalState } from "./local-state";
import {
  createModelDefaultsStore,
  modelDefaultKinds,
  resolveModelDefault,
} from "./model-defaults";

function createStore() {
  return createModelDefaultsStore(openServeLocalState(":memory:"));
}

test("model defaults persist base and per-kind values", () => {
  const store = createStore();
  const base = { provider: "openai", id: "gpt-5" };
  const implementation = { provider: "lm-studio", id: "local-model" };

  store.set("base", base);
  store.set("implementation", implementation);

  expect(store.get("base")).toEqual(base);
  expect(store.isInitialized("base")).toBe(true);
  expect(store.get("implementation")).toEqual(implementation);
  expect(store.get("what_confirmation")).toBeNull();
  const listed = store.list();

  expect(listed.base).toEqual(base);
  expect(listed.perKind.implementation).toEqual(implementation);

  for (const kind of modelDefaultKinds) {
    if (kind !== "implementation") {
      expect(listed.perKind[kind]).toBeNull();
    }
  }
});

test("model selection resolves override, per-kind, then base", () => {
  const store = createStore();
  const base = { provider: "openai", id: "gpt-5" };
  const perKind = { provider: "anthropic", id: "claude" };
  const override = { provider: "lm-studio", id: "local-model" };

  store.set("base", base);
  expect(resolveModelDefault(store, "how_confirmation")).toEqual(base);

  store.set("how_confirmation", perKind);
  expect(resolveModelDefault(store, "how_confirmation")).toEqual(perKind);
  expect(resolveModelDefault(store, "how_confirmation", override)).toEqual(
    perKind,
  );
  expect(resolveModelDefault(store, "implementation", override)).toEqual(
    override,
  );
  expect(resolveModelDefault(store, "issue_conversation", override)).toBe(null);
});

test("an unset model default refuses to resolve", () => {
  expect(resolveModelDefault(createStore(), "implementation")).toBeNull();
});

test("clearing a model default restores fallback behavior", () => {
  const store = createStore();
  const base = { provider: "openai", id: "gpt-5" };
  const perKind = { provider: "anthropic", id: "claude" };

  store.set("base", base);
  store.set("pr_response", perKind);
  store.clear("pr_response");

  expect(store.get("pr_response")).toBeNull();
  expect(store.isInitialized("pr_response")).toBe(true);
  expect(resolveModelDefault(store, "pr_response")).toEqual(base);
});

test("clearing the base default stays cleared across environment seeding", () => {
  const store = createStore();

  store.clear("base");

  expect(store.get("base")).toBeNull();
  expect(store.isInitialized("base")).toBe(true);
});
