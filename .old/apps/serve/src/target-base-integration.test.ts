import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { runGit } from "./git";
import { integrateTargetBase } from "./target-base-integration";

/** 実際のsystem Gitを動かすため、既定の5秒では足りない。 */
const gitTestTimeoutMs = 120_000;

const canonicalBranch = `oriel/ENG-12-gh-28-${"a".repeat(64)}`;

async function git(cwd: string, ...args: string[]) {
  const result = await runGit(args, { cwd });

  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }

  return result.stdout.trim();
}

/**
 * canonicalブランチをbaseから分岐させ、その後で取り込み先を前進させたrepository。
 * `advance`が同じfileへ書くと、統合は競合する。
 */
async function withAdvancedTargetBase<T>(
  advance: { path: string; content: string },
  branchWork: { path: string; content: string },
  run: (context: {
    worktreePath: string;
    remote: string;
    targetBaseOid: string;
  }) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-target-base-"));
  const remote = join(directory, "remote.git");
  const seed = join(directory, "seed");
  const author = ["-c", "user.email=t@t", "-c", "user.name=t"];

  try {
    await git(directory, "init", "--bare", "--initial-branch=main", remote);
    await git(directory, "clone", "--quiet", remote, seed);
    await writeFile(join(seed, "README.md"), "seed\n");
    await git(seed, ...author, "add", "-A");
    await git(seed, ...author, "commit", "--quiet", "-m", "seed");
    await git(seed, "push", "--quiet", "origin", "HEAD:main");
    await git(seed, "push", "--quiet", "origin", `HEAD:${canonicalBranch}`);

    // canonicalブランチ側の未検証の作業途中成果。
    await git(seed, "checkout", "--quiet", "-B", canonicalBranch);
    await writeFile(join(seed, branchWork.path), branchWork.content);
    await git(seed, ...author, "add", "-A");
    await git(seed, ...author, "commit", "--quiet", "-m", "work in progress");
    await git(seed, "push", "--quiet", "origin", `HEAD:${canonicalBranch}`);

    // 取り込み先の前進。承認は失効しないが、統合と再検証が要る。
    await git(seed, "checkout", "--quiet", "-B", "main", "origin/main");
    await writeFile(join(seed, advance.path), advance.content);
    await git(seed, ...author, "add", "-A");
    await git(seed, ...author, "commit", "--quiet", "-m", "advance main");
    await git(seed, "push", "--quiet", "origin", "HEAD:main");

    const worktreePath = join(directory, "worktree");

    await git(
      directory,
      "clone",
      "--quiet",
      "-b",
      canonicalBranch,
      remote,
      worktreePath,
    );

    return await run({
      worktreePath,
      remote,
      targetBaseOid: await git(seed, "rev-parse", "HEAD"),
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test(
  "the latest target base is merged into the adopted branch",
  async () => {
    await withAdvancedTargetBase(
      { path: "main.txt", content: "from main\n" },
      { path: "work.txt", content: "from the branch\n" },
      async (context) => {
        const before = await git(context.worktreePath, "rev-parse", "HEAD");
        const integrated = await integrateTargetBase({
          worktreePath: context.worktreePath,
          remote: context.remote,
          targetBaseRef: "refs/heads/main",
          targetBaseOid: context.targetBaseOid,
        });

        expect(integrated.status).toBe("integrated");

        if (integrated.status !== "integrated") {
          return;
        }

        expect(integrated.headOid).not.toBe(before);
        expect(await git(context.worktreePath, "rev-parse", "HEAD")).toBe(
          integrated.headOid,
        );
        // 取り込み先の変更も、branchの作業途中成果も残る。
        expect(
          await Bun.file(join(context.worktreePath, "main.txt")).text(),
        ).toBe("from main\n");
        expect(
          await Bun.file(join(context.worktreePath, "work.txt")).text(),
        ).toBe("from the branch\n");
      },
    );
  },
  gitTestTimeoutMs,
);

test(
  "a conflicting target base leaves the worktree untouched and fails closed",
  async () => {
    await withAdvancedTargetBase(
      { path: "shared.txt", content: "main wrote this\n" },
      { path: "shared.txt", content: "the branch wrote this\n" },
      async (context) => {
        const before = await git(context.worktreePath, "rev-parse", "HEAD");

        expect(
          await integrateTargetBase({
            worktreePath: context.worktreePath,
            remote: context.remote,
            targetBaseRef: "refs/heads/main",
            targetBaseOid: context.targetBaseOid,
          }),
        ).toEqual({ status: "conflicted" });

        // 中断したmergeを残さない。
        expect(await git(context.worktreePath, "rev-parse", "HEAD")).toBe(
          before,
        );
        expect(await git(context.worktreePath, "status", "--porcelain")).toBe(
          "",
        );
      },
    );
  },
  gitTestTimeoutMs,
);

test(
  "a target base whose fetched tip is not the confirmed OID fails closed",
  async () => {
    await withAdvancedTargetBase(
      { path: "main.txt", content: "from main\n" },
      { path: "work.txt", content: "from the branch\n" },
      async (context) => {
        expect(
          await integrateTargetBase({
            worktreePath: context.worktreePath,
            remote: context.remote,
            targetBaseRef: "refs/heads/main",
            // 承認時に確認したOIDと遠隔の現在値が食い違う、曖昧な結果。
            targetBaseOid: "9".repeat(40),
          }),
        ).toEqual({ status: "unavailable" });
      },
    );
  },
  gitTestTimeoutMs,
);

test(
  "a target base already contained in the branch needs no merge commit",
  async () => {
    await withAdvancedTargetBase(
      { path: "main.txt", content: "from main\n" },
      { path: "work.txt", content: "from the branch\n" },
      async (context) => {
        const first = await integrateTargetBase({
          worktreePath: context.worktreePath,
          remote: context.remote,
          targetBaseRef: "refs/heads/main",
          targetBaseOid: context.targetBaseOid,
        });
        const second = await integrateTargetBase({
          worktreePath: context.worktreePath,
          remote: context.remote,
          targetBaseRef: "refs/heads/main",
          targetBaseOid: context.targetBaseOid,
        });

        expect(second).toEqual(first);
      },
    );
  },
  gitTestTimeoutMs,
);
