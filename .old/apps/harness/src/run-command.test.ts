import { expect, test } from "bun:test";

import { runCommand } from "./run-command";

const limits = { timeoutMs: 30_000, outputLimitBytes: 1024 };

test("a command reports its exit status and combined output", async () => {
  const ok = await runCommand(
    ["sh", "-c", "echo out; echo err 1>&2"],
    process.cwd(),
    limits,
  );

  expect(ok.ok).toBe(true);
  expect(ok.output).toContain("out");
  expect(ok.output).toContain("err");

  const failed = await runCommand(
    ["sh", "-c", "exit 3"],
    process.cwd(),
    limits,
  );

  expect(failed.ok).toBe(false);
});

test("a command that does not answer is stopped instead of hanging the Job", async () => {
  const started = Date.now();
  const run = await runCommand(["sleep", "30"], process.cwd(), {
    ...limits,
    timeoutMs: 250,
  });

  expect(run.ok).toBe(false);
  expect(run.output).toContain("timed out");
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("runaway output is capped and keeps the tail where failures appear", async () => {
  const run = await runCommand(
    ["sh", "-c", "yes filler | head -c 200000; echo VERIFICATION_FAILED"],
    process.cwd(),
    limits,
  );

  expect(run.output).toContain("truncated");
  // 上限は「取り込む出力」に効く。注記の分を足しても桁違いに膨らまないこと。
  expect(run.output.length).toBeLessThan(limits.outputLimitBytes * 2);
  // 末尾を残すので、buildやtestが最後に出す失敗の手掛かりは消えない。
  expect(run.output).toContain("VERIFICATION_FAILED");
});
