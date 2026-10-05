# ADR 0008: transcriptの保存と検索

- 状態: Accepted
- 日付: 2026-08-17

## 背景

CONCEPT.mdの「ローカル履歴」は、transcriptを各`serve`がローカルに保存し、自動削除しないこと、Agentが自分の`serve`と同じrepositoryを担当する接続中の他の`serve`へ履歴検索を依頼できること、検索範囲はlocal・current Job・repositoryとし、relayは問い合わせを中継するだけで内容を保存しないことを定める。ROADMAPは「設計を固める順序」の5番目でこれを「実装項目へ分解する」としていたが、詳細はどのADRにも書かれていなかった。

GitHub Issue #41（transcriptをローカル・Job・repository単位で検索する）の実装にあたり、この空白を埋める。実装時点でWeb UI（issue #40）はまだ存在しないため、この変更の範囲は保存・検索・relay中継までとし、人間向けの呼び出し口はissue #40に委ねる。

## 決定

### 記録する対象

transcriptとして記録するのは、すべてのJob種別が通るAgent実行系（`model-stream.ts`が仲介するmodelへの要求・応答と、各workerが明示するJob開始・結果）に限る。GitHub Issue／Linear issueへのcomment・description操作は、対象そのものがGitHub・Linear上に既に記録を持つため、この変更ではtranscriptへ複製しない。

`model-stream.ts`はJob種別によらず唯一の実行経路であるため、記録もここ一箇所で行う。個別のJob workerごとに記録経路を複製しない。

### 保存

- repositoryを担当する`serve`のSQLite（`local-state.ts`が開く同一DB）へ`transcript_entry`テーブルとして保存する。列はJob ID、repository、Jobごとの連番、種別(`kind`)、内容(`content`、JSON文字列)、記録時刻。
- Jobごとの連番は、同じJob IDに対する既存行の最大値+1をINSERT文自身が計算する(`INSERT ... SELECT ... FROM transcript_entry WHERE job_id = ?`)。書き込みは`serve`という単一processの同期呼び出しからしか起きないため、追加のlockや採番テーブルを持たない。
- 検索にはSQLiteのFTS5 `trigram`トークナイザによる外部contentテーブル(`transcript_entry_fts`、`content_rowid`で`transcript_entry.id`と対応)を使い、INSERT/DELETEトリガーで同期する。3文字未満のqueryはtrigramトークナイザの最小長を満たせないため、`LIKE`(`%`/`_`/`\`をエスケープした部分一致)へ落とす。

### 検索範囲

- `job`: 指定したJob IDの行だけを、要求元`serve`のローカルSQLiteから返す。
- `local`: 要求元`serve`が保存しているそのrepositoryの全行から返す。
- `repository`: `local`の結果に加え、関連する接続中の他の`serve`の`local`検索結果を合流させる。

`job`と`local`はrelayを経由しない。`repository`だけがrelay中継を要求する。

### relay中継

repository scopeの検索は、既存のwebhook起床通知チャンネル(`/notifications`のWebSocket、ADR 0001)をそのまま再利用する。専用のWebSocketエンドポイントを追加しない。

- 要求元`serve`が`transcript.search.request`(`scope: "repository"`)をこの接続へ送る。
- `DeviceRegistryObject`は要求元以外の接続中通知socket全てへ、`scope`を`"local"`に落とした同じ要求を転送する。
- 転送先の各`serve`はローカルSQLiteだけで検索し、`transcript.search.result`で答える。
- `DeviceRegistryObject`は転送先の数だけ答えを集約し(先着順に配列へ追記するだけで、順序やrankの保証はしない)、全員から届くか、接続時に指定されたtimeoutへ達したら要求元へ一括で返す。
- 接続中の他の`serve`が無ければ、relayは中継せず`entries: []`を即答する。

queryも結果も`DeviceRegistryObject`の永続化領域(Durable Object SQLite storage)には一切書かず、集約中の状態は要求ごとのin-memory Mapだけに置く。要求元の接続が切れる、または集約中に接続が切れても、他の要求元・他のrepositoryの集約とは独立して扱う。

timeout値は`ownershipHeartbeatIntervalMs`などの既存の運用値と同じく、`serve`の接続時に`x-transcript-search-timeout-ms`headerで渡し、Durable Object固有の既定値を持たない。deploy設定は`RelayEnv.TRANSCRIPT_SEARCH_TIMEOUT_MS`から`RelayOptions.transcriptSearchTimeoutMs`として渡す。

## 帰結

- 新しいWebSocketエンドポイントもDurable Object間RPCも増やさず、既存の起床通知チャンネルの双方向性だけで検索を実装できる。
- Agent実行系だけを記録するため、既存の4種のJob worker(`implementation`・`how_confirmation`・`what_confirmation`・`pr_response`)それぞれに1行程度の呼び出しを追加するだけで済み、GitHub Issue/Linear commentの二重記録を避けられる。
- 検索結果の順序保証やrankの一貫性、部分応答の除外(タイムアウトしたsiblingの分だけ結果が薄くなること)はこのADRの対象外とし、issue #40のWeb UI側が必要とする表現力次第で見直す。

## 対象外

- 人間向けの検索呼び出し口(CLI・Web UI)。issue #40で扱う。
- GitHub Issue／Linear issueへのcomment・description操作のtranscriptへの複製。
- transcriptの削除操作(利用者の明示操作でのみ行うことはCONCEPT.mdの決定のままだが、削除APIそのものの実装は呼び出し口が無いこの変更には含めない)。
- 検索結果のrankや関連度順の保証。
