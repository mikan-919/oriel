# ADR 0001: 分散Workflowとworkerの実行モデル

- 状態: Accepted — 所有権の表現、引き継ぎ、プルリクエスト作成時機は[ADR 0004](./0004-connection-ownership-and-branch-resumption.md)が置き換える。
- 日付: 2026-08-11

## 背景

実行ハーネスはGitHubとLinearを外部の制御面として使いながら、Agentとコードをrepository単位のローカル`serve`で動かす。同じrepositoryへ複数の`serve`が接続でき、対話や実装の途中でどの一台が失われてもよい設計が必要になる。

そのため、GitHub Issueに紐付く長期的なWorkflowと個々のAgent作業を区別し、relayをWorkflow DBにせず外部から状態を復元できること、Agentが制御するコードからcredentialと外部APIを隔離することを決める必要がある。

製品の不変原則とGitHub Issue、Linear issue、GitHub Pull Requestの役割は[CONCEPT.md](../../CONCEPT.md)を正本とする。このADRは、それらを実現するruntime構造を決める。

## 決定

### Workflow、Job、worker

**Workflow**は、一つのGitHub Issue IDに紐付く仕事全体である。GitHub Issue、対応するLinear issue、実装branchとPull Request、および途中で実行されるすべてのJobを結び付ける。

**Task**と**Job**は同義で、Workflow内の一回の仕事を表す。**worker**はharnessによるJobの実行単位である。実行する`serve`が変わってもJobの同一性は維持する。

基本のJobは四種類とする。

1. **Issue対話**: GitHub Issue上でWHATを詰める。
2. **Linear対話**: Triage中のLinear issue上でHOWを詰める。
3. **実装**: 承認されたWHAT/HOWのrevisionを実装し、Pull Requestを作る。
4. **PR対応**: 人間のreviewまたはrequired checkの失敗へ対応する。

Issue対話は、人間がHOWへ進むよう明示した場合だけ、対応Linear issueをTriageで作成する。GitHub Issueをattachmentで結び、WHATを初期contextとして渡す。HOWの検討と本文更新はLinear対話が担当する。TriageからTodoへの遷移は実行承認であり、実装Jobを起動可能にする。実際に束縛するWHAT/HOWは、Todo後に[ADR 0003](./0003-approval-admission-and-reconciliation.md)の現在値確認で二度一致したversionとする。

Issue対話とLinear対話は、Appへの明示的なmention、command、またはWeb UIからの入力で開始する。ハーネスが作ったPull Request上の人間によるreview、inline comment、PR commentは、追加のmentionなしでPR対応Jobを開始する。required checkの失敗もPR対応Jobの入力とする。同じcheckへの修正が連続して失敗した場合は、設定された上限で自動対応を止め、人間へ報告する。

一つのGitHub Issueに対応するLinear issueはattachmentを通じて必ず一意にする。0件ならIssue対話が作成できる。複数なら勝手に選ばず、曖昧さを報告して停止する。

### workerの復活と配置

repository単位の各`serve`は複数のJobを実行できる。各Jobは`serve`が監督する独立したharness processで動く。

既存Jobへ追加入力が届いた場合は、次のように実行する。

- 前回workerのtranscriptを持つ`serve`へ接続できる場合、そのsessionを復活できる。
- transcriptを利用できない場合、別の`serve`が同じJobに新しいworkerを作り、GitHub、Linear、Git、Pull Requestからcontextを再構成する。

リレーはWebSocketによって`serve`の接続状態を把握する。Job所有権とブランチ排他は[ADR 0004](./0004-connection-ownership-and-branch-resumption.md)の専用WebSocket接続そのもので表し、切断したworkerは新しい外部操作を行えない。

所有権の単位はWorkflow全体ではなく個々のJobとする。同じWorkflowの異なる種類のJobは並行できる。コード変更はさらにbranch lockで直列化する。外部へ書き込む直前に、`serve`はJob lease、必要なbranch lock、承認revision、操作対象、許可された操作を検査する。

webhookは起床通知であり正本ではない。重複や欠落を前提とし、workerはGitHubとLinearの現在状態から必要な処理を再構成して、外部操作をidempotentにする。

