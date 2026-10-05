import { useCallback, useEffect, useState } from "react";

import { parseInstanceConfig } from "@mikan-919/oriel-contracts";
import type { TranscriptEntry } from "@mikan-919/oriel-contracts";

import { ConfigModal } from "./ConfigModal";
import { ConversationView, EmptyMain } from "./Conversation";
import { NewJobModal } from "./NewJobModal";
import { Sidebar } from "./Sidebar";
import { isInstanceConfigComplete } from "./instance-config";
import type { Job, SelectedJob } from "./job";
import {
  conversationTranscriptLimit,
  jobListPollIntervalMs,
  transcriptPollIntervalMs,
} from "./limits";
import { toConversation, type ConversationEvent } from "./transcript";

export function App() {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ConversationEvent[]>([]);
  const [conversationError, setConversationError] = useState<string | null>(
    null,
  );
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [configModalOpen, setConfigModalOpen] = useState(false);

  const refreshJobs = useCallback(async () => {
    const response = await fetch("/api/jobs");

    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }

    const body = (await response.json()) as { jobs: Job[] };
    setJobs(body.jobs);
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetch("/app/session")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }

        return response.json() as Promise<{ csrfToken: string }>;
      })
      .then((session) => {
        if (!cancelled) {
          setCsrfToken(session.csrfToken);
        }

        return refreshJobs();
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });

    // 選択中のJobが完了して一覧から消えたことを検知できるよう、Job一覧自体も
    // ポーリングする。
    const interval = setInterval(() => {
      void refreshJobs().catch(() => undefined);
    }, jobListPollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refreshJobs]);

  // instance設定(relay origin、repositoryなど)が未完了の間は、初回設定として
  // 設定モーダルを自動的に開く。
  useEffect(() => {
    let cancelled = false;

    fetch("/api/instance-config")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (cancelled || body === null) {
          return;
        }

        if (!isInstanceConfigComplete(parseInstanceConfig(body))) {
          setConfigModalOpen(true);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Jobが一覧から消えたら(完了/失敗して片付いた)、それ以上ポーリングしない。
   * `jobs`そのものを依存にすると一覧のポーリングごとにintervalを作り直すので、
   * 判定結果の真偽値だけを依存にする。
   */
  const selectedJobRunning =
    selectedJobId !== null &&
    (jobs?.some((job) => job.jobId === selectedJobId) ?? true);

  useEffect(() => {
    if (selectedJobId === null) {
      return;
    }

    let cancelled = false;

    async function poll(jobId: string) {
      const response = await fetch(
        `/api/transcripts?scope=job&jobId=${encodeURIComponent(jobId)}&limit=${conversationTranscriptLimit}`,
      );

      if (!response.ok) {
        if (!cancelled) {
          setConversationError(`status ${response.status}`);
        }

        return;
      }

      const body = (await response.json()) as { entries: TranscriptEntry[] };

      if (!cancelled) {
        setConversationError(null);
        setConversation(toConversation(body.entries));
      }
    }

    void poll(selectedJobId);

    if (!selectedJobRunning) {
      return () => {
        cancelled = true;
      };
    }

    const interval = setInterval(
      () => void poll(selectedJobId),
      transcriptPollIntervalMs,
    );

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedJobId, selectedJobRunning]);

  function selectJob(jobId: string) {
    setSelectedJobId(jobId);
    setConversation([]);
    setConversationError(null);
  }

  const selectedJob: SelectedJob | null =
    selectedJobId === null
      ? null
      : (jobs?.find((job) => job.jobId === selectedJobId) ?? {
          jobId: selectedJobId,
          kind: null,
          status: null,
        });

  return (
    <div className="flex h-dvh bg-bg text-text">
      <Sidebar
        jobs={jobs}
        error={error}
        selectedJobId={selectedJobId}
        onSelectJob={selectJob}
        onNewJob={() => setNewModalOpen(true)}
        onOpenConfig={() => setConfigModalOpen(true)}
      />

      <main
        className={`${selectedJob === null ? "hidden md:block" : "block"} min-w-0 flex-1`}
      >
        {selectedJob === null && <EmptyMain />}
        {selectedJob !== null && (
          <ConversationView
            job={selectedJob}
            csrfToken={csrfToken}
            onBack={() => setSelectedJobId(null)}
            conversation={conversation}
            conversationError={conversationError}
          />
        )}
      </main>

      {newModalOpen && (
        <NewJobModal
          csrfToken={csrfToken}
          onClose={() => setNewModalOpen(false)}
          onStarted={refreshJobs}
        />
      )}
      {configModalOpen && (
        <ConfigModal
          csrfToken={csrfToken}
          onClose={() => setConfigModalOpen(false)}
        />
      )}
    </div>
  );
}
