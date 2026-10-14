# Cloudflare使用量と削減方針

確認日: 2026-10-13。無料プランを継続する。以下は公式の通常料金で、実際の請求額やアカウント全体の使用量の測定結果ではない。

| 計上対象 | 無料枠 | 有料プランの月間付属枠と超過料金（USD） |
| --- | --- | --- |
| Workersへの受信リクエスト | 100,000/日 | 1,000万/月、超過100万あたり$0.30 |
| Workers CPU時間 | 1呼び出し10msまで | 3,000万ms/月、超過100万msあたり$0.02 |
| Durable Objectsへのリクエスト | 100,000/日 | 100万/月、超過100万あたり$0.15 |
| Durable Objects稼働時間 | 13,000 GB秒/日 | 400,000 GB秒/月、超過100万GB秒あたり$12.50 |
| SQLite読み取り | 500万行/日 | 250億行/月、超過100万行あたり$0.001 |
| SQLite書き込み | 100,000行/日 | 5,000万行/月、超過100万行あたり$1 |
| SQLite保存量 | 合計5GB | 5GB月、超過1GB月あたり$0.20 |

有料プランの基本料金はアカウントあたり月額最低$5。無料枠は超過分を自動課金する前提ではなく、制限に達すると処理が失敗する。日次枠は00:00 UTCに更新される。

