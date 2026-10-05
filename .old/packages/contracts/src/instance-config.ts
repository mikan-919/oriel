import * as v from "valibot";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

/**
 * 利用者固有のinstance設定。relay origin、repository識別情報など、以前は
 * env varだけで渡していた値をlocal state SQLiteへ保存する。
 * `.oriel.yaml`のrepository実行設定とは別の正本であり、両者を混在させない。
 */
export const instanceConfigSchema = v.strictObject({
  relayOrigin: v.nullable(nonEmptyString),
  repositoryId: v.nullable(positiveInteger),
  repositoryOwner: v.nullable(nonEmptyString),
  repositoryName: v.nullable(nonEmptyString),
  repositoryRoot: v.nullable(nonEmptyString),
  worktreesRoot: v.nullable(nonEmptyString),
  linearTeamId: v.nullable(nonEmptyString),
  canonicalRemote: v.nullable(nonEmptyString),
  lmStudioBaseUrl: v.nullable(nonEmptyString),
});

export type InstanceConfig = v.InferOutput<typeof instanceConfigSchema>;

export function parseInstanceConfig(value: unknown): InstanceConfig {
  return v.parse(instanceConfigSchema, value);
}
