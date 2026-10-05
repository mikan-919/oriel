# ADR 0007: PR対応Job

- 状態: Accepted
- 日付: 2026-08-17

## 背景

[ADR 0001](./0001-distributed-workflow-and-worker-model.md)は基本のJobを四種類と定め、「PR対応: 人間のreviewまたはrequired checkの失敗へ対応する」を挙げたうえで、「ハーネスが作ったPull Request上の人間によるreview、inline comment、PR commentは、追加のmentionなしでPR対応Jobを開始する」「required checkの失敗もPR対応Jobの入力とする」「同じcheckへの修正が連続して失敗した場合は、設定された上限で自動対応を止め、人間へ報告する」ことを決めた。[ADR 0003](./0003-approval-admission-and-reconciliation.md)は「Pull Request、Git push、checkpoint、PR review、required checkの個別reconciliation」を明示的に対象外としており、PR対応Jobの受理条件・discovery・reconciliationの詳細はどのADRにも書かれていない。

GitHub Issue #39（レビューとrequired check失敗へ対応する）の実装にあたり、この空白を埋める。実装Job（#33〜#38）が確立した承認・所有権・checkpointの機構をそのまま転用できる部分と、PR対応Job固有に決めなければならない部分を分ける。

## 決定

### Job識別とWorkflowとの関係

PR対応JobのJob識別子は`pr-response:{repositoryId}:{githubIssueNumber}:{approvalFingerprint}`とする。実装Jobの`implementation:{repositoryId}:{githubIssueNumber}:{approvalFingerprint}`と同じWorkflow・同じ承認指紋を共有するが、prefixで種別を区別する。WHAT/HOWが変わらない限り、同じPR上の複数回のreview・comment・check失敗は同じ論理Job（同じJob識別子）への追加入力として扱い、新しいworkerがその都度、現在のPRとcanonicalブランチの状態からcontextを再構成する。承認指紋が変わるWHAT/HOW改訂は新しい実装Jobと新しいcanonicalブランチを作るため、その場合は現在のPR対応Jobも対象を失い、旧workerは停止する。

branch lockは実装Jobと同じキー`{repositoryId}/{canonicalBranch}`をそのまま共有する。[ADR 0002](./0002-job-ownership-and-execution-state.md)が定めるとおり、同じcanonicalブランチを変更する二つのコード変更Jobは同時に現在のブランチ排他接続を持てないため、実装JobとPR対応Jobが同じブランチへ同時に書き込むことはこの排他だけで防げる。PR対応Job専用の排他キー体系は持たない。

### 対象とするPull Request

PR対応Jobが対象とするのは、canonicalブランチ名から実装Jobの承認指紋を復元でき、そのPull Requestのhead refがそのcanonicalブランチ、base refが実装Job admission時点のtarget base refと一致するものだけとする。それ以外のPull Request（人間が独自に作ったもの、他Workflowのものなど）は対象にしない。

### discoveryの入力とtrigger判定

webhookは起床通知に過ぎず、判定の正本にしない（ADR 0001/0006の原則を維持する）。`serve`は起床後、対象repositoryのopenなPull Request一覧から実装Jobの命名規約に一致するcanonicalブランチのPRを洗い出し、それぞれについて現在値を読み直して次の三種類のtriggerを判定する。

1. **Changes requestedレビュー**: 最新のPR review submissionが`CHANGES_REQUESTED`であり、そのreviewのsubmitted_atが、harness自身（`serve`が使うinstallation tokenのactor）による直近のcheckpoint pushまたは返信commentより新しい場合。
2. **新規コメント**: PR会話コメントまたはinlineレビューコメントのうち、authorがharness自身のactorでなく、そのcreated_atが直近のcheckpoint pushまたは返信commentより新しいものが一件以上ある場合。
3. **required checkの失敗**: 対象PRのhead commitに対するcheck runのうち、target baseのbranch protectionが`required_status_checks.checks`へ列挙した名前に一致し、かつconclusionが`failure`・`timed_out`・`action_required`のいずれかであるものが一件以上あり、かつそのcheck名の連続失敗回数がまだ3回未満の場合。

branch protectionを読めない場合、required checkの集合を確定できないため、check起因のtriggerは判定しない（fail closedとし、read不能を「requiredなし」と誤認しない）。上記いずれにも該当しなければPR対応Jobを開始しない。承認・approve・neutral/skipped/cancelled/queued/in_progressのcheck、およびCOMMENTEDだけのレビューはtriggerにしない。

