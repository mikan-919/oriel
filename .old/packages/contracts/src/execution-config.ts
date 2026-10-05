import * as v from "valibot";
import { parseDocument } from "yaml";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * repository rootの実行設定。
 *
 * ROADMAPの「実行環境」のとおり、`schemaVersion: 1`、`execution.backend:
 * worktree`、`execution.autonomous: true`を明示した場合だけ、worktreeで自立Jobを
 * 開始できる。欠落、未知field、未知versionはすべてfail closedにする。
 *
 * 検証commandもこの設定だけを正本にし、省略や空配列でverified扱いになることが
 * ないよう、最低一つのcommandを要求する。
 */
/**
 * ADR 0009のとおり、pi-aiの`Model`が持つ自動検査可能な4 fieldに対応する要求
 * だけを扱う。省略時はmodelへの制約なし。`reasoning`/`image`は要求することだけ
 * を表現すればよいため、`autonomous: true`と同じ慣習で`v.literal(true)`とする。
 */
export const modelCapabilitiesSchema = v.strictObject({
  reasoning: v.optional(v.literal(true)),
  image: v.optional(v.literal(true)),
  minContextWindow: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  minMaxTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

export type ModelCapabilities = v.InferOutput<typeof modelCapabilitiesSchema>;

export const executionConfigSchema = v.strictObject({
  schemaVersion: v.literal(1),
  execution: v.strictObject({
    backend: v.literal("worktree"),
    autonomous: v.literal(true),
    /** worktree内で順に実行する検証command。shell文字列ではなく引数配列とする。 */
    verification: v.pipe(
      v.array(v.pipe(v.array(nonEmptyString), v.minLength(1))),
      v.minLength(1),
    ),
  }),
  /**
   * modelを使う4 Job種別へ共通適用するmodel要求。`execution`と異なり、
   * 「実行を許可するかどうか」のgateではなく任意で追加できる制約なので省略可能。
   */
  modelCapabilities: v.optional(modelCapabilitiesSchema),
});

export type ExecutionConfig = v.InferOutput<typeof executionConfigSchema>;

export type ExecutionConfigParse =
  | { status: "parsed"; config: ExecutionConfig }
  /** YAML 1.2として読めない、またはcustom tagなど許可しない記法を含む。 */
  | { status: "invalid"; reason: "yaml_unparsable" | "schema_violation" };

/**
 * YAML 1.2としてparseした後、strict schemaで検証する。
 *
 * transform、default、coercionを行わないため、書かれていない設定が既定値で
 * 埋まることはない。実行可能な設定、環境変数展開、YAML custom tagも許可しない。
 */
export function parseExecutionConfig(source: string): ExecutionConfigParse {
  let value: unknown;

  try {
    const document = parseDocument(source, {
      version: "1.2",
      schema: "core",
      customTags: [],
    });

    // 解決できないtagはwarningとして現れる。既定値へ落とさずfail closedにする。
    if (document.errors.length > 0 || document.warnings.length > 0) {
      return { status: "invalid", reason: "yaml_unparsable" };
    }

    value = document.toJS();
  } catch {
    return { status: "invalid", reason: "yaml_unparsable" };
  }

  const parsed = v.safeParse(executionConfigSchema, value);

  return parsed.success
    ? { status: "parsed", config: parsed.output }
    : { status: "invalid", reason: "schema_violation" };
}
