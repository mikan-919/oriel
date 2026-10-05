# ADR 0005: 接続の生存確認と外部書き込みの再調停

- 状態: Accepted
- 日付: 2026-08-13

## 背景

[ADR 0004](./0004-connection-ownership-and-branch-resumption.md)は、Job所有権とブランチ排他を公開リレーへの専用WebSocket接続として表し、外部操作の直前に現在の取得IDを確認すると決めた。しかし、接続の認証、half-open接続の失効、再接続、およびGitHub・Linear・遠隔Gitへの書き込みが結果不明になった場合の収束手順は未決定だった。

Cloudflareは、端末喪失やnetwork partitionを一定時間内にWebSocket切断として検知する保証を公開していない。GitHubとLinearにも、すべての書き込みへ共通して使えるserver-side idempotency keyはない。一方、結果不明の重複選別を人間へ戻すと、人間の通常の判断をLinearの実行承認とPull Requestのmerge承認へ絞るという製品目的に反する。

Cloudflareの生存確認能力は[接続所有権WebSocketの生存性](../research/connection-liveness.md)、GitHub・Linearの操作別能力は[外部書き込みの冪等性と結果不明時の再調停](../research/external-write-idempotency.md)を根拠とする。

## 決定

### 接続認証

`serve`はrepository単位のdevice bearer tokenをWebSocket upgradeの`Authorization` headerへ直接載せる。tokenをURL、WebSocket subprotocol、query、cookieへ載せず、一回限りの接続ticketも追加しない。

relayはtokenのhashから有効なdeviceとrepository scopeを解決し、要求されたJobまたはcanonicalブランチがそのscope内にある場合だけ接続を受理する。接続ごとに新しい不透明な取得IDを発行し、clientが指定したowner IDを信頼しない。tokenは`serve`の`Bun.secrets`に保存し、harnessへ渡さない。

deviceを失効した場合、relayは新しい接続を拒否するだけでなく、そのdeviceの現在のJob所有権接続とブランチ排他接続を失効させて閉じる。該当`serve`はworkerと新しい外部操作を停止し、Jobを`interrupted`へ移す。

### 有効な接続と生存確認

所有権は、単に物理的に列挙できるWebSocketではなく、有効な接続付随情報を持つWebSocketとして表す。接続付随情報は少なくともrepository、device、所有権種別、所有権key、Job識別子、必要な親取得ID、自身の取得ID、有効・失効状態を持ち、Hibernation APIで休止を越えて復元する。所有権record、期限付きlease、epoch、履歴をDurable Objectsストレージへ保存しない。

`serve`はapplication-level heartbeatを送り、Durable Objectは`setWebSocketAutoResponse()`で休止を解除せず応答する。

- `serve`がheartbeat応答を期限内に受け取れない場合、relayの切断通知を待たずworkerと新しい外部操作を停止する。
- Durable ObjectはAlarm処理と新しい取得要求の処理で、`getWebSocketAutoResponseTimestamp()`から最終heartbeatを監査する。
- 期限を過ぎた接続は、接続付随情報を失効状態として再保存してからcloseする。新しい取得処理は失効済み接続を所有権として数えない。
- 失効後に旧接続からheartbeat、確認、解放が遅れて届いても、失効状態または取得ID不一致として拒否する。
- heartbeat間隔、client側停止期限、server側失効期限は根拠のない値を設計文書へ固定しない。固定版runtimeを使った測定と実サービスでの動作確認から決め、server側失効期限をclient側停止期限より長くする。

Cloudflareはmessage delivery、Alarm、切断通知の最大遅延を保証していないため、この方式は「端末喪失から一定時間内に必ず引き継げる」というplatform保証にはしない。安全性は、旧`serve`がheartbeat応答を失った時点で停止し、外部操作の直前確認を同じ所有権接続上でしか行えないことにより守る。

### 再接続

切断後に旧workerをそのまま続行しない。relayが旧接続の消失または失効を確認した後、同じ`serve`または別の`serve`が新しい取得IDでJob所有権と必要なブランチ排他を取り直す。GitHub、Linear、Git、承認指紋、有効なブランチとPull Requestの組を最初から再調停し、条件が揃った場合だけreplacement workerを起動する。

再接続は通常の回復動作として自動実行してよい。現在状態を一意に再構成できない場合はworkerを起動せず、人間が判断できる情報をWeb UIへ表示する。

### 外部操作interface

harnessへGitHub・Linearの汎用API中継や任意command実行を公開しない。`serve`は、Issueへの返答、HOWの更新、Linear状態の反映、checkpointの送信、Pull Requestの作成・更新など、Workflow phaseと対象が固定された狭い操作だけを提供する。

外部操作要求を受けた`serve`は、送信前に論理操作をSQLiteへ永続化して操作IDを返す。harnessとの要求を外部サービスの応答まで開いたままにしない。`serve`は送信、現在値の再読、重複圧縮を継続し、完了、拒否、意味的競合を後続eventとして通知する。harnessは依存する操作が完了するまで次へ進まない。

