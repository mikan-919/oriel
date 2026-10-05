import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";

import {
  modelDefaultKinds,
  parseInstanceConfig,
  parseModelOptions,
  parseServeConfig,
} from "@mikan-919/oriel-contracts";
import type {
  InstanceConfig,
  ModelDefaultApiSelection,
  ModelDefaultKind,
  ModelDefaultsDto,
  ModelOption,
  ServeConfig,
} from "@mikan-919/oriel-contracts";

import { environmentVariable, getApiErrorMessage, postJson } from "./api";
import {
  instanceConfigFields,
  instanceConfigFormToPayload,
  instanceConfigToForm,
  type InstanceConfigForm,
} from "./instance-config";
import { Field, inputClass, PrimaryButton } from "./ui";

type ModelKind = ModelDefaultKind;
type ModelSelection = ModelDefaultApiSelection;

const modelKindLabels: Record<ModelDefaultKind, string> = {
  what_confirmation: "WHAT確定",
  how_confirmation: "HOW確定",
  pr_response: "PR対応",
  implementation: "実装",
};
const modelKinds: readonly { kind: ModelKind; label: string }[] =
  modelDefaultKinds.map((kind) => ({ kind, label: modelKindLabels[kind] }));

function emptyPerKind(): Record<ModelKind, ModelSelection | null> {
  return Object.fromEntries(
    modelDefaultKinds.map((kind) => [kind, null]),
  ) as Record<ModelKind, ModelSelection | null>;
}

function ModelInput({
  provider,
  value,
  models,
  onChange,
}: {
  provider: string;
  value: string;
  models: ModelOption[];
  onChange: (value: string) => void;
}) {
  const providerModels = models.filter((model) => model.provider === provider);

  if (providerModels.length === 0) {
    return (
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="model IDを入力"
        className={inputClass}
      />
    );
  }

  const hasCurrentValue = providerModels.some((model) => model.id === value);

  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={inputClass}
    >
      <option value="">modelを選択</option>
      {value !== "" && !hasCurrentValue && (
        <option value={value}>{value}（現在値）</option>
      )}
      {providerModels.map((model) => (
        <option key={`${model.provider}/${model.id}`} value={model.id}>
          {model.name} · {model.id}
        </option>
      ))}
    </select>
  );
}

/**
 * instance設定のフォーム。読み込み済みの設定を初期値としてマウントするので、
 * 取得結果をeffectでstateへ写し直さない。
 */
function InstanceConfigSection({
  initial,
  csrfToken,
}: {
  initial: InstanceConfig;
  csrfToken: string | null;
}) {
  const [form, setForm] = useState<InstanceConfigForm>(() =>
    instanceConfigToForm(initial),
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: async (values: InstanceConfigForm) => {
      if (csrfToken === null) {
        throw new Error("CSRF tokenがありません。");
      }

      const result = await postJson(
        "/api/instance-config",
        csrfToken,
        instanceConfigFormToPayload(values),
      );

      if (!result.ok) {
        throw new Error(getApiErrorMessage(result.body));
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["instance-config"] });
      void queryClient.invalidateQueries({ queryKey: ["serve-config"] });
    },
  });

  async function save() {
    setSaveError(null);
    setSavedMessage(null);

    try {
      await saveMutation.mutateAsync(form);
      setSavedMessage("保存しました。同じプロセスのまま反映します。");
    } catch (cause: unknown) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="space-y-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {instanceConfigFields.map((field) => (
          <Field
            key={field.key}
            label={`${field.label}${field.required ? "" : "（任意）"}`}
          >
            <input
              type={field.type}
              value={form[field.key]}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  [field.key]: event.target.value,
                }))
              }
              placeholder={field.env}
              className={inputClass}
            />
          </Field>
        ))}
      </div>

      {saveError !== null && (
        <p role="alert" className="text-xs text-fail">
          保存に失敗しました: {saveError}
        </p>
      )}
      {savedMessage !== null && (
        <p role="status" className="text-xs text-muted">
          {savedMessage}
        </p>
      )}

      <div className="flex justify-end">
        <PrimaryButton disabled={csrfToken === null || saveMutation.isPending}>
          {saveMutation.isPending && (
            <Loader2 size={14} className="animate-spin" />
          )}
          instance設定を保存
        </PrimaryButton>
      </div>
    </form>
  );
}

function selectionForSave(
  value: ModelSelection,
  label: string,
): ModelSelection | null {
  const provider = value.provider.trim();
  const modelId = value.modelId.trim();

  if (provider === "" && modelId === "") {
    return null;
  }

  if (provider === "" || modelId === "") {
    throw new Error(`${label}のproviderとmodel IDを両方入力してください。`);
  }

  return { provider, modelId };
}

