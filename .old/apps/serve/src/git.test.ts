import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { runGit, socketDirectory, withOneTimeCredentialHelper } from "./git";

async function withDirectory<T>(run: (path: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-git-"));

  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("the credential helper socket directory is always writable", async () => {
  // `XDG_RUNTIME_DIR`が無い構成(systemdを動かさないWSL2)でも、root所有で書けない
  // `/run/user`を選ばず、mkdtempが通る領域へ落ちること。
  const original = Bun.env.XDG_RUNTIME_DIR;

  delete Bun.env.XDG_RUNTIME_DIR;

  try {
    const directory = await mkdtemp(join(socketDirectory(), "oriel-socket-"));

    await rm(directory, { force: true, recursive: true });
  } finally {
    if (original !== undefined) {
      Bun.env.XDG_RUNTIME_DIR = original;
    }
  }
});

test("system Git runs from an argument array and reports failures", async () => {
  await withDirectory(async (directory) => {
    expect((await runGit(["init", "--quiet"], { cwd: directory })).ok).toBe(
      true,
    );
    expect(
      (await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: directory }))
        .stdout,
    ).toContain("true");

    const missing = await runGit(["rev-parse", "does-not-exist"], {
      cwd: directory,
    });

    expect(missing.ok).toBe(false);
    expect(missing.stderr).not.toBe("");
  });
});

test("the one-time credential helper answers Git once and leaves no credential behind", async () => {
  await withDirectory(async (directory) => {
    const credential = { username: "x-access-token", token: "installation" };
    const helperDirectories: string[] = [];
    const fill = (configArgs: string[]) =>
      Bun.spawn(["git", ...configArgs, "credential", "fill"], {
        cwd: directory,
        stdin: new TextEncoder().encode("protocol=https\nhost=github.com\n\n"),
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? "" },
      });

    const filled = await withOneTimeCredentialHelper(
      credential,
      async (configArgs) => {
        // tokenはGitの引数にも環境変数にも載らない。
        expect(configArgs.join(" ")).not.toContain(credential.token);
        helperDirectories.push(
          join(configArgs[3]!.replace("credential.helper=", ""), ".."),
        );

        const first = await new Response(fill(configArgs).stdout).text();
        const second = await new Response(fill(configArgs).stdout).text();

        return { first, second };
      },
    );

    expect(filled.first).toContain("password=installation");
    // 二度目は答えない。同じhelperを使い回して送信を繰り返さない。
    expect(filled.second).not.toContain("password=installation");

    // helperそのものを消し、tokenをfileへ残さない。
    expect(await readdir(helperDirectories[0]!).catch(() => null)).toBeNull();
  });
});
