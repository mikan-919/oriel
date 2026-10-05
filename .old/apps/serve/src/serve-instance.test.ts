import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import type { InstanceConfig } from "@mikan-919/oriel-contracts";

import { createJobRegistry } from "./job-registry";
import type { ModelDefaultsStore, ModelSelection } from "./model-defaults";
import { buildServeInstance, type ServeInstanceShared } from "./serve-instance";

/** loopとnotification接続だけが触る、誰も待ち受けていないrelay。 */
const unreachableRelayOrigin = "http://127.0.0.1:1";

const config: InstanceConfig = {
  relayOrigin: unreachableRelayOrigin,
  repositoryId: 11,
  repositoryOwner: "mikan-919",
  repositoryName: "oriel",
  repositoryRoot: "/repository",
  worktreesRoot: "/worktrees",
  linearTeamId: null,
  canonicalRemote: "origin",
  lmStudioBaseUrl: null,
};

/** 保存済みの既定値だけを持つstore。SQLは`model-defaults.test.ts`が見る。 */
function fakeModelDefaults(
  initial: Record<string, ModelSelection> = {},
): ModelDefaultsStore {
  const defaults = new Map(Object.entries(initial));

  return {
    get: (scope) => defaults.get(scope) ?? null,
    isInitialized: (scope) => defaults.has(scope),
    set: (scope, model) => defaults.set(scope, model),
    clear: (scope) => defaults.delete(scope),
    list: () => {
      throw new Error(
        "the model defaults list is not read by buildServeInstance",
      );
    },
  };
}

async function withInstance<T>(
  modelDefaults: ModelDefaultsStore,
  run: (
    bindings: ReturnType<typeof buildServeInstance>["bindings"],
  ) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-serve-instance-"));
  const shared: ServeInstanceShared = {
    jobRegistry: createJobRegistry(),
    tokenStore: { set: async () => {}, get: async () => null },
    statePath: join(directory, "serve.sqlite"),
    heartbeatStopMs: 500,
    discoveryPollIntervalMs: 60_000,
    modelDefaults,
  };
  const instance = buildServeInstance(config, shared);

  try {
    return await run(instance.bindings);
  } finally {
    instance.stop();
    await rm(directory, { force: true, recursive: true });
  }
}

test("a Job requested without any configured model is refused before any boundary is touched", async () => {
  await withInstance(fakeModelDefaults(), async (bindings) => {
    expect(bindings.startImplementationJob).toBeDefined();
    // model未設定は起動条件の不足として拒否する。relayもGitHubも触らない。
    expect(
      await bindings.startImplementationJob!({ linearIssueId: "ENG-12" }),
    ).toEqual({ status: "refused", reason: "model_not_configured" });
  });
});

test("a base default alone satisfies the model gate and lets the next admission gate decide", async () => {
  const modelDefaults = fakeModelDefaults({
    base: { provider: "lm-studio", id: "base-model" },
  });

  await withInstance(modelDefaults, async (bindings) => {
    // per-kindが無くてもbaseで解決するため、model gateは通り、次の関門で止まる。
    // この構成ではdeviceが未登録なので、そこがJob起動の次の判断になる。
    expect(
      await bindings.startImplementationJob!({ linearIssueId: "ENG-12" }),
    ).toEqual({ status: "refused", reason: "device_not_registered" });
  });
});
