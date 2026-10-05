import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { openCanonicalWorktree, pushCheckpoint } from "./canonical-worktree";
import { runGit } from "./git";

const canonicalBranch = "oriel/ENG-12-gh-28-digest";

/** 実際のsystem Gitでcloneとpushまで行うため、既定の5秒では足りない。 */
const gitTestTimeoutMs = 60_000;

async function git(cwd: string, ...args: string[]) {
  const result = await runGit(args, { cwd });

  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }

  return result.stdout.trim();
}

/** canonicalブランチを持つbare remoteと、`serve`側の作業cloneを作る。 */
async function withRepositories<T>(
  run: (context: {
    remote: string;
    repositoryRoot: string;
    worktreesRoot: string;
    canonicalOid: string;
  }) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-worktree-"));
  const remote = join(directory, "remote.git");
  const seed = join(directory, "seed");
  const repositoryRoot = join(directory, "clone");

  try {
    await git(directory, "init", "--bare", "--initial-branch=main", remote);
    await git(directory, "clone", "--quiet", remote, seed);
    await writeFile(join(seed, "README.md"), "seed\n");
    await git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    await git(
      seed,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "seed",
    );
    await git(seed, "push", "--quiet", "origin", `HEAD:${canonicalBranch}`);
    await git(seed, "push", "--quiet", "origin", "HEAD:main");
    await git(directory, "clone", "--quiet", remote, repositoryRoot);

    const canonicalOid = await git(
      seed,
      "rev-parse",
      `refs/heads/${await git(seed, "rev-parse", "--abbrev-ref", "HEAD")}`,
    );

    return await run({
      remote,
      repositoryRoot,
      worktreesRoot: join(directory, "worktrees"),
      canonicalOid,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test(
  "the sealed canonical branch becomes a worktree the harness can edit and commit in",
  async () => {
    await withRepositories(async (context) => {
      const worktree = await openCanonicalWorktree({
        ...context,
        jobId: "implementation:11:28:digest",
        canonicalBranch,
      });

      expect(worktree).not.toBeNull();

      if (worktree === null) {
        return;
      }

      try {
        // 封印した先端の内容がそのまま出ている。
        expect(await Bun.file(join(worktree.path, "README.md")).text()).toBe(
          "seed\n",
        );
        expect(await git(worktree.path, "rev-parse", "HEAD")).toBe(
          context.canonicalOid,
        );
        expect(
          await git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD"),
        ).toBe(canonicalBranch);

        await writeFile(join(worktree.path, "HANDOFF.md"), "wip\n");
        await git(worktree.path, "add", "-A");
        await git(
          worktree.path,
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "--quiet",
          "-m",
          "checkpoint",
        );

        const headOid = await git(worktree.path, "rev-parse", "HEAD");

        expect(
          await pushCheckpoint({
            worktreePath: worktree.path,
            remote: context.remote,
            canonicalBranch,
            expectedOid: context.canonicalOid,
            headOid,
          }),
        ).toEqual({ status: "pushed", canonicalOid: headOid });

        // remoteのcanonicalブランチだけが進む。
        expect(
          await git(
            context.repositoryRoot,
            "ls-remote",
            context.remote,
            `refs/heads/${canonicalBranch}`,
          ),
        ).toContain(headOid);
      } finally {
        await worktree.remove([context.canonicalOid]);
      }
    });
  },
  gitTestTimeoutMs,
);

test(
  "a canonical tip that no longer matches the sealed OID opens no worktree",
  async () => {
    await withRepositories(async (context) => {
      expect(
        await openCanonicalWorktree({
          ...context,
          jobId: "implementation:11:28:digest",
          canonicalBranch,
          canonicalOid: "9".repeat(40),
        }),
      ).toBeNull();

      // 存在しないブランチも同じくfail closedにする。
      expect(
        await openCanonicalWorktree({
          ...context,
          jobId: "implementation:11:28:digest",
          canonicalBranch: "oriel/ENG-12-gh-28-missing",
        }),
      ).toBeNull();
    });
  },
  gitTestTimeoutMs,
);

test(
  "a checkpoint whose comparison condition no longer holds is not forced through",
  async () => {
    await withRepositories(async (context) => {
      const worktree = await openCanonicalWorktree({
        ...context,
        jobId: "implementation:11:28:digest",
        canonicalBranch,
      });

      if (worktree === null) {
        throw new Error("the worktree was not opened");
      }

      try {
        await writeFile(join(worktree.path, "HANDOFF.md"), "wip\n");
        await git(worktree.path, "add", "-A");
        await git(
          worktree.path,
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "--quiet",
          "-m",
          "checkpoint",
        );

        const headOid = await git(worktree.path, "rev-parse", "HEAD");
        // 別のworkerが遠隔のcanonicalブランチを動かした後。
        const otherOid = await git(
          worktree.path,
          "-c",
          "user.email=o@o",
          "-c",
          "user.name=o",
          "commit-tree",
          `${headOid}^{tree}`,
          "-p",
          context.canonicalOid,
          "-m",
          "other worker",
        );

        await git(
          worktree.path,
          "push",
          "--quiet",
          "--force",
          context.remote,
          `${otherOid}:refs/heads/${canonicalBranch}`,
        );

        expect(
          await pushCheckpoint({
            worktreePath: worktree.path,
            remote: context.remote,
            canonicalBranch,
            expectedOid: context.canonicalOid,
            headOid,
          }),
        ).toEqual({ status: "diverged", canonicalOid: otherOid });
      } finally {
        await worktree.remove([context.canonicalOid]);
      }
    });
  },
  gitTestTimeoutMs,
);

test(
  "only a restorable and clean sandbox is removed, and never with --force",
  async () => {
    await withRepositories(async (context) => {
      const open = () =>
        openCanonicalWorktree({
          ...context,
          jobId: "implementation:11:28:digest",
          canonicalBranch,
        });
      const uncommitted = await open();

      expect(uncommitted).not.toBeNull();

      if (uncommitted === null) {
        return;
      }

      // 未commitの差分は、まだどこからも復元できない。
      await writeFile(join(uncommitted.path, "in-progress.txt"), "wip\n");

      expect(await uncommitted.remove([context.canonicalOid])).toBe("kept");
      expect(
        await Bun.file(join(uncommitted.path, "in-progress.txt")).text(),
      ).toBe("wip\n");

      // cleanでも、遠隔から復元できると確認できない先端は残す。
      await rm(join(uncommitted.path, "in-progress.txt"));

      expect(await uncommitted.remove(["9".repeat(40)])).toBe("kept");
      expect(await git(uncommitted.path, "rev-parse", "HEAD")).toBe(
        context.canonicalOid,
      );

      // 復元可能でcleanな場合だけ消える。
      expect(await uncommitted.remove([context.canonicalOid])).toBe("removed");
      expect(await Bun.file(join(uncommitted.path, "README.md")).exists()).toBe(
        false,
      );
    });
  },
  gitTestTimeoutMs,
);
