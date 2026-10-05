/**
 * Web UIの運用値。いずれも安全条件ではなく、表示の追従の速さとHTTP呼び出し量の
 * 釣り合いなので、実測を待たず既定値を置く（`apps/serve/src/cli.ts`のheartbeat・
 * discovery poll間隔と同じ扱い）。
 */

/**
 * Limit: 3000ms
 * Source: 既定値。requester・target specification・実測のいずれでもない。
 * Required For: 選択中のJobが完了して`/api/jobs`から消えたことの検知と、
 *   sidebarのJob一覧の追従。
 */
export const jobListPollIntervalMs = 3_000;

/**
 * Limit: 1500ms
 * Source: 既定値。requester・target specification・実測のいずれでもない。
 * Required For: 稼働中Jobのtranscriptを会話として読める程度に追従させること。
 */
export const transcriptPollIntervalMs = 1_500;

/**
 * Limit: 250ms
 * Source: 既定値。requester・target specification・実測のいずれでもない。
 * Required For: 入力一文字ごとにFTS5検索とrelay中継を起こさないこと。
 */
export const transcriptSearchDebounceMs = 250;

/**
 * Limit: 50件
 * Source: `apps/serve/src/server.ts`の`GET /api/transcripts`既定値と同値。
 * Required For: sidebarの検索結果一覧。serve側の上限200を超えない。
 */
export const transcriptSearchLimit = 50;

/**
 * Limit: 200件
 * Source: `apps/serve/src/server.ts`の`GET /api/transcripts`が受け付ける上限。
 * Required For: 会話表示。1 requestで取れる最大件数を使い、古い側を切り捨てる。
 */
export const conversationTranscriptLimit = 200;
