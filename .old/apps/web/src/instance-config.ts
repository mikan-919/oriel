import type { InstanceConfig } from "@mikan-919/oriel-contracts";

import { environmentVariable } from "./api";

/** relay origin、repositoryなど、初回起動時にWeb UIから入力するinstance設定。 */
export type InstanceConfigFormField = keyof InstanceConfig;

export const instanceConfigFields: {
  key: InstanceConfigFormField;
  label: string;
  env: string;
  required: boolean;
  type: "text" | "number";
}[] = [
  {
    key: "relayOrigin",
    label: "Relay origin",
    env: environmentVariable("RELAY_ORIGIN"),
    required: true,
    type: "text",
  },
  {
    key: "repositoryId",
    label: "Repository ID",
    env: environmentVariable("REPOSITORY_ID"),
    required: true,
    type: "number",
  },
  {
    key: "repositoryOwner",
    label: "Repository owner",
    env: environmentVariable("REPOSITORY_OWNER"),
    required: true,
    type: "text",
  },
  {
    key: "repositoryName",
    label: "Repository name",
    env: environmentVariable("REPOSITORY_NAME"),
    required: true,
    type: "text",
  },
  {
    key: "repositoryRoot",
    label: "Repository root",
    env: environmentVariable("REPOSITORY_ROOT"),
    required: true,
    type: "text",
  },
  {
    key: "worktreesRoot",
    label: "Worktrees root",
    env: environmentVariable("WORKTREES_ROOT"),
    required: true,
    type: "text",
  },
  {
    key: "linearTeamId",
    label: "Linear team ID",
    env: environmentVariable("LINEAR_TEAM_ID"),
    required: false,
    type: "text",
  },
  {
    key: "canonicalRemote",
    label: "Canonical remote",
    env: environmentVariable("CANONICAL_REMOTE"),
    required: false,
    type: "text",
  },
  {
    key: "lmStudioBaseUrl",
    label: "LM Studio base URL",
    env: environmentVariable("LM_STUDIO_BASE_URL"),
    required: false,
    type: "text",
  },
];

export type InstanceConfigForm = Record<InstanceConfigFormField, string>;

export function instanceConfigToForm(
  config: InstanceConfig,
): InstanceConfigForm {
  return Object.fromEntries(
    instanceConfigFields.map((field) => [
      field.key,
      config[field.key] === null ? "" : String(config[field.key]),
    ]),
  ) as InstanceConfigForm;
}

/** 空欄はnull、number欄だけNumberへ戻して`POST /api/instance-config`の本文にする。 */
export function instanceConfigFormToPayload(
  form: InstanceConfigForm,
): Record<InstanceConfigFormField, string | number | null> {
  return Object.fromEntries(
    instanceConfigFields.map((field) => {
      const raw = form[field.key].trim();

      if (raw === "") {
        return [field.key, null];
      }

      return [field.key, field.type === "number" ? Number(raw) : raw];
    }),
  ) as Record<InstanceConfigFormField, string | number | null>;
}

/** instance設定は未設定のフィールドが一つでもあれば、初回設定として扱う。 */
export function isInstanceConfigComplete(config: InstanceConfig): boolean {
  return instanceConfigFields
    .filter((field) => field.required)
    .every((field) => config[field.key] !== null);
}
