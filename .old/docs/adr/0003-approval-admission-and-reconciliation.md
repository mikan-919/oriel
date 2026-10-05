# ADR 0003: 承認指紋によるadmission、branch封印、reconciliation

- 状態: Accepted — 承認指紋、現在値の二重確認、ブランチ作成時機、観測した変更での安全側停止方針は決定済みである。所有権と既存ブランチ引き継ぎは[ADR 0004](./0004-connection-ownership-and-branch-resumption.md)が置き換える。
- 日付: 2026-08-13

## 背景

実装Jobは、人間がLinear IssueをTriageからTodoへ移して承認したWHAT（GitHub Issue）とHOW（Linear Issue）だけを実行する。webhookは重複、順不同、欠落、遅延を許容するため、通知またはlocal stateを承認の根拠にはできない。

承認後、workerを始めるまでに本文、title、関連付け、target branchが変わり得る。本文を別の正本として保存せずに、その実行がどのWHAT/HOW versionに束縛されるかをJob、lease、branch、外部操作へ一貫して渡す必要がある。[ADR 0002](./0002-job-ownership-and-execution-state.md)の承認revision tuple、Job identity、所有権、外部operation fencingのうち、この問題を置き換える範囲をこのADRで定める。

GitHubとLinearのnative historyは、provider間の完全な順序、本文変更の完全性、attachment relinkの全履歴を保証しない。本システムは悪意ある履歴改ざんへの耐性をv1の承認条件にせず、Todoになった後の現在値を所有権取得の前後で二度読み、一致した内容だけを実行対象として封印する。二回のread間で観測できない一時変更や、変更後に元の値へ戻った事実は検出しない。

## 決定

### 正本とapproval fingerprint

- GitHub IssueのtitleとbodyだけがWHATである。Linear IssueのtitleとdescriptionだけがHOWであり、LinearのTriage→Todo遷移だけが実行承認である。
- **approval fingerprint**は、seal時点で二度一致した現在のWHAT/HOWと対応するimmutable IDを束縛するversion tokenである。WHAT/HOWの正本、承認receipt、本文snapshot、または履歴の代替ではない。
- `serve`は承認指紋をJob識別子、接続所有権キー、canonicalブランチ名、外部操作要求へ保存または送ってよい。title、body、description、履歴snapshot、またはそれらの複製はこれらへ保存しない。
- native historyは診断と監査表示の補助情報として利用してよいが、取得可能性、完全性、順序をadmissionまたは外部操作の必須条件にしない。history IDとtimestampをJob identity、lease key、branch名、external operation requestへ入れない。
- `serve`はfingerprintを計算する一連のread中だけprovider文字列をmemoryに保持し、成功・失敗を問わずそのattemptの本文値を破棄する。fingerprintだけから本文を復元できるとは扱わない。

### canonical encoding

schema markerを`"oriel/approval-fingerprint/v1"`とする。`repository ID`は対象GitHub repositoryのimmutable node ID、`GitHub Issue node ID`は対象Issueのimmutable node ID、`Linear issue UUID`は対象Linear Issueの`id`である。全てをprovider APIが返したstringとして取得できなければadmitしない。

`body`または`description`がprovider APIで`null`または未設定なら空stringにする。それ以外の値はstringでなければadmitしない。titleはstringでなければadmitしない。Unicode正規化、trim、改行変換、case変換、HTML/Markdown変換、URL正規化、またはprovider文字列への他の変換は**行わない**。

次のJavaScript値を、この順序のまま`JSON.stringify`する。objectを使わないためproperty順序の余地はない。

```ts
[
  "oriel/approval-fingerprint/v1",
  repositoryId,
  githubIssueNodeId,
  githubTitle,
  githubBody ?? "",
  linearIssueUuid,
  linearTitle,
  linearDescription ?? "",
]
```

その`JSON.stringify`結果をUTF-8 bytesとしてSHA-256し、digestをlowercaseの64桁hexで表す。`JSON.stringify`またはUTF-8 encodingの失敗、非string input、SHA-256の失敗、または64桁lowercase hexでない結果ではfail closedする。このencodingとschema markerを変える変更は新しいADRとschema markerを要する。

### canonical branch

canonical branchは次である。

```text
oriel/<Linear identifier>-gh-<GitHub issue number>-<full digest>
```

`<full digest>`は上記64桁を省略しない。`<Linear identifier>`と`<GitHub issue number>`は人間がroutingするための表示部分だけであり、version bindingはdigestだけが担う。