操作記録は、操作ID、Job識別子、操作種別、対象、Job取得ID、必要なブランチ取得ID、承認指紋、providerごとの自然key、更新前値または作成前resource ID集合、期待値またはdigest、判明したprovider resource IDを持てる。WHAT、HOW、会話本文を別の正本として保存するためには使わない。

結果不明後も同じ`serve`が安全に収束できる間は所有権を保持する。接続喪失または意味的競合で継続不能になればworkerを停止して所有権を解放し、後継`serve`が新しい取得IDで現在状態から再調停する。結果を証明できないまま無期限に所有権を保持せず、結果不明になっただけで即時解放もしない。

### 共通の収束規則

結果不明の操作をpayloadだけで盲目的に再送しない。ただし、操作固有の現在値、比較条件、安定ID、または重複圧縮によって同じ意図へ収束できる場合、`serve`は再読、再送、余分な成果の削除またはcloseまで自動実行する。人間へ戻すのは、現在値から意味的な意図を一意に決められない場合だけとする。

Agentが生成するGitHub・Linearの会話コメントには、論理操作IDをHTML commentとして埋め込む。WHAT、HOW、Pull Request本文、または人間のコメントには埋め込まない。この識別子は外部状態だけから同じ論理コメントを見つけ、重複を一件へ圧縮するための配送識別子であり、Workflowの正本や所有権記録ではない。

操作別の収束規則は次とする。

- **GitHub・Linearの会話コメント**: 操作ID、actor、対象、本文digestで候補を列挙する。Linearではclient指定UUIDも使う。複数候補は事前に固定した順序で一件を残し、余分なコメントを削除する。
- **GitHub Issue本文とLinear HOW**: currentが期待値なら完了、更新前値なら再送、それ以外なら最新本文から同じ対話Jobを再開してAgentに変更案を再導出させる。汎用的な文字列mergeで人間の変更を上書きしない。
- **Linear状態**: worker起動直後にTodoからIn Progressへ移す。レビュー可能なPull Requestを作成した時、teamに一意なレビュー用状態があれば移し、なければIn Progressを維持する。mergeを現在値から確認した後にDoneへ移す。いずれもdesired-stateとして再読・再送する。
- **Git送信**: trusted `serve`がsystem Gitを`Bun.spawn`の引数配列で実行し、`git push --force-with-lease=<ref>:<expected-old-oid>`でcanonicalブランチへ送る。credentialは一回限りのcredential helperで渡し、引数、remote URL、環境変数、worktree、harnessへ置かない。remote OIDが期待値なら完了、送信前OIDなら同じ比較条件で再送、第三のOIDなら再調停する。
- **Pull Request作成**: repository、head、base、期待head OIDを自然keyとし、作成前の候補集合を保存する。重複が生じた場合は一致候補の最小PR番号をcanonicalとして残し、余分なPull Requestをcanonicalへのリンクと理由を示す冪等なコメント付きでcloseする。

### checkpoint

checkpointは時間間隔ではなく、別workerが再開できる意味的な区切りで作る。検証済みのvertical slice、計画停止前、所有権解放前にcommitとHANDOFFをcanonicalブランチへ送る。

計画停止時に検証済みcheckpointを作れない場合も、未完了箇所と失敗中の検証をHANDOFFへ明記したWIP checkpointを送る。引き継ぎ先は未検証の作業途中成果として全検証をやり直す。実装完了後はHANDOFFを最終差分から削除し、レビュー可能なPull Requestだけを作る。

意味的な区切りの選択はAgent指示で調整してよいが、所有権確認、canonicalブランチ以外への送信拒否、未検証表示、HANDOFF削除前のPull Request作成拒否は`serve`が強制する。

## 帰結

- relayは所有権recordを永続化せず、Hibernationを維持したままhalf-open接続を失効できる。
- 外部書き込みの重複管理は通常の人間作業ではなく、`serve`の正常系になる。
- ローカル操作記録を失っても、外部の操作ID、自然key、Git ref、Pull Request、Workflow phaseから可能な範囲を再構成できる。
- credentialをharnessへ渡さず、用途別の狭い操作と現在所有権の確認で外部書き込みを制限できる。
- 自動収束で内容の意味を決められない競合だけが、人間または新しいAgent判断を必要とする。

## 対象外

- heartbeatの具体的な時間値
- 各messageの最終的なwire field名とencoding
- Linear team固有の状態名をreview phaseへ対応付ける詳細規則
- retry回数、資源上限、外部サービス障害時の運用値

## 実装前の確認

Oriel自身の通常の自動試験では、同時取得、休止復元、heartbeat不成立、失効後の旧確認、再接続、操作event、結果不明、遅延書き込み、重複圧縮、本文競合、Git OID競合、未検証checkpointを再現する。

Cloudflareの実際の休止とAlarm、GitHub App権限、`force-with-lease`、Pull Requestの重複close、Linearのclient指定comment IDと状態更新は、本番とは分離した検証専用環境で初回実装、固定依存版の更新、release前に明示的に確認する。
