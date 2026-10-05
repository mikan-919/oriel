import { accessSync, constants, statSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { identity } from "@mikan-919/oriel-identity";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** 遠隔操作に使う一回限りのcredential。`serve`の外へは出さない。 */
export interface GitCredential {
  username: string;
  token: string;
}

/**
 * system Gitをshell文字列を介さず引数配列で実行する。
 *
 * `credential`を渡した場合だけ、その一回の実行のためのcredential helperを用意
 * する。tokenは引数、remote URL、環境変数、worktree、harnessへ置かず、helperが
 * `serve`のunix socketから一度だけ受け取る。
 */
export async function runGit(
  args: string[],
  { cwd, credential }: { cwd?: string; credential?: GitCredential | null } = {},
): Promise<GitResult> {
  if (credential === undefined || credential === null) {
    return spawnGit(args, cwd);
  }

  return withOneTimeCredentialHelper(credential, (configArgs) =>
    spawnGit([...configArgs, ...args], cwd),
  );
}

async function spawnGit(args: string[], cwd?: string): Promise<GitResult> {
  const git = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // credentialも対話入力も継承しない。
    env: {
      PATH: Bun.env.PATH ?? "",
      HOME: Bun.env.HOME ?? "",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ASKPASS: "",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(git.stdout).text(),
    new Response(git.stderr).text(),
    git.exited,
  ]);

  return { ok: exitCode === 0, stdout, stderr };
}

/**
 * unix socketを作れる領域。v1の対象はLinuxとWSL2とする。
 *
 * `/run/user`そのものはroot所有で一般userには書けない。存在検査だけで選ぶと、
 * `XDG_RUNTIME_DIR`が無い構成(systemdを動かさないWSL2)で直後の`mkdtemp`が
 * EACCESになり、credentialを使うGit操作が一律で落ちる。user固有のsubdirectory
 * まで含めて候補にし、実際に書けるものだけを選ぶ。
 */
export function socketDirectory(): string {
  for (const candidate of [
    Bun.env.XDG_RUNTIME_DIR,
    `/run/user/${process.getuid?.() ?? ""}`,
  ]) {
    if (candidate !== undefined && isWritableDirectory(candidate)) {
      return candidate;
    }
  }

  return tmpdir();
}

function isWritableDirectory(path: string): boolean {
  try {
    accessSync(path, constants.W_OK | constants.X_OK);

    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 一回限りのcredential helperを用意し、Gitの`-c`引数として渡す。
 *
 * helperのfileはtokenを持たず、`serve`のunix socketへ問い合わせるだけとする。
 * socketは一度だけ答え、実行後にhelperごと消す。
 */
export async function withOneTimeCredentialHelper<T>(
  credential: GitCredential,
  run: (configArgs: string[]) => Promise<T>,
): Promise<T> {
  // unix socketを作れる領域に置く。v1の対象はLinuxとWSL2とする。
  const directory = await mkdtemp(
    join(socketDirectory(), `${identity.codeName}-git-credential-`),
  );
  await chmod(directory, 0o700);

  const socketPath = join(directory, "credential.sock");
  const helperPath = join(directory, `git-credential-${identity.codeName}`);
  let answered = false;
  const server = Bun.serve({
    unix: socketPath,
    fetch() {
      if (answered) {
        return new Response("", { status: 410 });
      }

      answered = true;

      return new Response(
        `username=${credential.username}\npassword=${credential.token}\n`,
      );
    },
  });

  // helperは絶対pathとして渡すため、Gitはshellを介さず直接実行する。
  await writeFile(
    helperPath,
    `#!${process.execPath}
if (Bun.argv[2] === "get") {
  const answer = await fetch("http://localhost/credential", {
    unix: ${JSON.stringify(socketPath)},
  });

  if (answer.ok) {
    Bun.stdout.write(await answer.text());
  }
}
`,
    { mode: 0o700 },
  );

  try {
    return await run([
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${helperPath}`,
    ]);
  } finally {
    server.stop(true);
    await rm(directory, { force: true, recursive: true });
  }
}