Linear identifierは変換せず、`^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$`に一致しなければならない。GitHub issue numberは正の整数をleading zeroなしの10進表現にしたものとする。組み立てたbranch名はさらにGit実装の`check-ref-format --branch`に通らなければならない。いずれかを満たさない場合、置換・slug化・切り詰めはせずadmitしない。初回create前のidentifier変化はprospective branch名を変えるためそのattemptを停止してreconcileする。ただし同fingerprintのcanonical refが既に一意に存在する場合、routing部分のidentifier変化でrefをrenameまたは追加作成せず、その同じrefだけをadoption candidateとする。複数candidateまたは一意性を証明できない場合はfail closedする。

### admissionとbranch封印の順序

**seal**は、CASでcanonical branchを作った後に現在値を再読し、fingerprint、state、関連付け、baseが一致したと確認して初めて完了する。workerはsealより前には存在してはならない。通知を受けた、pollで変化を見つけた、または再起動した`serve`は、次の順序だけで実装workerを開始する。

1. 人間がLinear IssueをTriageからTodoへ移す。`serve`、Agent、リレーはこの遷移を実行しない。リレーは署名・認可済み通知の経路制御と[ADR 0004](./0004-connection-ownership-and-branch-resumption.md)の接続所有権調停を担うが、通知内容、本文、承認指紋、Job、所有権記録、履歴を正本として永続化しない。
2. `serve`はread-only reconciliationを行う。current Linear stateがTodoであること、current attachmentからGitHub Issueが一意に解決すること、current state、attachment tuple、GitHub/Linear title・本文、Linear identifier、target base refとそのOIDを読む。
3. 読んだ現在値から承認指紋とcanonicalブランチ名を計算し、その承認指紋を含むJob識別子を導出する。Job識別子をキーに[ADR 0004](./0004-connection-ownership-and-branch-resumption.md)のJob所有権接続を取得し、接続越しに現在のJob取得IDを確認する。
4. 同じ`claiming`中に、Workflow全体の置換隔離を事前確認した後、期待するcanonicalブランチをキーとするブランチ排他接続を取得する。Git参照がまだ存在しない場合と同じ承認指紋の引き継ぎ候補である場合のどちらでも、新しいJob識別子、Job取得ID、ブランチ取得IDが一致することを接続越しに確認しなければならない。取得または確認が失敗・結果不明ならworkerを開始しない。Job所有権接続を安全に閉じられる場合だけ`pending`へ戻り、そうでなければ`interrupted`へ移る。
5. GitHubとLinearを再読し、手順2と同じstate、attachmentの組、WHAT/HOW、識別子、承認指紋、取り込み先Git参照、およびcanonical Git参照の存在と先端を再計算する。canonical Git参照が不存在なら取り込み先OIDも最初の読み取りと一致しなければならない。既存canonicalブランチを引き継ぐ場合、同じ取り込み先Git参照のOID前進は承認を失効させない。その他が変わった場合はブランチを作らずworkerを開始しない。保持する接続を安全に閉じ、下記の差し戻しを行う。
6. step 5でcanonical refが不存在なら、GitHub GraphQLの`updateRefs`を一回だけ呼び、target base refの不変とcanonical refの不存在を同じatomic updateの比較条件にする。`expectedBaseOid`をstep 5で確認したOID、`zeroOid`を40桁のzero OIDとして、`force: false`の二つの`RefUpdate`を渡す。

   ```text
   target base ref: beforeOid = expectedBaseOid, afterOid = expectedBaseOid
   canonical ref:   beforeOid = zeroOid,         afterOid = expectedBaseOid
   ```

   最初のno-op updateはbase refがそのOIDから変わっていないことだけを比較し、二番目はcanonical refが存在しないときだけbase OIDで作る。`updateRefs`は全updatesをatomicに処理し、一つでも拒否されればどちらのrefも変更されない。実装前に検証専用repositoryで、このGitHub App installation/tokenがno-op compareを受け付けることを確認しなければならない。未対応、権限不足、または結果不明なら、`createRef`、逐次更新、または別の弱いcreate APIへfallbackせずfail closedする。
7. initial createの`updateRefs`がtimeout、接続切断、または曖昧な応答なら成功として再送しない。target base refとcanonical refをread-backし、両方がexpected OIDでありcanonical ref名もexpected branch名に正確に一致することを確認してからだけ次へ進む。refが既に存在すると確定した場合は、下記のexisting same-fingerprint branch adoption flowだけへ進める。他の不一致、読取不能、または結果不明では`interrupted`へ移りworkerを開始しない。
8. 初回作成または同じ承認指紋の既存ブランチ引き継ぎの後、`serve`はGitHubとLinearをもう一度再読する。state、attachmentの組、WHAT/HOW、承認指紋、取り込み先Git参照、ブランチ名、現在のJob/ブランチ取得IDと下記のWorkflow全体の置換隔離が一致するときだけworkerを開始する。初回作成では取り込み先OIDも一致しなければならない。既存ブランチでは取り込み先OIDの前進を許容し、worker開始後に最新の取り込み先を統合して再検証する。

