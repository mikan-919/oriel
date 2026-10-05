# ADR 0006: webhook署名検証と起床通知

- 状態: Accepted
- 日付: 2026-08-16

## 背景

[ADR 0001](./0001-distributed-workflow-and-worker-model.md)は「webhookは起床通知であり正本ではない」ことと、relayが「GitHub AppとLinearのwebhook…の中継を担当する」ことを決めたが、署名検証の方式、relay→`serve`への通知の運び方、Linear webhookをどのrepositoryへ配送するかのrouting方式は対象外としていた。[ADR 0003](./0003-approval-admission-and-reconciliation.md)も「device登録、OAuth、webhook署名、relay認可」を明示的に対象外としている。

GitHub Issue #31（Webhook通知と現在状態からJobを発見する）の実装にあたり、この三点を決める必要がある。承認そのもの（Linear Triage→Todo、現在値の二度読み一致確認）はADR 0003が定めた`readImplementationApproval`/`startImplementationJob`が既に完成させており、本ADRはそれより手前の「どの`linearIssueId`を調べるべきかを見つける」ための通知配送だけを扱う。

## 決定

### webhook署名検証

GitHub App webhookは`X-Hub-Signature-256`ヘッダ（`sha256=<hex>`形式）、LinearのwebhookはHTTP `Linear-Signature`ヘッダ（`<hex>`形式）を持つ。どちらもraw bodyへのHMAC-SHA256であり、relayは`crypto.subtle.verify`（Web Crypto、constant-time比較）で検証する。ROADMAPの「webhook署名検証はraw bodyとWeb Cryptoで実装する」方針に従う。

署名検証を通らない要求は401で拒否し、payloadを一切解釈しない。Linearは追加でbody中の`webhookTimestamp`フィールドを持ち、これが現在時刻から`LINEAR_WEBHOOK_MAX_SKEW_MS`を超えて離れている場合もreplay対策として401で拒否する（Linear公式ドキュメントの推奨方式）。

署名検証を通った後も、relayはpayloadから通知配送に必要な最小限のfield（GitHubは`installation.id`/`repository.id`、Linearは`type`/`data.teamId`）だけを読み、それ以外（title、body、状態名など）は読んだ直後に破棄する。ADR 0001のとおりwebhookのpayload内容を正本として保存・転送しない。

### wake通知プロトコル

relay→`serve`の通知は`{ type: "notification.wake", source: "github" | "linear" }`だけを送る、payload内容を一切含まない最小限の合図とする。`serve`はこれを現在値の再読のきっかけとして扱うだけで、Job開始条件そのものにはしない（Job開始条件は引き続き`startImplementationJob`が行う現在値の二度読み一致確認だけである）。

この通知チャンネル（`GET /notifications`）は、[ADR 0004](./0004-connection-ownership-and-branch-resumption.md)/[ADR 0005](./0005-connection-liveness-and-external-write-reconciliation.md)が定めるJob所有権・ブランチ排他のWebSocket接続とは別のWebSocketとする。lease、取得ID、application-level heartbeatのいずれも持たない。欠落・遅延しても`serve`側の定期ポーリングが必ず後追いするため、生存確認の仕組みを追加する必要性がない。切断時は固定の短い遅延で再接続するだけでよい。

device bearer tokenの認証方式はADR 0005の接続認証（`Authorization`ヘッダへの直接付与）をそのまま踏襲する。

### Linear webhookのrouting

relayが受けるLinear webhookのURLは単一の固定URL（`POST /webhooks/linear`）とする。個々のrepositoryごとに異なるwebhook URLを人間が手動登録する方式は採らない。理由は次の二点による。

- ADR 0001は、relayが永続化してよいものとして「routingに使うLinear workspace IDとteam ID」を明示的に許可している（同ADR「relay」節）。単一webhook＋team routingテーブルはこの設計をそのまま実装したものである。
- repositoryごとに個別のwebhook URL・secretを発行する方式は、Linearの仕様上secretがwebhookごとに異なるため、relayが実質的にLinear固有のcredentialをrepository単位で保持することになり、ADR 0001「relayはLinear tokenを保持しない」の精神に反する。

