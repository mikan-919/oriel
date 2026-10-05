import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  History,
  Loader2,
  MessageCircle,
  Square,
  Wrench,
} from "lucide-react";

import { identity } from "@mikan-919/oriel-identity";

import { postJson } from "./api";
import {
  kindIcon,
  kindLabel,
  finishedJobLabel,
  statusTone,
  stoppableKinds,
  type SelectedJob,
} from "./job";
import type { ConversationEvent } from "./transcript";
import { Logo, StatusDot } from "./ui";

function ConversationBubble({ event }: { event: ConversationEvent }) {
  if (event.role === "assistant") {
    return (
      <p className="rise-in max-w-2xl text-[15px] leading-relaxed whitespace-pre-wrap text-text">
        {event.text}
      </p>
    );
  }

  if (event.role === "tool") {
    return (
      <div className="rise-in flex max-w-2xl items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">
        <Wrench size={13} className="mt-0.5 shrink-0 text-faint" />
        <span className="font-mono break-all">{event.text}</span>
      </div>
    );
  }

  if (event.role === "error") {
    return (
      <p className="rise-in max-w-2xl rounded-lg border border-fail/40 bg-fail/10 px-3 py-2 text-xs text-fail">
        {event.text}
      </p>
    );
  }

  return (
    <p className="rise-in font-mono text-[11px] tracking-wide text-faint uppercase">
      {event.text}
    </p>
  );
}

export function ConversationView({
  job,
  csrfToken,
  onBack,
  conversation,
  conversationError,
}: {
  job: SelectedJob;
  csrfToken: string | null;
  onBack: () => void;
  conversation: ConversationEvent[];
  conversationError: string | null;
}) {
  const Icon = job.kind === null ? History : kindIcon[job.kind];
  const tone = statusTone(job.status);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // 停止要求はJobごとの状態。Jobを切り替えたときにeffectでリセットせず、
  // どのJobへ要求したかをそのまま持つ。
  const [stoppingJobId, setStoppingJobId] = useState<string | null>(null);
  const stopping = stoppingJobId === job.jobId;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [conversation.length]);

  async function stop() {
    if (csrfToken === null || stopping) {
      return;
    }

    setStoppingJobId(job.jobId);
    await postJson(
      `/api/jobs/${encodeURIComponent(job.jobId)}/stop`,
      csrfToken,
      {},
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4 md:px-8">
          <button
            type="button"
            onClick={onBack}
            aria-label="Job一覧へ戻る"
            className="-ml-1 rounded-md p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-text md:hidden"
          >
            <ArrowLeft size={16} />
          </button>
          <Icon size={17} className="hidden md:block" />
          <div className="min-w-0">
            <p className="font-display text-base text-text">
              {job.kind === null ? finishedJobLabel : kindLabel[job.kind]}
            </p>
            <p className="font-mono text-xs text-faint">{job.jobId}</p>
          </div>
          <div className="ml-auto flex items-center gap-3 font-mono text-xs text-muted">
            {job.kind !== null && stoppableKinds.has(job.kind) && (
              <button
                type="button"
                onClick={() => void stop()}
                disabled={csrfToken === null || stopping}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-muted transition-colors hover:border-fail/50 hover:text-fail disabled:cursor-not-allowed disabled:opacity-40"
              >
                {stopping ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Square size={12} />
                )}
                {stopping ? "停止中…" : "停止"}
              </button>
            )}
            {/* 一覧に無いJobの状態は`serve`が持っていないので、稼働中に見える
                表示を作らず、記録を読んでいることだけを示す。 */}
            {job.kind === null ? (
              <span>記録のみ</span>
            ) : (
              <span className="flex items-center gap-2">
                <StatusDot tone={tone} />
                {job.status ?? "unknown"}
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-6">
          {job.kind === "issue_conversation" && (
            <div className="flex h-[60vh] flex-col items-center justify-center gap-2 text-center">
              <MessageCircle size={28} className="text-faint" />
              <p className="max-w-sm text-sm text-muted">
                このJob種別はGitHub
                Issueへ返答を投稿するだけで、Agentは呼ばれず対話ログは記録されません。
              </p>
            </div>
          )}

          {job.kind !== "issue_conversation" && (
            <>
              {conversationError !== null && (
                <p role="alert" className="text-sm text-fail">
                  読み込みに失敗しました: {conversationError}
                </p>
              )}
              {conversationError === null &&
                conversation.length === 0 &&
                (job.kind === null ? (
                  <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-center text-muted">
                    <History size={20} className="text-faint" />
                    {/* ponytail: 検索結果はlocalと他serveの記録を混ぜて返すため、
                        他serveのJobもここへ来る。区別が要るなら検索結果に由来を
                        持たせる。 */}
                    <p className="text-sm">
                      この端末にはこのJobのログがありません。
                    </p>
                  </div>
                ) : (
                  <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-center text-muted">
                    <Loader2 size={20} className="animate-spin text-faint" />
                    <p className="text-sm">ログを待っています…</p>
                  </div>
                ))}
              {conversation.length > 0 && (
                <ol className="flex flex-col gap-4">
                  {conversation.map((event) => (
                    <li key={event.key}>
                      <ConversationBubble event={event} />
                    </li>
                  ))}
                </ol>
              )}
              {conversation.length > 0 && <div ref={bottomRef} aria-hidden />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function EmptyMain() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="opacity-70">
        <Logo />
      </div>
      <div>
        <h1 className="font-display text-2xl text-text">
          {identity.displayName}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
          左のJob一覧から選ぶと、実行ログがここに流れます。新しい対話や実装Jobは「新規」から始められます。
        </p>
      </div>
    </div>
  );
}