手順8で不一致または証明不能なら、workerを開始せず、ブランチ排他接続、Job所有権接続の順に閉じる。比較条件付きで作成済みのブランチは有効なcanonicalブランチにしない。自動削除、上書き、または再利用はこのADRでは決めない。

### Workflow-wide replacement fence

承認指紋を持つ実装Jobがcanonicalブランチからworkerを開始する前に、`serve`はリレーで同じWorkflowの生きたJob所有権接続とブランチ排他接続、および現在の有効なcanonicalブランチ/プルリクエストの組を確認する。異なるJob識別子のコード変更Jobについて、workerが停止済みであり、現在接続を持たないことを確認しなければならない。実装中はプルリクエストが存在してはならない。プルリクエストが存在する場合は実装Jobの引き継ぎではなく、レビューフェーズまたはPR対応Jobとして扱う。旧ブランチのGit参照が物理的に残るだけで、有効な組にも現在の接続排他にも属さないなら非有効であり、この確認を妨げない。

異なるJobが現在の所有権接続を保持する、接続の消失または書き込み結果が不明である場合、新Jobはworkerを開始しない。自分の接続を安全に閉じられるなら`pending`へ戻り、できなければ`interrupted`へ移る。旧Jobの停止確認より先に有効なcanonicalブランチ/プルリクエストの組を新ブランチへ移動してはならない。

異なるfingerprintのattemptが並行しても、各attemptはseal後の現在値と自分のfingerprintが一致するときだけworkerを開始できる。したがって同じWorkflowでworkerを開始できるJob identityは高々一つである。二回のread間で変更後に元の値へ戻った場合は同じfingerprintとして扱い、その一時変更の検出は保証しない。

### 現在値の一致とTriageへの差し戻し

admissionと外部操作前の確認は、provider-native historyではなく現在値を使う。少なくとも次が先行read、所有権取得後のread、seal後のreadで一致しなければならない。

- Linear stateがTodoであること
- GitHub IssueとLinear Issueのimmutable ID、現在のattachment relation
- GitHub/Linearのtitleと本文から計算したfingerprint
- 取り込み先Git参照、canonicalブランチ、現在のJob/ブランチ取得ID。canonicalブランチの初回作成中だけ取り込み先OIDも一致を要求する。

承認対象または接続所有権が一致しなければ`serve`はworkerを開始せず、実行中なら新しい外部操作を拒否してworkerを停止する。取り込み先OIDの前進だけでは承認を失効させない。`serve`は現在のJob所有権接続と対象Workflowを再確認してからLinear IssueをTodoからTriageへ戻し、人間のfresh Triage→Todoを待つ。この差し戻しは承認ではなく、無効になった承認状態の機械的な反映である。リレー、Agent、harnessは差し戻しを実行しない。

差し戻しは次の手順だけで行う。

1. 現在のJob所有権接続を持つ`serve`がworkerを停止し、新しい外部操作を拒否する。コード変更Jobではブランチ排他接続も保持したままにする。他の`serve`、リレー、Agent、harnessは差し戻さない。
2. `serve`は現在のJob取得ID、対象Workflow、対象Linear Issue、差し戻し原因になった承認指紋不一致を再確認する。担当権が変わっていたら何も書かない。
3. Linear Issueの現在stateを読み直す。Todoの場合だけ、Triageへの更新attemptを作る。すでにTriageなら成功として扱い、それ以外のstateなら人間または他処理の変更を上書きせず終了する。
4. 更新送信前に、Job識別子、Job取得ID、Linear Issue ID、操作種別`return-to-triage`、一意な試行IDを持つ操作記録をローカルSQLiteへ永続化する。この試行IDを内部の冪等性キーとし、自動処理は同じ試行を二度送信しない。
5. 更新後にLinear Issueを読み直す。Triageなら成功、Todoのままなら失敗または結果不明、それ以外なら外部変更を優先した終了として記録する。理由commentは投稿しない。
6. 成功または外部変更による終了では、ブランチ排他接続、Job所有権接続の順に閉じる。TodoのままならJobを`interrupted`とし、workerを停止したまま、接続を再試行のためだけに維持しない。

Todoのままになった試行を自動再送しない。ローカルWeb UIは差し戻しに失敗したことと手動の「再試行」を表示する。人間が再試行を明示した場合だけ、同じ`serve`が現在のJob所有権接続をまだ持つこととLinear IssueがなおTodoであることを再確認し、新しい試行IDで手順4以降を実行する。担当権を失っていれば再試行を拒否する。