「未対応」の判定は、HOW対話・WHAT対話と同じく、harness自身の最新の書き込み（checkpoint pushのcommit時刻、または後述の報告comment）より新しい人間の入力があるかどうかで行う。専用の既読テーブルは持たない。

### 収束しない場合の上限

required check起因のtriggerだけに、同じcheck名についての連続失敗回数を数える上限を設ける。回数は`(repositoryId, canonicalBranch, checkName)`をキーにlocal SQLiteへ保存し、そのcheckが最後にsuccessまたはneutralへ転じた時点で0へ戻す。

PR対応Jobがそのcheckを解消できないまま終了する（checkpointを完了できない、または送信後に同じcheck名が再び失敗する）たびに1つ加算する。加算後の回数が3に達したら、それ以降そのcheck名では新しいPR対応Jobを開始せず、後述の報告commentを一度だけ投稿する。人間が新しいreviewまたはコメントを投稿する、または当該checkがsuccess/neutralへ転じるまで、この停止を解除しない。

レビューコメント起因のtriggerにはこの上限を適用しない。人間の新しいレビュー投稿そのものが既に律速であり、「同じ失敗の自動再試行」に当たらない。

### 外部操作の範囲

PR対応Jobが行ってよい外部操作は次だけとする。

- 対象PRへのcomment投稿（進捗報告、収束できなかった場合の報告）。
- 対象canonicalブランチへのcheckpoint push（実装Jobの`checkpoint-push.ts`/`canonical-worktree.ts`をそのまま再利用する）。

Pull Requestのmerge、close、base/head変更、他のPull Requestやbranchへの操作は行わない。対象外のPR番号・branch名を指定した要求は`serve`が拒否する。

### workerとharness

`serve`はcanonicalブランチの現在の先端でworktreeを開く（`openCanonicalWorktree`をそのまま再利用する。実装Jobと違い、初回作成や引き継ぎの判定は行わず、PRのhead refが指す現在のcanonicalブランチ先端をそのまま使う）。harnessへは次を渡す。

- Changes requestedレビューのtriggerでは、そのレビュー本文と未解決のinlineコメント（path/line/body）。
- 新規コメントのtriggerでは、未対応のコメント本文一覧。
- required check失敗のtriggerでは、check名・conclusion・`output.summary`/`output.text`（取得できる範囲）。CIの生ログ収集はv1へ含めない。

harnessはcredentialを持たず、実装Jobと同じworktree tool（read/write/list/run_command）だけを使う。修正後の検証は実装Jobと同じ`.oriel.yaml`の`execution.verification`をやり直す。commit・checkpoint送信は実装Jobのharness worker（`implementation.ts`）と同じ手順を踏む。Pull RequestやGit branchを操作するtoolは持たない。

### Linear状態

PR対応Jobは承認そのものを再判定しない。Linearのstateは触らない（レビュー用stateの反映は実装Job側の`reflectReviewState`が既に行っている）。

## 帰結

- PR対応Jobは実装Jobのcheckpoint・worktree機構をそのまま再利用でき、新規に必要なのはdiscovery（レビュー・コメント・check状態の読み取りとtrigger判定）、収束上限のための失敗回数store、限定した外部操作ポート、専用のharness modeだけになる。
- branch lockを共有することで、実装JobとPR対応Jobが同じcanonicalブランチへ同時に書き込む競合をADR 0002の既存の排他だけで防げる。
- required checkの対象をbranch protectionの`required_status_checks.checks`に限定するため、branch protectionを設定していないrepositoryではcheck起因のPR対応Jobは動かない（レビュー・コメント起因のtriggerはbranch protectionの有無に関わらず動く）。

## 対象外

- CIの生ログ収集・要約
- required checkの再実行（re-run）操作
- Pull Requestのmerge、close、base/head変更
- 収束しなかった場合の人間による「再試行」操作の詳細UI（ローカルWeb UIの範囲、issue #40）
- 他のPull Request・branchへの操作

## 実装前の検証

ADR 0003〜0006の慣例に従い、検証専用のGitHub App test installationとrepositoryで、branch protectionの`required_status_checks.checks`読み取り、check run conclusionの読み取り、`CHANGES_REQUESTED`レビューとinlineコメントの読み取り、installation tokenでのPRコメント投稿が本ADRの記述通りに動くことを確認してから有効化する。
