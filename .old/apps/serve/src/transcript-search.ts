import type {
  GitHubRepository,
  TranscriptEntry,
} from "@mikan-919/oriel-contracts";

import type { NotificationConnection } from "./notification-connection";
import type { TranscriptStore } from "./transcript-store";

export interface TranscriptSearchInput {
  /** `job`と`local`はこの`serve`のSQLiteだけで完結する。`repository`だけがrelay経由で他のserveへも届く。 */
  scope: "job" | "local" | "repository";
  jobId?: string;
  query: string;
  limit: number;
}

/**
 * ROADMAPの「local、current Job、repositoryの範囲」を一つの窓にまとめる。
 *
 * `job`/`local`は`store`だけで完結させ、`repository`はそれに加えて
 * `connection.searchRepository`でrelayが中継する同一repositoryの他の`serve`を
 * 待ち合わせて合流させる。relay側はqueryも結果も保存しない。
 */
export function createTranscriptSearch(
  store: TranscriptStore,
  connection: Pick<NotificationConnection, "searchRepository">,
  repository: GitHubRepository,
) {
  return async function search(
    input: TranscriptSearchInput,
  ): Promise<TranscriptEntry[]> {
    const local = store.search({
      repository,
      scope: input.scope === "job" ? "job" : "local",
      jobId: input.jobId,
      query: input.query,
      limit: input.limit,
    });

    if (input.scope !== "repository") {
      return local;
    }

    const remote = await connection.searchRepository({
      jobId: input.jobId,
      query: input.query,
      limit: input.limit,
    });

    return [...local, ...remote].slice(0, input.limit);
  };
}
