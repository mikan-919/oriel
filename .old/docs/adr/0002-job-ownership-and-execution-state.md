# ADR 0002: Jobの所有権と実行状態

- 状態: Accepted — Job leaseとbranch lockの保存・取得・引き継ぎは[ADR 0004](./0004-connection-ownership-and-branch-resumption.md)の接続所有権が置き換える。
- 日付: 2026-08-12

## 背景

複数の`serve`が同じWorkflowを観測でき、workerまたは`serve`は途中で失われる。外部のWHAT、HOW、承認、Pull Requestの現在状態をローカルの実行状態で複製せず、一つのJobを誰が実行してよいかと、停止・引き継ぎを決める必要がある。

## 用語

- **Workflow**: GitHub Issueで識別される長期の仕事。GitHub Issue、対応するLinear issue、activeなcanonical branchとPull Request、Jobを結び付ける。
- **Job**: Workflow内の一回の実行。identityは実行中に不変で、workerを失っても同じJobを別workerが再開できる。
- **worker**: Jobを実行する一回のharness process attempt。workerはJobのidentityでも所有者でもない。workerが失われた後も、supervising `serve`が再調停とlease取得をしてから、replacement workerで同じJobを再開できる。
- **canonical branch**: Workflowのコード変更に使う唯一のactive branch。activeなcanonical branchとPull RequestはWorkflowごとに高々一つである。

この用語はADR 0001の「TaskとJobは同義」という記述を置き換える。`Task`はこのADR以後、WorkflowまたはJobの別名として使わない。

## Job identityと重複排除

Job識別子は、リポジトリ識別子、Workflow識別子、Job種別、安定した外部入力キー、および承認に基づき実行するJobでは[ADR 0003](./0003-approval-admission-and-reconciliation.md)の**承認指紋**を決定的に組み合わせる。この構造は接続所有権のキーにも使う。承認指紋はTodo後に二度一致した現在のWHAT/HOWを封印する版識別子であり、WHAT/HOWの正本ではない。実装JobではWorkflow識別子と承認指紋の組を安定した入力キーとして扱う。同じ内容へのfresh Triage→Todoは同じ論理Jobへ対応し、新しい実行試行は新しい取得IDで区別する。履歴IDと時刻は識別子や要求へ入れない。重複、順不同、または別`serve`で受信した同じ外部通知は、同じJob識別子と接続所有権へ対応付けなければならない。

nonterminalなJobへ明示的にcorrelateされたfollow-upは、そのJobを再開する。新しいapproval fingerprintは新しいJobを作る。approval fingerprintのencoding、現在値の二重確認、branch sealはADR 0003がこの範囲を置き換える。それ以外の構成要素のwire表現とproviderごとのtrigger/input keyの対応付けは、event/reconciliation ADRで決める。

## 外部phaseとlocal実行状態

GitHub Issue、Linear issue、Pull Requestの現在状態は外部から導出するWorkflowのphaseであり、local Job stateに保存して正本を複製しない。webhookはphase変更の通知にすぎず、重複・順不同・欠落を許容する。

localに保存するJob execution stateは次だけとする。これはlocal runtimeの処理位置を表すための最小状態であり、Workflow phaseのcacheではない。

| State | 意味 | 許可される次のstate |
| --- | --- | --- |
| `pending` | 実行候補として作られたが、leaseを得ていない。 | `claiming`, `cancelled` |
| `claiming` | 現在の外部phaseを再確認し、Job leaseと必要なbranch lockの取得結果を確定している。 | `running`, `pending`, `interrupted` |
| `running` | 監督する`serve`が現在のJob所有権接続と、コード変更Jobでは現在のブランチ排他接続を持ち、workerが許可された作業を実行できる。 | `stopping`, `interrupted` |
| `stopping` | 制御された完了または取消のためにworkerを止め、所有権を返却している。新しい外部操作は開始しない。 | `completed`, `cancelled`, `interrupted` |
| `interrupted` | workerの異常終了、所有権接続または必要な排他接続の喪失、接続確認不能、引き継ぎ、または外部操作の結果不明で、再調停が必要である。 | `claiming`, `completed`, `cancelled` |
| `completed` | Jobの目的を完了し、worker、lease、必要なbranch lockを持たない終端状態。 | — |
| `cancelled` | Jobを継続しないと決め、worker、lease、必要なbranch lockを持たない終端状態。 | — |

イベントと遷移は次に限る。ここでいう「結果不明」は、外部writeを送ったか、または送ったwriteが反映されたかを確定できない状態をいう。