Linearのstate更新にcurrent stateを原子的な比較条件として渡せない場合、step 3のreadとwriteの間で人間がstateを変えるraceは残る。v1はこのraceを受け入れ、応答後のreadで観測したstateを正本として扱う。

native historyはこの一致判定の入力にしない。履歴の欠落、group化、provider間の順序不明だけを理由にautomatic admissionを無効化しない。履歴が完全でない理由と許容するraceは[approval history capability調査](../research/approval-history-capabilities.md)に記録する。

### 初回branch作成、existing same-fingerprint branch adoption、再承認

承認指紋が変わればcanonicalブランチ名も変わり、手順6の初回作成だけが候補である。fresh Triage→Todoでも承認指紋が同じなら同じ論理Jobとcanonicalブランチを再利用する候補になる。新しい実行試行は新しいJob取得IDで区別する。

canonical Git参照が不存在なら初回作成を使う。Git参照が既に存在する場合、その存在だけでadmissionを成功または失敗と決めず、[ADR 0004](./0004-connection-ownership-and-branch-resumption.md)の同じ承認指紋を持つ既存ブランチ引き継ぎへ分岐する。新Jobは先行workerの停止と旧接続の消失、実装中のプルリクエスト不存在を確認した後、自身のJob所有権接続とブランチ排他接続を取得する。既存Git参照を強制送信、reset、上書きしてはならない。

引き継ぎでは過去の既知の書き込みまたは安全なチェックポイントの永続証明を要求しない。現在の先端を未検証の作業途中成果として引き継ぎ、差分検査、ビルド、テストを最初から行う。ビルドまたはテストの失敗は引き継ぎを拒否する理由にせず、引き継ぎ先workerが同じ承認範囲で修復する。承認対象、接続所有権、ブランチ対応、Git状態を現在値から一意に再構成できない場合は安全側で停止する。

一致する非終端Jobなら通常の再開だけが候補であり、このADR、ADR 0002、ADR 0004の現在値確認と隔離条件を満たさなければならない。実装中はプルリクエストを作らず、実装と検証が完了してからレビュー可能なプルリクエストを作る。プルリクエスト作成後の処理はレビューフェーズとPR対応Jobが扱う。

running中またはresume前にstate、attachment tuple、またはapproval fingerprintの不一致を観測したら、旧workerを停止し、旧Jobは新しいexternal operationを開始しない。`serve`は上記の手順でTriageへ戻す。fingerprint変化を伴うWHAT/HOW変更では、fresh Triage→Todoの後に新Jobと新canonical branchを導出する。

### external operation fencing

承認指紋を伴う外部操作要求は、[ADR 0002](./0002-job-ownership-and-execution-state.md)で定めるJob識別子、対象、Job取得ID、必要なブランチ取得ID、冪等性キーに加え、その承認指紋を含む。外部操作の直前に`serve`は現在state、attachmentの組、対象Issue ID、現在の承認指紋、canonicalブランチ/プルリクエストの組、現在の取得IDを再調停し、リレーの確認応答を受け、全てが要求と一致するときだけ書き込む。一致判定が不合格・不明なら書き込みを拒否して旧workerを停止し、上記の手順でTriageへ戻す。

履歴IDと時刻を要求へ入れてはならない。提供元APIは接続所有権の確認を原子的な書き込み前提条件として受け付けないため、通信待ち時間超過、異常終了、所有権喪失、または書き込み結果不明では盲目的に再試行しない。操作固有の収束手順は[ADR 0005](./0005-connection-liveness-and-external-write-reconciliation.md)に従う。

## 帰結

- branchはTodo承認後かつworker開始前にだけCASで作られる。full digestにより、human-readable routing部分が変わってもversion bindingを取り違えない。
- digestを「どこにも置かない」という以前の結論は撤回する。fingerprintは必要なversion bindingとして保存するが、本文や履歴を第二の正本へ複製しない。
- native historyの完全性は要求しないため、二回のread間で観測できない一時変更や元の値への差し戻しを検出できない。v1はこのraceを受け入れ、観測した不一致だけをfail closedにする。

## 対象外

- Issue/Linear対話、comment、本文更新
- Pull Request、Git push、checkpoint、PR review、required checkの個別reconciliation
- 接続所有権の認証、切断検知、再接続の通信手順
- device登録、OAuth、webhook署名、relay認可
- staleまたはinactive branchの自動削除方針

## 実装前の検証

automatic admissionを実装または有効化する前に、検証専用repositoryとLinear workspaceで、現在値の取得、二重read、fingerprint一致、Todo→Triage差し戻し、GitHub App installation tokenによるatomic `updateRefs`の実動作を確認する。native historyの完全性は合格条件に含めない。
