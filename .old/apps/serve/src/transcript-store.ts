import type {
  GitHubRepository,
  TranscriptEntry,
} from "@mikan-919/oriel-contracts";
import type { Database } from "bun:sqlite";

const ftsMinimumQueryLength = 3;

export interface TranscriptAppendInput {
  jobId: string;
  repository: GitHubRepository;
  kind: string;
  content: string;
}

export interface TranscriptSearchInput {
  repository: GitHubRepository;
  /** `job`は`jobId`の一件だけ、`local`はこの`serve`が持つrepository全体を見る。 */
  scope: "job" | "local";
  jobId?: string;
  query: string;
  limit: number;
}

export interface TranscriptStore {
  /** Job単位の連番はrepositoryごとのSQLiteが正本として振る。 */
  append(input: TranscriptAppendInput): void;
  search(input: TranscriptSearchInput): TranscriptEntry[];
}

interface TranscriptRow {
  job_id: string;
  sequence: number;
  kind: string;
  content: string;
  created_at: number;
}

function toEntry(row: TranscriptRow): TranscriptEntry {
  return {
    jobId: row.job_id,
    sequence: row.sequence,
    kind: row.kind,
    content: row.content,
    createdAt: row.created_at,
  };
}

/** LIKEの`%`/`_`/エスケープ文字そのものを、利用者入力から来ても文字通りに扱う。 */
function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** trigramトークナイザへは、フレーズ検索として渡し利用者入力を構文として解釈させない。 */
function toFtsPhraseQuery(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

export function createTranscriptStore(
  database: Database,
  now: () => number = Date.now,
): TranscriptStore {
  const insert = database.query(
    `INSERT INTO transcript_entry
       (job_id, repository_owner, repository_name, sequence, kind, content, created_at)
     SELECT ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?
     FROM transcript_entry WHERE job_id = ?`,
  );
  const selectLike = database.query<
    TranscriptRow,
    [string, string, string | null, string, number]
  >(
    `SELECT job_id, sequence, kind, content, created_at FROM transcript_entry
     WHERE repository_owner = ? AND repository_name = ?
       AND COALESCE(?, job_id) = job_id
       AND content LIKE ? ESCAPE '\\'
     ORDER BY created_at DESC LIMIT ?`,
  );
  const selectFts = database.query<
    TranscriptRow,
    [string, string, string, string | null, number]
  >(
    `SELECT e.job_id, e.sequence, e.kind, e.content, e.created_at
     FROM transcript_entry_fts
     JOIN transcript_entry e ON e.id = transcript_entry_fts.rowid
     WHERE transcript_entry_fts MATCH ?
       AND e.repository_owner = ? AND e.repository_name = ?
       AND COALESCE(?, e.job_id) = e.job_id
     ORDER BY rank LIMIT ?`,
  );

  return {
    append(input) {
      insert.run(
        input.jobId,
        input.repository.owner,
        input.repository.name,
        input.kind,
        input.content,
        now(),
        input.jobId,
      );
    },
    search(input) {
      if (input.scope === "job" && !input.jobId) {
        return [];
      }

      const jobFilter = input.scope === "job" ? (input.jobId ?? null) : null;

      if (input.query.length >= ftsMinimumQueryLength) {
        return selectFts
          .all(
            toFtsPhraseQuery(input.query),
            input.repository.owner,
            input.repository.name,
            jobFilter,
            input.limit,
          )
          .map(toEntry);
      }

      return selectLike
        .all(
          input.repository.owner,
          input.repository.name,
          jobFilter,
          `%${escapeLikePattern(input.query)}%`,
          input.limit,
        )
        .map(toEntry);
    },
  };
}
