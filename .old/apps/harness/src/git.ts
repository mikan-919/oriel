export interface LocalGitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * harness側の薄いsystem Git adapter。
 *
 * ROADMAPの分担どおり、status、diff、commitなどworktree内で閉じる操作だけを持つ。
 * 遠隔操作とcredentialは信頼された`serve`にあり、ここには存在しない。
 */
export interface LocalGit {
  run(args: string[], cwd: string): Promise<LocalGitResult>;
}

/** shell文字列を介さず引数配列で実行する。credentialは環境から渡さない。 */
export const systemLocalGit: LocalGit = {
  async run(args, cwd) {
    const git = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      // `serve`が既に絞ったenvをそのまま使い、対話入力とcredential探索だけ止める。
      env: {
        ...Bun.env,
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
  },
};