### `serve`、harness、実行backend

ローカルruntimeを三層に分ける。

- **`serve`**: repository単位の常駐process。relay接続、Web UI、local stateとcredential、harnessの監督、外部操作のpolicy enforcementを担当する。
- **harness**: Jobごとに作られる別process。worker session、transcript、toolを制御し、認証済みlocal IPC経由で`serve`へ外部操作を依頼する。
- **実行backend**: Jobごとのcheckoutを持ち、コード調査、編集、build、testを実行する。v1ではworktreeだけを使う。

worktreeはJob間で共有しない。対話Jobは必要に応じてread-only checkoutを使える。実装JobとPR対応Jobはそれぞれ独立したwritable worktreeを使う。worker間の永続的な引き継ぎには共有filesystemではなくcommit、push、checkpointのHANDOFFを使う。再生成可能なcacheだけは共有してよい。

worktreeはcheckoutを分けるが、同じOS userがアクセスできるhost filesystem、process、networkからAgent commandを隔離しない。v1は強いhost isolationを保証しない。GitHub、Linear、model credentialをharnessの環境変数、引数、tool入力へ明示的に渡さず、外部操作を`serve`の制限されたinterfaceだけへ絞る境界は維持する。

workerはworktree内でファイル編集、Git状態の確認、local commitを行える。remoteへのpush、remote branch操作、Pull Request操作はharnessと`serve`を経由する。

実装workerが内部でreview subagentを使う場合、そのsubagentは同じ実装Job、harness、worktree、権限、lifecycleに属する。分散schedulerが扱う独立Jobにはしない。

### 外部操作interface

harnessへ汎用GitHub API proxyやLinear API proxyを渡さない。`serve`はJob種別と対象を限定した操作だけを公開する。

- Issue対話は対象Issueの読取り、comment、本文更新、対応Linear issueの作成を行える。
- Linear対話はTriage中の対象issueについてHOWの読取り、comment、本文更新を行える。
- 実装Jobはcanonical branchへのpushと対象Pull Requestの作成・更新だけを行える。
- PR対応Jobは対象Pull Requestとcanonical branchだけを操作できる。

AgentはLinearをTriageからTodoへ移せず、Pull Requestをmergeできない。GitHub Appの短命token、Linear OAuth token、model credentialは`serve`が保持し、harnessやsandboxへ渡さない。

### relay

公開relayはGitHub AppとLinearのwebhook、local `serve`とのWebSocket、権限を絞ったGitHub installation tokenの発行、OAuth callback、通知とtranscript requestの中継を担当する。

リレーは実行workerを選ぶ実行割当機能にはならず、接続中の`serve`によるJob所有権とブランチ排他の取得だけを原子的に調停する。コード、実行履歴、Agentセッション、Job、Workflow状態、所有権履歴は保存しない。各`serve`がGitHub、Linear、Gitを読み直し、リレーへの専用接続で所有権を取得する。

relayが永続保存できるのは、再接続と認可に必要なdevice registryだけとする。

- GitHub App installation ID
- repository ID
- 登録済み`serve`のID、device tokenのhash、表示用metadata
- 登録日時と失効日時
- routingに使うLinear workspace IDとteam ID

browserはrelayへ直接接続せず、localhostのWeb UIから`serve`を通す。`serve`は登録したrepository scopeのbearer device tokenでWebSocketを認証する。同じinstallationかつrepositoryに登録された`serve`間だけ、通知、transcript閲覧、検索を中継できる。

各`serve`はLinear OAuthを個別に完了し、tokenをOS credential storeへ保存する。relayはworkspace IDとteam IDでLinear通知をrouteするが、Linear tokenを保持しない。

v1のrelayは一つのhosting先を対象とする。multi-cloud対応とself-hosting互換はv1要件にしない。ただしprotocolと保存dataのschemaは明示する。

### 正本とlocal transcript

各情報源は一つの役割だけを持つ。

- GitHub Issue本文: WHAT
- Linear issue本文: HOW
- Linearの状態遷移: 実行承認
- Pull Request: 実装結果とmerge承認
- local transcript: workerのmessage、providerが公開するreasoning event、tool call、tool result、responseからなる実行履歴

