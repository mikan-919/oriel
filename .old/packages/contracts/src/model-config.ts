import * as v from "valibot";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

/** modelを使うJob種別。issue_conversationは人間の本文を中継するだけである。 */
export const modelDefaultKinds = [
  "what_confirmation",
  "how_confirmation",
  "pr_response",
  "implementation",
] as const;

export type ModelDefaultKind = (typeof modelDefaultKinds)[number];
export type ModelDefaultScope = "base" | ModelDefaultKind;

export const modelDefaultScopeSchema = v.picklist([
  "base",
  ...modelDefaultKinds,
]);

/** serve内部とharness IPCで使う論理的なprovider/model識別子。 */
export const modelSelectionSchema = v.strictObject({
  provider: nonEmptyString,
  id: nonEmptyString,
});

export type ModelSelection = v.InferOutput<typeof modelSelectionSchema>;

/** /api/configで公開する、model IDを明示した選択値。 */
export const modelDefaultApiSelectionSchema = v.strictObject({
  provider: nonEmptyString,
  modelId: nonEmptyString,
});

export type ModelDefaultApiSelection = v.InferOutput<
  typeof modelDefaultApiSelectionSchema
>;

/** /api/configの更新入力。両方nullだけが既定値の解除を表す。 */
export const modelDefaultUpdateSchema = v.pipe(
  v.strictObject({
    scope: modelDefaultScopeSchema,
    provider: v.nullable(nonEmptyString),
    modelId: v.nullable(nonEmptyString),
  }),
  v.check(
    (input) =>
      (input.provider === null && input.modelId === null) ||
      (input.provider !== null && input.modelId !== null),
    "providerとmodelIdは両方指定するか、両方nullで指定してください。",
  ),
);

export type ModelDefaultUpdate = v.InferOutput<typeof modelDefaultUpdateSchema>;

/** /api/configのmodelDefaults部分。 */
export const modelDefaultsDtoSchema = v.strictObject({
  base: v.nullable(modelDefaultApiSelectionSchema),
  perKind: v.strictObject({
    what_confirmation: v.nullable(modelDefaultApiSelectionSchema),
    how_confirmation: v.nullable(modelDefaultApiSelectionSchema),
    pr_response: v.nullable(modelDefaultApiSelectionSchema),
    implementation: v.nullable(modelDefaultApiSelectionSchema),
  }),
});

export type ModelDefaultsDto = v.InferOutput<typeof modelDefaultsDtoSchema>;

export const serveConfigSchema = v.strictObject({
  relayOrigin: v.optional(v.string()),
  repositoryId: v.optional(v.number()),
  repositoryOwner: v.optional(v.string()),
  repositoryName: v.optional(v.string()),
  modelProviderId: v.optional(v.string()),
  modelId: v.optional(v.string()),
  modelDefaults: modelDefaultsDtoSchema,
});

export type ServeConfig = v.InferOutput<typeof serveConfigSchema>;

export const implementationJobRequestSchema = v.strictObject({
  linearIssueId: nonEmptyString,
  modelOverride: v.optional(modelSelectionSchema),
});

export type ImplementationJobRequest = v.InferOutput<
  typeof implementationJobRequestSchema
>;

export const modelOptionSchema = v.strictObject({
  provider: nonEmptyString,
  id: nonEmptyString,
  name: v.string(),
});

export type ModelOption = v.InferOutput<typeof modelOptionSchema>;

export interface ModelDefaults {
  base: ModelSelection | null;
  perKind: Record<ModelDefaultKind, ModelSelection | null>;
}

export function parseServeConfig(value: unknown): ServeConfig {
  return v.parse(serveConfigSchema, value);
}

export function parseModelOptions(value: unknown): ModelOption[] {
  return v.parse(v.array(modelOptionSchema), value);
}
