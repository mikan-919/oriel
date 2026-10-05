import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search, Settings } from "lucide-react";

import type { TranscriptEntry } from "@mikan-919/oriel-contracts";
import { identity } from "@mikan-919/oriel-identity";

import { getApiErrorMessage } from "./api";
import {
  finishedJobLabel,
  kindIcon,
  kindLabel,
  statusTone,
  type Job,
} from "./job";
import { transcriptSearchDebounceMs, transcriptSearchLimit } from "./limits";
import { transcriptSnippet } from "./transcript";
import { Logo, StatusDot } from "./ui";

const transcriptScopes = [
  { value: "job", label: "このJob" },
  { value: "local", label: "この端末" },
  { value: "repository", label: "repository" },
] as const;

type TranscriptScope = (typeof transcriptScopes)[number]["value"];

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);

    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

/**
 * transcriptの全文検索。`job`と`local`はこの`serve`のSQLiteだけで完結し、
 * `repository`だけがrelay経由で同じrepositoryを担当する他の`serve`へ広がる。
 */
function TranscriptSearchResults({
  query,
  jobs,
  selectedJobId,
  onSelectJob,
}: {
  query: string;
  jobs: Job[];
  selectedJobId: string | null;
  onSelectJob: (jobId: string) => void;
}) {
  const [scope, setScope] = useState<TranscriptScope>("local");
  // Jobを選んでいないときにJob scopeを選ばせても結果が空になるだけなので、
  // 同じ端末の範囲へ落とす。
  const effectiveScope =
    scope === "job" && selectedJobId === null ? "local" : scope;
  const debouncedQuery = useDebounced(query.trim(), transcriptSearchDebounceMs);
  const results = useQuery({
    queryKey: [
      "transcript-search",
      effectiveScope,
      effectiveScope === "job" ? selectedJobId : null,
      debouncedQuery,
    ],
    enabled: debouncedQuery !== "",
    queryFn: async (): Promise<TranscriptEntry[]> => {
      const params = new URLSearchParams({
        scope: effectiveScope,
        query: debouncedQuery,
        limit: String(transcriptSearchLimit),
      });

      if (effectiveScope === "job" && selectedJobId !== null) {
        params.set("jobId", selectedJobId);
      }

      const response = await fetch(`/api/transcripts?${params.toString()}`);

      if (!response.ok) {
        throw new Error(
          getApiErrorMessage(await response.json().catch(() => null)),
        );
      }

      const body = (await response.json()) as { entries: TranscriptEntry[] };

      return body.entries;
    },
  });
  const entries = results.data ?? null;

  if (debouncedQuery === "") {
    return null;
  }

  return (
    <section className="mt-4 border-t border-border pt-3">
      <p className="px-2 pb-1.5 font-mono text-[11px] tracking-[0.15em] text-faint uppercase">
        ログ検索
      </p>

      <div className="mx-2 mb-2 flex gap-1 rounded-lg border border-border bg-bg p-0.5">
        {transcriptScopes.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setScope(option.value)}
            disabled={option.value === "job" && selectedJobId === null}
            className={`flex-1 rounded-md px-1.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              effectiveScope === option.value
                ? "bg-accent-soft text-accent"
                : "text-muted hover:text-text"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {results.isPending && (
        <p className="px-2 py-1.5 text-sm text-muted">検索中…</p>
      )}
      {results.isError && (
        <p role="alert" className="px-2 py-1.5 text-sm text-fail">
          {results.error.message}
        </p>
      )}
      {entries !== null && entries.length === 0 && (
        <p className="px-2 py-1.5 text-sm text-muted">
          一致するログはありません。
        </p>
      )}

      <ul className="flex flex-col gap-0.5">
        {(entries ?? []).map((entry) => {
          const job = jobs.find((candidate) => candidate.jobId === entry.jobId);

          return (
            <li key={`${entry.jobId}-${entry.sequence}`}>
              <button
                type="button"
                onClick={() => onSelectJob(entry.jobId)}
                className="w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-hover"
              >
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-xs text-muted">
                    {job === undefined ? finishedJobLabel : kindLabel[job.kind]}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
                    {new Date(entry.createdAt).toLocaleString([], {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </span>
                <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug break-all text-text">
                  {transcriptSnippet(entry)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Sidebar({
  jobs,
  error,
  selectedJobId,
  onSelectJob,
  onNewJob,
  onOpenConfig,
}: {
  jobs: Job[] | null;
  error: string | null;
  selectedJobId: string | null;
  onSelectJob: (jobId: string) => void;
  onNewJob: () => void;
  onOpenConfig: () => void;
}) {
  const [filterQuery, setFilterQuery] = useState("");
  const needle = filterQuery.trim().toLowerCase();
  const filteredJobs = (jobs ?? []).filter(
    (job) =>
      needle === "" ||
      job.jobId.toLowerCase().includes(needle) ||
      kindLabel[job.kind].toLowerCase().includes(needle),
  );

  return (
    <aside
      className={`${selectedJobId !== null ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-r border-border bg-sidebar md:w-72`}
    >
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <Logo />
        <span className="font-display text-base text-text">
          {identity.displayName}
        </span>
        <button
          type="button"
          onClick={onOpenConfig}
          aria-label="設定を編集"
          className="ml-auto rounded-md p-1.5 text-faint transition-colors hover:bg-surface-hover hover:text-text"
        >
          <Settings size={16} />
        </button>
      </div>

      <div className="px-4 pb-3">
        <button
          type="button"
          onClick={onNewJob}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-sidebar shadow-sm transition-all hover:bg-accent-hover active:scale-[0.98]"
        >
          <Plus size={15} />
          新規に始める
        </button>
      </div>

      <div className="px-4 pb-3">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint"
          />
          <input
            type="text"
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            placeholder="Jobとログを検索"
            className="w-full rounded-lg border border-border bg-bg py-1.5 pr-3 pl-8 text-sm text-text transition-colors placeholder:text-faint focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        <p className="px-2 pt-1 pb-1.5 font-mono text-[11px] tracking-[0.15em] text-faint uppercase">
          Workflow
        </p>

        {jobs === null && error === null && (
          <p className="px-2 py-2 text-sm text-muted">読み込み中…</p>
        )}
        {jobs === null && error !== null && (
          <p role="alert" className="px-2 py-2 text-sm text-fail">
            Job一覧の読み込みに失敗しました。
          </p>
        )}
        {jobs !== null && filteredJobs.length === 0 && (
          <p className="px-2 py-2 text-sm text-muted">
            {jobs.length === 0
              ? "実行中のJobはありません。"
              : "一致するJobがありません。"}
          </p>
        )}

        <ul className="flex flex-col gap-0.5">
          {filteredJobs.map((job) => {
            const Icon = kindIcon[job.kind];
            const tone = statusTone(job.status);
            const selected = job.jobId === selectedJobId;

            return (
              <li key={job.jobId} className="relative">
                {selected && (
                  <span
                    aria-hidden
                    className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent"
                  />
                )}
                <button
                  type="button"
                  onClick={() => onSelectJob(job.jobId)}
                  aria-current={selected}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    selected
                      ? "bg-accent-soft text-text"
                      : "text-muted hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  <Icon
                    size={15}
                    className={selected ? "text-accent" : "shrink-0"}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {kindLabel[job.kind]}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-faint">
                      {job.jobId}
                    </span>
                  </span>
                  <StatusDot tone={tone} />
                </button>
              </li>
            );
          })}
        </ul>

        <TranscriptSearchResults
          query={filterQuery}
          jobs={jobs ?? []}
          selectedJobId={selectedJobId}
          onSelectJob={onSelectJob}
        />
      </nav>

      <div className="flex items-center gap-2 border-t border-border px-4 py-3 font-mono text-xs text-faint">
        <StatusDot tone={error === null ? "live" : "fail"} />
        {error === null ? "connected" : "接続失敗"}
      </div>
    </aside>
  );
}