| From | Event / guard | To | 必要な結果 |
| --- | --- | --- | --- |
| `pending` | `claim_started` | `claiming` | 現在の外部phase、対象、approval fingerprintを読んでからlease取得を試みる。 |
| `pending` | `cancellation_requested` | `cancelled` | workerもleaseも開始しない。 |
| `claiming` | `claim_confirmed` | `running` | 対話Jobは現在のJob取得ID、コード変更JobはJob取得IDとブランチ取得ID、および有効なブランチ/プルリクエストの組を読み返して確認し、その後にworkerを開始する。 |
| `claiming` | `lease_unavailable` | `pending` | 未失効の他ownerを確認し、workerを開始しない。 |
| `claiming` | `claim_result_unknown` | `interrupted` | 取得結果を再調停するまで外部操作をしない。 |
| `claiming` | `required_lock_unavailable` | `pending` | code-changing JobはJob leaseを確認してreleaseしてから、workerを開始せずに戻る。 |
| `claiming` | `lock_or_release_result_unknown` | `interrupted` | lockの取得またはこの段階のlease releaseの結果を再調停するまで、workerを開始しない。 |
| `running` | `stop_requested`、current state・attachment・approval fingerprintの不一致 | `stopping` | 新しい外部操作を止め、workerを終了して所有権を返却または失効待ちにする。観測した承認対象の不一致ではADR 0003に従ってTriageへ戻す。 |
| `running` | `worker_lost`、leaseまたは必要なlockの喪失、takeover観測、または外部操作の結果不明 | `interrupted` | そのworkerの外部操作を止め、再調停を要求する。 |
| `stopping` | `completion_reconciled` | `completed` | branch lock、Job leaseの順で返却済み、または保持していないことを確認する。 |
| `stopping` | `cancellation_reconciled` | `cancelled` | branch lock、Job leaseの順で返却済み、または保持していないことを確認する。 |
| `stopping` | `lock_or_lease_release_result_unknown` | `interrupted` | workerを止めたまま、release結果を再調停する。 |
| `interrupted` | `reconciliation_allows_resume` | `claiming` | 同じJobについて現在の外部状態を再構成し、leaseを取り直す。 |
| `interrupted` | `completion_reconciled` | `completed` | 現在の外部状態がJobの成功を証明し、current Job leaseと必要なbranch lockを保持していないことを確認する。 |
| `interrupted` | `cancellation_reconciled` | `cancelled` | workerを持たず、既知の所有権を返却または失効待ちにする。 |

`interrupted`の引き継ぎ先workerは新しいJobを作らない。`serve`が外部の現在状態を再調停してから同じJobの接続所有権を取得し、そのworkerを開始する。ローカルDBを失った場合も、外部から安定したJob識別子を再構成できる場合に限り、GitHub、Linear、Gitの現在状態とリレーの生きた接続から同じ判断を再構成する。

## Job lease

すべてのJobは、実行中にJob leaseを一つだけ持つ。leaseは永続記録ではなく、[ADR 0004](./0004-connection-ownership-and-branch-resumption.md)のJob所有権WebSocketとして表す。接続中のJob識別子、`serve`所有者識別子、取得IDが現在のleaseであり、接続が失われた時点でleaseも失われる。Gitにlease用のGit参照を作らず、Durable Objectsストレージへlease記録や履歴を保存しない。

取得・更新・引き継ぎは次の順序にする。

1. `serve`はGitHub、Linear、Gitから現在のWorkflow phase、対象、approval fingerprintを再構成する。実行不能ならleaseを取得しない。approval fingerprintを伴うcanonical branchの初回作成または既存branch adoptionは、さらに厳密な順序を[ADR 0003](./0003-approval-admission-and-reconciliation.md)に従う。
2. `pending`または`interrupted`のJobは、同じJob識別子の所有権接続が存在しない場合だけ専用WebSocketを取得する。リレーが割り当てた取得IDを接続越しに読み返すまで`claiming`のままとする。コード変更Jobは同じ`claiming`中にブランチ排他接続を取得し、有効なcanonicalブランチ/プルリクエストの組を再確認する。両方を確認するまでworkerを開始しない。
3. 所有者は外部操作の直前に現在の取得IDを接続越しに確認する。確認不能、接続断、別の取得IDの観測は直ちに`interrupted`とし、workerを止める。
4. 引き継ぎは、リレーが旧所有権接続の消失を確認した後だけ、別`serve`が新しい接続と取得IDを得る操作である。接続の状態が不明な間は引き継がない。
5. 完了または取消時は新しい外部操作を止め、ブランチ排他接続、Job所有権接続の順に閉じる。解放結果を確認できなければworkerを終了し、リレーが接続消失を確認するまで後続workerを開始しない。

対話JobはJob leaseだけを必要とする。実装JobとPR対応Jobは、Job leaseに加えてbranch lockを必要とする。

## Branch lock

branch lockはリポジトリとcanonicalブランチをキーにする接続排他である。Workflow全体やIssue/Linear対話Jobを排他しない。コードを変更する実装JobとPR対応Jobだけが、`claiming`中に現在のJob所有権接続を確認してからcanonicalブランチの専用WebSocketを取得し、取得後にWorkflowの有効なcanonicalブランチ/プルリクエストの組がなお一致することを確認する。承認指紋を伴うJobでは、ADR 0003の初回比較条件付き作成または[ADR 0004](./0004-connection-ownership-and-branch-resumption.md)の既存ブランチ引き継ぎ、封印後の再読までworkerを開始しない。