commentは対話であり、承認済み仕様そのものではない。対話によってWHATまたはHOWが変わる場合、workerは対応する本文を更新する。承認後に束縛するversionと失効条件はADR 0003を正本とし、現在値の不一致を観測した場合に失効する。

Web UIはlocal worker sessionを閲覧・操作するinterfaceである。local対話をGitHubやLinearのcommentへ自動転載しない。確定したWHATとHOWはそれぞれの本文へ反映する。GitHubまたはLinearで始まった対話には、その場所で返答する。

transcriptとlocal execution metadataは、`serve`が所有するrepository単位のSQLite DBへ保存する。DBはcheckout pathではなくGitHub repository IDをkeyとし、OSのapplication data領域へ置く。harnessはmodel message、tool call、tool result、外部操作結果が発生するたびにlocal IPCでeventを追記し、DB fileを直接操作しない。

transcriptは自動削除しない。人間がWeb UIから明示した場合だけ削除する。同じrepositoryの接続中`serve`は、認可された別の`serve`からのtranscript閲覧・検索要求へ応答できる。relayは内容を保存せずstreamを中継する。保存元`serve`がofflineならtranscriptは利用できず、workerは外部状態からcontextを再構成する。

### repository実行設定

コード変更を伴うJobには、repository rootの`.oriel.yaml`を必須とする。v1で選べる実行backendはworktreeだけであり、`schemaVersion: 1`、`execution.backend: worktree`、`execution.autonomous: true`を明示した場合だけ自立実行を許可する。設定がない場合、Issue対話とLinear対話は動かせるが、実装JobとPR対応Jobはコードを実行しない。

実装JobとPR対応Jobがworktreeを作る際は、Pull Requestのtarget branch上にある設定だけを信頼する。working branch上でAgentが変更した実行設定は、mergeされるまでworker実行へ採用しない。

YAML 1.2としてparseした設定をValibotのstrict schemaで検証し、そのschemaを一か所の正本とする。欠落、未知field、未知versionはfail closedにする。実行可能なTypeScript設定、環境変数展開、YAML custom tagは許可しない。

model providerとcredentialは`serve`のlocal設定とする。repositoryは自動検査可能なmodel capabilityを要求できるが、provider固有のmodel IDを選ばない。実行に使ったmodelはtranscriptへ記録する。

### Pull Requestとcheckpoint

実装中はプルリクエストを作らない。実装と検証が完了し、チェックポイント専用のHANDOFFを最終差分から削除した後にレビュー可能なプルリクエストを作る。

checkpointはcanonical branchへpushしたcommitである。別workerが外部状態から再開できるようHANDOFFを含めてよい。HANDOFFは途中のcommit履歴に残ってよいが、最終Pull Requestの差分には含めない。

## 帰結

- local `serve`とtranscriptを失っても、Workflowを外部状態から再構成できる。
- 元の`serve`へ接続できればworkerの文脈を継続できるが、正しさはその継続へ依存しない。
- リレーは実行割当機能やWorkflowデータベースにならず、経路制御、認証情報境界、生きた接続の排他調停に留まる。
- Job単位のleaseにより同じWorkflowの対話と実装を並行でき、branch lockでコード変更を保護できる。
- 詳細なAgent実行履歴をrelayへuploadせず、Web UIから確認できる。
- 実行設定がないrepositoryではコード実行を始められず、worktreeによる自立実行にはrepositoryの明示的な許可が必要になる。
- harnessの別process化とJob単位worktreeにはoverheadがあるが、crash isolationとcheckoutの所有範囲が明確になる。
- worktreeは強いhost isolationを提供しないため、v1は悪意あるrepository codeからsame-userのfilesystem、process、credential storeを保護する用途には使えない。

## 保留事項

このADRでは次を決めない。

- 承認済みWHAT/HOW revisionの記録・比較方法
- 接続断検知と再接続の通信手順
- concurrency、CI retry、checkpoint、timeout、resource limitなどの運用値

これらはAPI調査、prototype、運用上の証拠を踏まえて決め、このADRの境界を維持する。