`serve`は`POST /device/linear-routing`でLinear team IDをrelayへ登録する。relayはこれを、device tokenから解決した`(installationId, repositoryId)`と組にして、repositoryに紐付かない共有`discovery`インスタンス（既存の`installationId === 0`用インスタンス、`installation_choices`と同じ前例）の`linear_team_routes`テーブルへ保存する。Linear webhook受信時は`data.teamId`でこのテーブルを引き、該当する全ての`(installationId, repositoryId)`へwakeを配送する。

Linear team IDの供給元は、本来は各`serve`が個別に完了するLinear OAuthフロー（ADR 0001「各`serve`はLinear OAuthを個別に完了し」）の完了時点で自然に得られるべき値である。しかしLinear OAuth完了フロー自体はv1のこの時点でまだ実装されていない（既存の`startImplementationJob`もLinear tokenが`Bun.secrets`に事前投入されている前提で動いており、これは本ADRのスコープ外の既存ギャップである）。そのため、当面は運用者が指定する`ORIEL_LINEAR_TEAM_ID`環境変数から取得し、`serve`起動時に一度`registerLinearRouting`で登録する暫定策を採る。Linear OAuth完了フローが実装された時点で、この環境変数はOAuth完了時の自動登録に差し替える。

GitHub App webhookは、App作成時に設定する単一の固定URL（`POST /webhooks/github`）でよい。payload中の`installation.id`/`repository.id`から動的にrouting先のDurable Objectインスタンスを解決できるため、GitHub側にはrouting用の永続テーブルを必要としない。

### `issue_comment`イベントの追加（Issue #33改訂）

当初の決定は`issues`イベントだけを起床通知の対象とし、`issue_comment`イベントを明示的に対象外としていた。GitHub Issue #33（GitHub Issue対話からWHATを確定してLinearへ渡す）のmention／commandトリガーは、人間がGitHub Issueのcommentへ書いた指示を契機に動く必要があり、`issues`イベント（Issue本体の作成・編集・open/close）だけでは検知できない。そのため`issue_comment`イベント（`action: "created"`）も起床通知の対象へ追加する。

この追加は本ADRの原則を変えない。署名検証、readする最小限のfield（`installation.id`/`repository.id`）、`{ type: "notification.wake", source: "github" }`という中身のないwake通知、いずれも`issues`イベントと同じ扱いとする。comment本文やauthorは検証直後に破棄し、relayへ保存も転送もしない。`serve`側は起床後にGitHub側の現在状態（open issueの最新comment一覧）を自分で読み直し、mention／commandパターンの判定もそこで行う。webhookそのものは常に「早く起こすための合図」のままであり、判定の正本にはならない。

## 帰結

- webhookのpayload内容はrelayを一切通過せず、`serve`は常に現在値を読み直してからJobを開始する。webhookそのものがJob開始の根拠にならないというADR 0001の原則が、実装上も保たれる。
- 通知チャンネルに生存確認を持たせないことで、Job所有権・ブランチ排他接続の安全性に関わる複雑さ（heartbeat、失効判定、取得ID）を通知配送へ持ち込まない。正しさは定期ポーリングが担保する。
- Linear webhookのrouting情報はrepository単位のcredentialではなく、経路制御のためのIDだけをrelayに保存する。ADR 0001の保存境界を維持する。
- Linear OAuth完了フローが未実装である間、Linear team IDの供給は運用者の手動設定に依存する。これはLinear webhook経路の可用性を、その完了フローが実装されるまで人手の設定に依存させる一時的なトレードオフである。

## 対象外

- Linear OAuth完了フロー自体の設計（別Issueで扱う）
- heartbeatの具体的な時間値（`DISCOVERY_POLL_INTERVAL_MS`を含む運用値は既定値を持たず、測定と検証専用環境の実動作から決める）
- GitHub App webhookで`issues`・`issue_comment`以外のイベント種別を扱う設計（v1はこの二つだけを起床通知の対象とする）
- staleなLinear team routeの削除方針

## 実装前の検証

ADR 0003/0004/0005の慣例に従い、検証専用のGitHub App test installationとLinear test workspaceに対して、実際の`X-Hub-Signature-256`/`Linear-Signature`配送と`webhookTimestamp`のずれ判定が本ADRの記述通りに動くことを確認してから、本番のGitHub App設定・Linear webhook設定へ登録する。