/**
 * base既定値とJob種別ごとのoverride。instance設定と同じく、読み込み済みの値を
 * 初期値としてマウントする。
 */
function ModelDefaultsForm({
  initial,
  models,
  csrfToken,
}: {
  initial: ModelDefaultsDto;
  models: ModelOption[] | null;
  csrfToken: string | null;
}) {
  const [base, setBase] = useState<ModelSelection>(
    () => initial.base ?? { provider: "", modelId: "" },
  );
  const [perKind, setPerKind] = useState<
    Record<ModelKind, ModelSelection | null>
  >(() => ({ ...emptyPerKind(), ...initial.perKind }));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: async (
      updates: {
        scope: "base" | ModelKind;
        selection: ModelSelection | null;
      }[],
    ) => {
      if (csrfToken === null) {
        throw new Error("CSRF tokenがありません。");
      }

      for (const update of updates) {
        const result = await postJson("/api/config", csrfToken, {
          scope: update.scope,
          provider: update.selection?.provider ?? null,
          modelId: update.selection?.modelId ?? null,
        });

        if (!result.ok) {
          throw new Error(getApiErrorMessage(result.body));
        }
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["serve-config"] });
    },
  });

  function updatePerKind(kind: ModelKind, value: ModelSelection | null) {
    setPerKind((current) => ({ ...current, [kind]: value }));
  }

  async function save() {
    if (csrfToken === null) {
      return;
    }

    setSaveError(null);
    setSavedMessage(null);

    try {
      const updates: {
        scope: "base" | ModelKind;
        selection: ModelSelection | null;
      }[] = [
        { scope: "base", selection: selectionForSave(base, "base") },
        ...modelKinds.map(({ kind, label }) => {
          const override = perKind[kind];

          return {
            scope: kind,
            selection:
              override === null ? null : selectionForSave(override, label),
          };
        }),
      ];

      await saveMutation.mutateAsync(updates);

      setSavedMessage("保存しました。");
    } catch (cause: unknown) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="mt-6 space-y-6"
    >
      <section className="space-y-3">
        <div>
          <p className="font-mono text-[11px] tracking-[0.15em] text-faint uppercase">
            base / instance default
          </p>
          <p className="mt-1 text-xs text-muted">
            全Job種別がper-kind overrideを持たない場合に使います。
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Provider">
            <input
              type="text"
              value={base.provider}
              onChange={(event) =>
                setBase((current) => ({
                  ...current,
                  provider: event.target.value,
                }))
              }
              placeholder="例: openai / lm-studio"
              className={inputClass}
            />
          </Field>
          <Field label="Model ID">
            <ModelInput
              provider={base.provider}
              value={base.modelId}
              models={models ?? []}
              onChange={(modelId) =>
                setBase((current) => ({ ...current, modelId }))
              }
            />
          </Field>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <p className="font-mono text-[11px] tracking-[0.15em] text-faint uppercase">
            per-kind defaults
          </p>
          <p className="mt-1 text-xs text-muted">
            自動起動されるJobは、ここで指定したmodelをJob作成時に固定します。
          </p>
        </div>
        <div className="space-y-3">
          {modelKinds.map(({ kind, label }) => {
            const override = perKind[kind];
            const usesBase = override === null;

            return (
              <div
                key={kind}
                className="rounded-lg border border-border bg-bg px-3 py-3"
              >
                <label className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={usesBase}
                    onChange={(event) =>
                      updatePerKind(
                        kind,
                        event.target.checked ? null : (override ?? { ...base }),
                      )
                    }
                  />
                  <span>{label}</span>
                  <span className="text-xs text-muted">baseを使う</span>
                </label>

                {!usesBase && override !== null && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Provider override">
                      <input
                        type="text"
                        value={override.provider}
                        onChange={(event) =>
                          updatePerKind(kind, {
                            ...override,
                            provider: event.target.value,
                          })
                        }
                        placeholder="provider"
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Model ID override">
                      <ModelInput
                        provider={override.provider}
                        value={override.modelId}
                        models={models ?? []}
                        onChange={(modelId) =>
                          updatePerKind(kind, {
                            ...override,
                            modelId,
                          })
                        }
                      />
                    </Field>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {models === null && (
        <p className="text-xs text-muted">model一覧を読み込み中…</p>
      )}
      {models !== null && models.length === 0 && (
        <p className="text-xs text-muted">
          model一覧を取得できないため、model IDを自由入力できます。
        </p>
      )}
      {saveError !== null && (
        <p role="alert" className="text-xs text-fail">
          保存に失敗しました: {saveError}
        </p>
      )}
      {savedMessage !== null && (
        <p role="status" className="text-xs text-muted">
          {savedMessage}
        </p>
      )}

      <div className="flex justify-end">
        <PrimaryButton disabled={csrfToken === null || saveMutation.isPending}>
          {saveMutation.isPending && (
            <Loader2 size={14} className="animate-spin" />
          )}
          設定を保存
        </PrimaryButton>
      </div>
    </form>
  );
}

export function ConfigModal({
  csrfToken,
  onClose,
}: {
  csrfToken: string | null;
  onClose: () => void;
}) {
  const instanceConfigQuery = useQuery({
    queryKey: ["instance-config"],
    queryFn: async (): Promise<InstanceConfig> => {
      const response = await fetch("/api/instance-config");
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(getApiErrorMessage(body));
      }

      return parseInstanceConfig(body);
    },
  });
  const configQuery = useQuery({
    queryKey: ["serve-config"],
    queryFn: async (): Promise<ServeConfig> => {
      const response = await fetch("/api/config");
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(getApiErrorMessage(body));
      }

      return parseServeConfig(body);
    },
  });
  const modelsQuery = useQuery({
    queryKey: ["serve-models"],
    queryFn: async (): Promise<ModelOption[]> => {
      try {
        const response = await fetch("/api/models");
        const body = await response.json().catch(() => null);

        return response.ok ? parseModelOptions(body) : [];
      } catch {
        return [];
      }
    },
  });
  const instanceConfig = instanceConfigQuery.data ?? null;
  const config = configQuery.data ?? null;
  const models = modelsQuery.data ?? null;
  const error = configQuery.isError ? "設定を読み込めませんでした。" : null;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // MODEL_PROVIDER/MODEL_IDはbase既定値のenv移行元に過ぎず、SQLiteが正本に
  // なった後もenv var自体はここでは編集できない読み取り専用表示のままとする。
  const envOnlyFields = [
    {
      label: "Model provider (env移行元)",
      env: environmentVariable("MODEL_PROVIDER"),
      value: config?.modelProviderId,
    },
    {
      label: "Model ID (env移行元)",
      env: environmentVariable("MODEL_ID"),
      value: config?.modelId,
    },
  ].filter((field) => field.value !== undefined);

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="設定を編集"
        className="rise-in max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg text-text">設定</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded-md p-1 text-faint transition-colors hover:bg-surface-hover hover:text-text"
          >
            <X size={16} />
          </button>
        </div>

        <section className="mt-5 space-y-3">
          <div>
            <p className="font-mono text-[11px] tracking-[0.15em] text-faint uppercase">
              instance設定
            </p>
            <p className="mt-1 text-xs text-muted">
              relay
              origin、repositoryなどこのserve固有の設定です。保存すると再起動せずに反映されます。
            </p>
          </div>

          {instanceConfigQuery.isError && (
            <p role="alert" className="text-sm text-fail">
              instance設定を読み込めませんでした。
            </p>
          )}
          {instanceConfig === null && !instanceConfigQuery.isError && (
            <p className="text-sm text-muted">読み込み中…</p>
          )}

          {instanceConfig !== null && (
            <InstanceConfigSection
              initial={instanceConfig}
              csrfToken={csrfToken}
            />
          )}

          {envOnlyFields.length > 0 && (
            <dl className="space-y-3">
              {envOnlyFields.map((field) => (
                <div
                  key={field.env}
                  className="rounded-lg border border-border bg-bg px-3 py-2"
                >
                  <dt className="flex items-baseline justify-between gap-3 text-xs text-muted">
                    <span>{field.label}</span>
                    <span className="font-mono text-[10px] text-faint">
                      {field.env}
                    </span>
                  </dt>
                  <dd className="mt-1 font-mono text-sm break-all text-text">
                    {String(field.value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <div className="mt-6 border-t border-border pt-5">
          <p className="font-mono text-[11px] tracking-[0.15em] text-faint uppercase">
            モデル設定
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            baseを共通の既定値として、Job種別ごとに上書きできます。空のper-kind欄はbaseを使います。
          </p>
        </div>

        {config === null && error === null && (
          <p className="mt-5 text-sm text-muted">読み込み中…</p>
        )}
        {error !== null && (
          <p role="alert" className="mt-5 text-sm text-fail">
            {error}
          </p>
        )}
        {config !== null && (
          <ModelDefaultsForm
            initial={config.modelDefaults}
            models={models}
            csrfToken={csrfToken}
          />
        )}
      </div>
    </div>
  );
}
