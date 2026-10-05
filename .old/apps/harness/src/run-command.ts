/**
 * worktree内でcommandを実行する唯一の経路。
 *
 * Agentの`run_command` toolも`.oriel.yaml`の検証commandもここを通る。自立Jobは
 * 無人で動くため、応答しないcommandと際限なく出力するcommandの両方をここで
 * 止めないと、worktreeと所有権接続を占有したまま人手の停止を待つことになる。
 */

/**
 * 一つのcommandの実行上限。
 *
 * Limit / Source / Required For:
 * - 600_000ms / 既定値(実測待ち) / 応答しないcommandで自立Jobがハングしないこと
 *
 * `cli.ts`のheartbeat・poll間隔と同じ扱いで、根拠のある値が決まるまでの既定値
 * とする。安全条件は「有限であること」だけで、値そのものはbuildとtestの実測から
 * 決める。検証専用環境での実測はissue #55の系列で扱う。
 */
export const COMMAND_TIMEOUT_MS = 600_000;

/**
 * 一つのcommandから取り込む出力の上限。
 *
 * Limit / Source / Required For:
 * - 65_536 bytes / 既定値(実測待ち) / 出力がmodel contextとメモリを潰さないこと
 *
 * 取り込んだ出力はそのままmodelへ渡るため、context windowを一撃で埋めない大きさ
 * にする。buildとtestの失敗は末尾に出るので、超過分は先頭から捨てる。
 */
export const COMMAND_OUTPUT_LIMIT_BYTES = 65_536;

export interface CommandRun {
  ok: boolean;
  output: string;
}

export interface CommandLimits {
  timeoutMs: number;
  outputLimitBytes: number;
}

/**
 * 末尾から`limit`バイトだけを残して読む。
 *
 * 読み捨てずに最後まで消費しないとcommand側がpipeで詰まるため、drainは続けた
 * まま、保持する塊だけを先頭から落とす。メモリはlimitと最後の一塊で頭打ちになる。
 */
async function readTail(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;

    while (total - (chunks[0]?.length ?? 0) >= limit && chunks.length > 1) {
      total -= chunks.shift()!.length;
      truncated = true;
    }
  }

  const joined = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }

  const kept = total > limit ? joined.subarray(total - limit) : joined;

  return {
    text: new TextDecoder().decode(kept),
    truncated: truncated || total > limit,
  };
}

export async function runCommand(
  command: string[],
  cwd: string,
  limits: CommandLimits = {
    timeoutMs: COMMAND_TIMEOUT_MS,
    outputLimitBytes: COMMAND_OUTPUT_LIMIT_BYTES,
  },
): Promise<CommandRun> {
  const [executable, ...args] = command;
  const spawned = Bun.spawn([executable!, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // `serve`がharnessへ渡した時点でcredentialは含まれていない。
    env: { ...Bun.env },
    timeout: limits.timeoutMs,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readTail(spawned.stdout, limits.outputLimitBytes),
    readTail(spawned.stderr, limits.outputLimitBytes),
    spawned.exited,
  ]);
  const timedOut = spawned.signalCode === "SIGTERM" && exitCode !== 0;
  const notes = [
    stdout.truncated || stderr.truncated
      ? `[output truncated to the last ${limits.outputLimitBytes} bytes per stream]\n`
      : "",
    timedOut ? `[command timed out after ${limits.timeoutMs}ms]\n` : "",
  ].join("");

  return {
    ok: exitCode === 0,
    output: `${notes}${stdout.text}${stderr.text}`,
  };
}
