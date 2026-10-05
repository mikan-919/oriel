import { expect, test } from "bun:test";

import {
  loadTargetBaseExecutionConfig,
  type ExecutionConfigPort,
} from "./execution-config";

const targetBaseOid = "1".repeat(40);
const workingBranchOid = "2".repeat(40);

const valid = `schemaVersion: 1
execution:
  backend: worktree
  autonomous: true
  verification:
    - [bun, test]
`;

function port(
  files: Record<string, string>,
  unknownAt: string[] = [],
): ExecutionConfigPort & { requested: { oid: string; path: string }[] } {
  const requested: { oid: string; path: string }[] = [];

  return {
    requested,
    async readTargetBaseFile(oid, path) {
      requested.push({ oid, path });

      if (unknownAt.includes(oid)) {
        return { status: "unknown" };
      }

      const content = files[`${oid}:${path}`];

      return content === undefined
        ? { status: "absent" }
        : { status: "present", content };
    },
  };
}

test("the configuration comes from the target branch version alone", async () => {
  const ports = port({
    [`${targetBaseOid}:.oriel.yaml`]: valid,
    // 作業branch側の設定は、そのJobへ適用しない。
    [`${workingBranchOid}:.oriel.yaml`]: valid.replace("bun, test", "rm, -rf"),
  });

  expect(await loadTargetBaseExecutionConfig(ports, targetBaseOid)).toEqual({
    status: "loaded",
    config: {
      schemaVersion: 1,
      execution: {
        backend: "worktree",
        autonomous: true,
        verification: [["bun", "test"]],
      },
    },
  });
  expect(ports.requested).toEqual([
    { oid: targetBaseOid, path: ".oriel.yaml" },
  ]);
});

test("a repository that never allowed autonomous Jobs is refused", async () => {
  expect(await loadTargetBaseExecutionConfig(port({}), targetBaseOid)).toEqual({
    status: "refused",
    reason: "execution_config_missing",
  });
});

test("an invalid configuration is refused rather than partially applied", async () => {
  const ports = port({
    [`${targetBaseOid}:.oriel.yaml`]: valid.replace(
      "autonomous: true",
      "autonomous: false",
    ),
  });

  expect(await loadTargetBaseExecutionConfig(ports, targetBaseOid)).toEqual({
    status: "refused",
    reason: "execution_config_invalid",
  });
});

test("a configuration that cannot be read is refused rather than assumed absent", async () => {
  expect(
    await loadTargetBaseExecutionConfig(
      port({}, [targetBaseOid]),
      targetBaseOid,
    ),
  ).toEqual({ status: "refused", reason: "execution_config_unreadable" });
});
