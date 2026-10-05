import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";

import { identity } from "@mikan-919/oriel-identity";

import { getApiErrorMessage, postJson } from "./api";
import { Field, inputClass, PrimaryButton } from "./ui";

export function NewJobModal({
  csrfToken,
  onClose,
  onStarted,
}: {
  csrfToken: string | null;
  onClose: () => void;
  onStarted: () => Promise<void>;
}) {
  const [kind, setKind] = useState<"issue" | "linear" | "implementation">(
    "issue",
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (csrfToken === null) {
      return;
    }

    const form = new FormData(event.currentTarget);
    const path =
      kind === "issue"
        ? "/api/issue-conversations"
        : kind === "linear"
          ? "/api/how-conversations"
          : "/api/implementation-jobs";
    const modelProvider = String(form.get("modelProvider") ?? "").trim();
    const modelId = String(form.get("modelId") ?? "").trim();

    if (
      kind === "implementation" &&
      (modelProvider === "") !== (modelId === "")
    ) {
      setFormError(
        "model providerとmodel IDのoverrideは両方入力するか、両方空欄にしてください。",
      );
      return;
    }

    const payload =
      kind === "issue"
        ? {
            issueNumber: Number(form.get("issueNumber")),
            body: String(form.get("body") ?? ""),
          }
        : kind === "linear"
          ? {
              issueNumber: Number(form.get("issueNumber")),
              linearIssueId: String(form.get("linearIssueId") ?? ""),
              body: String(form.get("body") ?? ""),
              command: form.get("command") === "on",
            }
          : {
              linearIssueId: String(form.get("linearIssueId") ?? ""),
              ...(modelProvider === ""
                ? {}
                : { modelOverride: { provider: modelProvider, id: modelId } }),
            };

    setPending(true);

    const { ok, body } = await postJson(path, csrfToken, payload);

    setPending(false);

    if (!ok) {
      setFormError(getApiErrorMessage(body));
      return;
    }

    await onStarted();
    onClose();
  }

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
        aria-label="新規Jobを始める"
        className="rise-in w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-lg"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-lg text-text">新規に始める</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="rounded-md p-1 text-faint transition-colors hover:bg-surface-hover hover:text-text"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mb-5 flex gap-1 rounded-lg border border-border bg-bg p-1">
          {(
            [
              { value: "issue", label: "Issue対話" },
              { value: "linear", label: "Linear対話" },
              { value: "implementation", label: "実装Job" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setKind(tab.value)}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${
                kind === tab.value
                  ? "bg-accent-soft text-accent"
                  : "text-muted hover:text-text"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4">
          {kind === "issue" && (
            <>
              <Field label="Issue番号">
                <input
                  name="issueNumber"
                  type="number"
                  required
                  min={1}
                  className={inputClass}
                  autoFocus
                />
              </Field>
              <Field label="返答本文">
                <textarea
                  name="body"
                  required
                  rows={4}
                  className={`${inputClass} resize-y`}
                />
              </Field>
            </>
          )}
          {kind === "linear" && (
            <>
              <Field label="Issue番号">
                <input
                  name="issueNumber"
                  type="number"
                  required
                  min={1}
                  className={inputClass}
                  autoFocus
                />
              </Field>
              <Field label="Triage中のLinear issue ID">
                <input
                  name="linearIssueId"
                  type="text"
                  required
                  className={inputClass}
                />
              </Field>
              <Field label="返答本文">
                <textarea
                  name="body"
                  required
                  rows={4}
                  className={`${inputClass} resize-y`}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm text-muted">
                <input name="command" type="checkbox" />
                この回答でHOWの確定を求める(/{identity.cliName} confirm相当)
              </label>
            </>
          )}
          {kind === "implementation" && (
            <>
              <Field label="承認済みLinear issue ID">
                <input
                  name="linearIssueId"
                  type="text"
                  required
                  className={inputClass}
                  autoFocus
                />
              </Field>
              <div className="rounded-lg border border-border bg-bg p-3">
                <p className="text-sm text-text">Job単独override（任意）</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  空欄ならimplementationのper-kindまたはbase既定値を使います。この指定は保存されません。
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="Provider override">
                    <input
                      name="modelProvider"
                      type="text"
                      className={inputClass}
                      placeholder="provider"
                    />
                  </Field>
                  <Field label="Model ID override">
                    <input
                      name="modelId"
                      type="text"
                      className={inputClass}
                      placeholder="model ID"
                    />
                  </Field>
                </div>
              </div>
            </>
          )}

          {formError !== null && (
            <p role="alert" className="text-xs text-fail">
              開始に失敗しました: {formError}
            </p>
          )}

          <PrimaryButton disabled={csrfToken === null || pending}>
            {pending && <Loader2 size={14} className="animate-spin" />}
            開始する
          </PrimaryButton>
        </form>
      </div>
    </div>
  );
}
