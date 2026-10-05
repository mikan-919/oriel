import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

/** worktree内でcommandを実行する境界。credentialは渡らない。 */
export type RunCommand = (
  command: string[],
  cwd: string,
) => Promise<{ ok: boolean; output: string }>;

export interface WorktreeToolsOptions {
  worktreePath: string;
  runCommand: RunCommand;
}

/**
 * 承認された封印済みworktreeの中だけで動くtool群。
 *
 * ADR 0005のとおり、harnessへGitHub・Linearの汎用API中継は公開しない。ここに
 * あるのはworktree内のfile操作とcommand実行だけであり、worktreeの外は指せない。
 */
export function createWorktreeTools({
  worktreePath,
  runCommand,
}: WorktreeToolsOptions): AgentTool[] {
  const root = resolve(worktreePath);

  /** worktreeの外を指すpathは実行しない。 */
  function inside(path: string): string {
    const resolved = resolve(root, path);

    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
      throw new Error(`${path} is outside the approved worktree`);
    }

    return resolved;
  }

  function text(content: string) {
    return { content: [{ type: "text" as const, text: content }], details: {} };
  }

  /**
   * tool引数はmodelが組み立てた値であり、schema検証の前後どちらでもこの process
   * では信頼しない。期待した形でなければtoolを実行せず例外で止める。
   */
  function field(params: unknown, name: string): unknown {
    return typeof params === "object" && params !== null
      ? (params as Record<string, unknown>)[name]
      : undefined;
  }

  function stringField(params: unknown, name: string): string {
    const value = field(params, name);

    if (typeof value !== "string") {
      throw new Error(`${name} must be a string`);
    }

    return value;
  }

  function commandField(params: unknown): string[] {
    const value = field(params, "command");

    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((entry) => typeof entry !== "string" || entry === "")
    ) {
      throw new Error("command must be a non-empty array of strings");
    }

    return value as string[];
  }

  return [
    {
      name: "read_file",
      label: "Read file",
      description: "Read a UTF-8 file from the approved worktree.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_toolCallId, params) {
        return text(
          await readFile(inside(stringField(params, "path")), "utf8"),
        );
      },
    },
    {
      name: "write_file",
      label: "Write file",
      description:
        "Create or replace a UTF-8 file in the approved worktree. Parent directories are created.",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute(_toolCallId, params) {
        const target = inside(stringField(params, "path"));

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, stringField(params, "content"), "utf8");

        return text(`wrote ${relative(root, target)}`);
      },
    },
    {
      name: "list_files",
      label: "List files",
      description: "List the entries of a directory in the approved worktree.",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      async execute(_toolCallId, params) {
        const path = field(params, "path");
        const target = inside(
          path === undefined ? "." : stringField(params, "path"),
        );
        const entries = await readdir(target, { withFileTypes: true });

        return text(
          entries
            .map((entry) =>
              entry.isDirectory()
                ? `${join(relative(root, target), entry.name)}/`
                : join(relative(root, target), entry.name),
            )
            .join("\n"),
        );
      },
    },
    {
      name: "run_command",
      label: "Run command",
      description:
        "Run a command inside the approved worktree. The command is an argument array, not a shell string.",
      parameters: Type.Object({
        command: Type.Array(Type.String(), { minItems: 1 }),
      }),
      async execute(_toolCallId, params) {
        const run = await runCommand(commandField(params), root);

        return text(`${run.ok ? "ok" : "failed"}\n${run.output}`);
      },
    },
  ];
}