出典: [Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)、[Durable Objects料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

## 計上時の注意

- WorkersのWebSocketは接続開始のHTTP Upgradeが1リクエスト。後続メッセージはWorkersのリクエスト数に入らない。
- Durable Objectsでは受信WebSocketメッセージ20件を課金上の1リクエストとして扱う。管理画面の実メッセージ数は20分の1にはならない。送信メッセージとプロトコルのpingは課金対象外。
- 自動応答の`setWebSocketAutoResponse`は追加の稼働時間を生じない。アプリケーションのSQL処理やアラームまで無料になる意味ではない。
- Durable ObjectsはCPU時間ではなく、休止できない間の経過時間を128MB割り当てに換算して計上する。外部API待ちも含む。同じオブジェクトで並行処理している時間は重複加算しない。
- SQLの呼び出し数と読み取った行数は別。結果の行数だけでなく走査が影響する。索引を更新すると書き込み行数が増える。KV形式の`get/put`に移してもSQLiteの読み書きに計上される。`setAlarm`1回は1行書き込み。
- 外部APIへのfetchはWorkersの追加受信リクエストとして課金されない。ただしCPU・Durable Objects稼働時間・前後のSQL読み取りは残る。
- WebからRelayへのService Bindingに追加リクエスト料金はない。静的アセット配信は無料だが、`/api/*`は動的処理。

出典: 上記料金表、[Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)、[SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Durable Objectsの状態遷移](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)。

## Orielの消費箇所

| 現在の経路 | 消費する項目 | 変更の優先度 |
| --- | --- | --- |
| orieldの全件探索 | DO受信メッセージ、外部API待ちの稼働時間、各取得前後の認証SQL | 高。待機中は通知起点にし、通知漏れの照合を残す |
| 実行中の約5秒ごとの承認確認 | 全件探索と同じ処理を反復 | 高。実行中Issueだけ取得し、最新の承認・関連付け・PRの整合性を検証する |
| Webの一覧・端末の定期GET | Workers受信、DO受信、認証SQL、一覧取得の外部API待ち | 高。通知時に更新し、常時の定期取得を減らす |
| Codex出力・進捗通知 | DO受信メッセージ、認証SQL、処理時間 | 出力はSQL保存していない。認証確認と転送単位を計測する |
| AccountRegistryの期限アラーム | DO受信、SQL読み取り、再設定の行書き込み | 休止中にも動く。接続期限・認証失効の保証と合わせて扱う |
| 端末用RelayDeviceの在席確認 | presenceのKV読み書き、約10秒のアラーム | workflowとは別経路。WebSocket化済みでも保存処理が残る |
| 初期化・復帰 | テーブル確認・中断された認証処理の修復SQL | 休止からの復帰でも実行される |

今回の本番停止は`Exceeded allowed rows read in Durable Objects free tier.`で確認した。以前の画面の21,189リクエストとは別の上限であり、その画面だけからSQL消費量は計算できない。

## 評価方法

1. 同じIssue数・HOW・PR・コメントを使い、全件探索と実行中1件の確認を比較する。
2. 外部API呼び出し数とSQL行数を区別する。単体試験のSQL呼び出し数を課金行数として報告しない。
3. 待機・実行・Web表示・端末接続を分ける。60秒ごとの処理は1日1,440回、5秒なら最大17,280回だが、実際の処理時間と稼働時間で減る。
4. 本番ではWorkersリクエスト、DOリクエスト/稼働時間、SQLite rowsRead/rowsWrittenを変更前後の同条件で比較する。通知数・端末数・稼働時間が不明な状態で削減率や月額を断定しない。
5. Webhookは変更を知らせるためだけに使う。署名を検証し、実行許可は最新のGitHub/Linear状態から確認する。受信内容を永続保存するキューや変更履歴は追加しない。

## 今回の実装と測定

- 実行中の確認・処理開始の審査・書き込み前後の確認は、そのIssueを取得する。関連付けの重複や別チームのHOWを見落とさないため、HOW・PR・参照の一覧照合は維持する。
- 署名を検証したGitHub/Linearの変更通知を、接続中の該当アカウントへWebSocketで送る。通知は本文や承認情報を含めない。未読のdaemon通知は接続の付随情報でまとめ、同じ変更の連続受信で毎回探索させない。再接続では全件照合する。
- 両Webhook署名キーが設定されていれば待機中の全件照合は15分ごと。未設定なら60秒を維持する。Webhook配信自体は外部サービスでの設定が必要。通知漏れ・接続中断・休止復帰に備えて照合をゼロにはしない。
- Webは通知を1秒間まとめて更新する。非表示・操作中に受けた通知は保留する。端末一覧の補完取得は5分ごと、画面へ戻ったときにも取得する。
- 実行中の承認確認は約5秒、確認不能時の停止期限は12秒を維持する。

ローカルworkerdで、48件のIssue・1件のHOW・PRなしの同一データを用いて測定した。試験専用のSQLラッパーで実際のカーソルの`rowsRead`を集計し、本番に測定用APIや履歴保存は追加していない。

| 操作 | SQL読み取り行数 | Issueコメント取得回数 |
| --- | ---: | ---: |
| HTTPの全件探索 | 967 | 48 |
| WebSocketの実行中1件確認（所有権確認を含む） | 326 | 1 |

この比較では読み取り行数が約66%減る。15分照合の待機回数は1日96回（60秒照合の1,440回から約93%減）。通知による追加取得、PRのレビュー・CI取得、Web表示、アラーム、認証処理を含む本番全体の削減率ではない。5秒確認を24時間続ければ326行でも約563万行になる計算なので、無料枠内の24時間連続実行を保証する値ではない。

再現: Relayのビルド後、`node --test --test-name-pattern='Leased discovery' test/workflow-provider.test.mjs`を`crates/oriel-relay`で実行する。

## 通知を有効にする設定

1. GitHub AppのWebhookを有効にし、URLを`https://oriel-relay.mikan-919.workers.dev/api/webhooks/github`にする。署名用のsecretをWorkerの`GITHUB_APP_WEBHOOK_SECRET`にも設定する。購読対象はIssues、Issue comment、Pull request、Pull request review、Pull request review comment、Check run、Check suite、Workflow run、Status、Push、Create、Delete、Repository。権限変更が要求された場合はインストール側でも更新を承認する。
2. LinearのOAuthアプリでWebhook URLを`https://oriel-relay.mikan-919.workers.dev/api/webhooks/linear`にし、Issue・Comment・Issue attachmentを購読する。アプリの署名キーをWorkerの`LINEAR_WEBHOOK_SECRET`に設定する。既存のワークスペースにも配信が作成されていることを確認する。別チームからの関連付け変更も検出対象なので、利用するワークスペース全体の通知を対象にする。
3. それぞれの配信履歴でHTTP 200を確認してから両キーの設定を完了する。署名なし・不一致は401、署名キー未設定は503を返す。GitHubのpingは署名検証後に200を返す。Linearは署名対象の時刻が現在から5分以内であることも検証する。
4. Relayを先に公開し、Webを再読み込みし、更新後の`orield workflow`を再起動する。通知は実行許可ではないため、HOWのTodo承認と`.oriel.yaml`の実行許可は引き続き必要。

アプリ設定と署名キーの設定はこのコード変更だけでは完了しない。秘密値をGitやチャットに記録しない。通知は永続キューに入れないため、接続のない間の変更は次の接続時の全件照合で回収する。

既存構成との互換性のため、Relay直下の`/webhooks/github`・`/webhooks/linear`も同じ署名検証で受け付ける。2026-10-14に本番のシークレット名を読み取り、`GITHUB_APP_WEBHOOK_SECRET`と`LINEAR_WEBHOOK_SECRET`が存在することを確認した。秘密値は取得・変更していない。配信先URLや署名キーの一致は名前だけでは証明できない。

設定根拠: [GitHub署名検証](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)、[Linear Webhooks](https://linear.app/developers/webhooks)。