ブランチ排他接続にはcanonicalブランチ、Job識別子、Job取得ID、ブランチ取得IDを付随させる。コードを変更するJobがJob所有権接続またはブランチ排他接続を失った場合は`interrupted`へ移り、workerを止め、Gitへの送信、ブランチ操作、プルリクエスト作成・更新を開始しない。解放順序はブランチ排他接続、Job所有権接続とする。

branch lockの引き継ぎまたは置換は、現在のJob所有権接続を持つ`serve`だけが行える。リレーが同じブランチキーの旧排他接続が存在しないことを確認した場合だけ新しい接続を受理する。取得後はcanonicalブランチ、Job識別子、Job取得ID、ブランチ取得IDを接続越しに読み返して確認する。取得または読み返しの結果が不明なら`interrupted`へ移り、workerを開始しない。

所有権の取得順序はJob所有権接続、ブランチ排他接続、有効なcanonicalブランチ/プルリクエストの組の再確認とする。この組は取得後の妥当性確認であり、返却する所有権ではない。完了または取消時に返却する順序はブランチ排他接続、Job所有権接続とする。

## 外部操作のfencingとreconciliation

`serve`だけが外部操作を実行する。外部操作要求はJob識別子、操作種別、対象、Job取得ID、必要ならブランチ取得ID、承認指紋、冪等性キーを含む。承認履歴IDや時刻を要求のfieldへ含めない。冪等性キーは`serve`が送信前にローカルSQLiteの操作記録へ割り当て、同じ論理操作の再送で変えない。各操作の直前に、`serve`は次を全て確認する。

1. Jobが`running`で、要求の所有者識別子とJob取得IDが現在のJob所有権接続に一致し、リレーから確認応答を受ける。
2. 現在のWorkflow phaseから導出したJob identity、Job種別、許可された操作、対象GitHub IssueとLinear issueがrequestと一致する。
3. ADR 0003のreconciliationが現在のstate、attachment、対象Issue IDsを再確認し、現在導出するapproval fingerprintもrequestと一致する。
4. idempotency keyがこのJobと論理操作に対応し、completeまたは結果不明として記録済みでない。
5. ブランチまたはプルリクエストを変更する操作では、要求のブランチ取得ID、canonicalブランチ、有効なプルリクエストの組が現在の接続排他とWorkflowに一致し、リレーから確認応答を受ける。

Job取得IDとブランチ取得IDは、リレーが現在接続と一致しない古いworkerの確認要求を拒否するための隔離値である。しかしGitHub、Linear、遠隔Gitの外部APIは、この確認を原子的な書き込み前提条件として強制しない。事前確認後に接続を失う、または既に送信した書き込みが引き継ぎ後に成功する競合を取得IDだけで防ぐことはできない。

そのため、`serve`はpreflight直後に操作を送信し、operationごとに条件付き更新、providerが受け取るidempotency key、または観測可能な結果によるreconciliationを用いる。timeout、crash、所有権喪失により結果が不明なwriteは盲目的に再試行しない。[ADR 0005](./0005-connection-liveness-and-external-write-reconciliation.md)の操作固有の収束手順がある場合は、現在値の再読、比較条件付きの再送、重複圧縮を`serve`が自動実行する。Todo→Triage差し戻しはADR 0003、その他のexternal operationはADR 0005を正本とする。

## crashと重複通知の不変条件

- Webhook、定期確認、再試行はJob開始の許可ではない。同じ通知を何度受けても、同一Jobの現在の所有権接続を持つ`serve`に監督されていないworkerは実行も外部書き込みもできない。
- `serve`またはworkerの異常終了は所有権の明示解放を必要としない。別`serve`はリレーが旧接続の消失を確認し、現在の外部状態を再調停してから引き継げる。
- 外部phase、attachment、承認指紋、ブランチ/プルリクエストの組の不一致を観測した場合、旧workerは停止し、旧Jobを継続して書き込まない。承認対象の不一致では`serve`がTriageへ戻す。人間によるfresh Triage→Todoで承認指紋が変わった場合は新Jobと新canonicalブランチを作り、同じ場合は新しい取得IDで同じ論理Jobを再開する。
- 有効なcanonicalブランチとプルリクエストはWorkflowごとに高々一つであり、同じブランチを変更する二つのコード変更Jobは同時に現在のブランチ排他接続を持てない。

## 保留事項

- Job識別子のうち承認指紋以外の構成要素の符号化と、提供元ごとの他の安定した入力キーの対応付け
- concurrency、retry、heartbeat、timeout、resource limitの運用値
