import { expect, test } from "bun:test";

import { createInstanceConfigStore } from "./instance-config";
import { openServeLocalState } from "./local-state";

function createStore() {
  return createInstanceConfigStore(openServeLocalState(":memory:"));
}

test("instance config starts uninitialized with all fields null", () => {
  const store = createStore();

  expect(store.isInitialized()).toBe(false);
  expect(store.get()).toEqual({
    relayOrigin: null,
    repositoryId: null,
    repositoryOwner: null,
    repositoryName: null,
    repositoryRoot: null,
    worktreesRoot: null,
    linearTeamId: null,
    canonicalRemote: null,
    lmStudioBaseUrl: null,
  });
});

test("instance config persists a full save and becomes initialized", () => {
  const store = createStore();
  const config = {
    relayOrigin: "https://relay.example.test",
    repositoryId: 42,
    repositoryOwner: "mikan-919",
    repositoryName: "oriel",
    repositoryRoot: "/home/mikan/repo",
    worktreesRoot: "/home/mikan/worktrees",
    linearTeamId: "team-1",
    canonicalRemote: "origin",
    lmStudioBaseUrl: "http://127.0.0.1:1234",
  };

  store.set(config);

  expect(store.isInitialized()).toBe(true);
  expect(store.get()).toEqual(config);
});
