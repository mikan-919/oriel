# 承認からsealまでのnative history capability調査

調査更新日: 2026-08-13

## 結論

[ADR 0003](../adr/0003-approval-admission-and-reconciliation.md)は、current GitHub IssueとLinear Issueから決定的に計算したapproval fingerprintを、seal後のJob、lease、canonical branch、外部operationの**version binding**として使う。fingerprintは「Todoへ移した瞬間の本文」を証明するものではなく、WHAT/HOWの正本でもない。本文、title、description、履歴、またはsnapshotを別の正本へ保存しない方針は維持する。

調査の結果、GitHubとLinearのnative historyだけでは、Todo承認時点からbranch sealまでの本文、関連付け、provider間順序を完全には証明できない。特にGitHub body履歴の完全性、Linear historyの省略とgrouping、attachment relink、cross-provider causal orderに契約上のgapがある。

v1はこの完全性を要求しない。Todoになった後の現在値を所有権取得の前後で二度読み、同じstate、attachment、WHAT/HOW、fingerprint、baseを観測した場合だけworkerを開始する。観測した不一致では停止して`serve`がTriageへ戻すが、二回のread間で変更後に元の値へ戻った事実は検出しない。

native historyは診断と監査表示の補助情報として利用できるが、その取得可能性、完全性、順序はautomatic admissionの合格条件ではない。webhookも起床通知であり、現在状態の再読を置き換えない。

以前の「digestをどこにも置かない」という結論は撤回する。ADR 0003が定めるfingerprintはversion bindingとして保存してよい。ただしfingerprintから本文を復元できるとは扱わず、本文やhistoryをreceiptとして複製しない。

## 現在確認できるprovider surface

### GitHub Issue

- GitHub GraphQLの`Issue.lastEditedAt`は最後の編集時刻であり、`Issue.userContentEdits`はcursor paginationを持つ編集connectionである。[GitHub GraphQL Issue reference](https://docs.github.com/en/graphql/reference/issues)
- Issue titleの変更は`Issue.timelineItems`に含められる`RenamedTitleEvent`から、immutableな`id`、`createdAt`、`previousTitle`、`currentTitle`、actorとして観測できる。[GitHub GraphQL RenamedTitleEvent reference](https://docs.github.com/en/graphql/reference/issues#renamedtitleevent)
- `UserContentEdit`にはimmutableな`id`と`editedAt`がある。一方、公開schemaの`diff`は変更summaryであり、過去のIssue title/bodyそのものを返すfieldを示さない。connectionに順序指定もない。[GitHub GraphQL UserContentEdit reference](https://docs.github.com/en/graphql/reference/users)
- title eventはtitle変更の観測可能性を強めるが、このsurface全体でもTodo承認とのcross-provider順序、履歴retention、全title/body変更との一対一対応、または過去本文の再構成を契約しない。`createdAt`、`lastEditedAt`、`editedAt`の単純比較は、検討した完全履歴gateの証明には使えない。
- GitHub webhookは発生順のdeliveryを保証せず、遅延または未達があり得る。[GitHub webhook troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks) [GitHub failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)

### GitHub Git ref

- GitHub GraphQLの`updateRefs`は複数のref updateをatomicに実行する。`beforeOid`は現在OIDの比較条件であり、40桁のzero OIDはref不存在の比較に使える。[GitHub GraphQL Git reference](https://docs.github.com/en/graphql/reference/git)
- ADR 0003のbranch sealは、target base refの`beforeOid = afterOid = expectedBaseOid`というno-op compareと、canonical refの`beforeOid = zeroOid`、`afterOid = expectedBaseOid`を同一の`updateRefs`へ渡す。このno-op compareをGitHubがApp installation/tokenで受け付けるかは、実装前に検証専用repositoryで実動作を確認する必要がある。未対応または結果不明なら、逐次ref createや別APIへfallbackせずautomatic admissionをfail closedする。

### Linear Issue

- Linearのdata-change webhookには現在の`data`、`updatedFrom`、action時刻、delivery UUIDなどがあるが、payloadは通知であり履歴の正本ではない。失敗deliveryは最大3回retryされる。[Linear Webhooks](https://linear.app/developers/webhooks)
- LinearのGraphQL endpointはintrospectionをサポートし、connectionはRelay形式のcursor paginationを使う。[Linear GraphQL API](https://linear.app/developers/graphql) [Linear Pagination](https://linear.app/developers/pagination)
- Linear公式GraphQL docsは、Issue作成から最初の3分に行われたIssue property変更をcreation processの一部として扱い、Issue changeとしてactivity logへ追加しないと説明する。[Linear GraphQL API](https://linear.app/developers/graphql) したがって、検討した完全履歴gateでは、Todo承認からsealまでの区間がIssue作成から3分以内の時間帯と重なる場合に不合格となる。3分を過ぎたことだけでも履歴の完全性を証明しない。
- 2026-08-13の同endpointのintrospectionでは、`IssueHistory`の一recordが、同じactorによる短いgrouping window内の一つ以上のproperty変更を表すと説明されている。`fromTitle`/`toTitle`、`updatedDescription`、`fromStateId`/`toStateId`、`attachmentId`などを持つが、descriptionのold/new valueは持たず、`attachmentId`もlink/unlinkの方向やold/new URLを表さない。[Linear IssueHistory schema](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/objects/IssueHistory)
- `Issue.history`はcursor paginationと`createdAt`または`updatedAt`のorderを提供する。しかしgroupingされたrecord内の個々の変更順、履歴retention、全変更の完全性を契約しない。
- Linear attachmentは同じIssue IDとURLの組をidempotentに扱い、再作成が既存attachmentを更新し得る。current relationは取得できるが、IssueHistoryだけから過去のrelink sequenceを復元する契約はない。[Linear Attachments](https://linear.app/developers/attachments)
- Linear APIはversion固定ではなく、schemaはdeprecationを通じて変わり得る。[Linear API deprecations](https://linear.app/developers/deprecations)

## 証拠のgap

- **cross-provider history**: LinearのTodo遷移とGitHubの編集について、同じclock上の完全な全順序または因果順序を公開契約から得られない。時刻文字列の比較だけでは承認後編集を否定できない。
- **attachment relink**: current attachmentのID/URLから現在の対応は読めても、承認時点からsealまで同じGitHub Issueを指していたこと、relinkがなかったこと、またはrelink履歴が完全であることを公開surfaceだけからは導けない。
- **Linear creation windowとhistoryのgrouping/omission**: 公式GraphQL docsは作成から最初の3分のIssue property変更をactivity logへ追加しない。よってTodo承認からsealまでがこのwindowと重なるcandidateは、検討した完全履歴gateでは観測の成否にかかわらず失格になる。window外でも、同じactorの短いwindow内の複数変更が一recordへgroup化され、`updatedDescription`と`attachmentId`はold/new valueや変更方向を持たないため、個々の操作との一対一対応・順序・完全性は証明できない。
- **paginationと可視性**: cursorをpage終端まで辿れたことは、そのtokenが見える範囲を読めたことを示すだけである。retention、権限で隠れたrecord、rate limit/partial error、移行、schema変更後にも承認区間が完全である保証にはならない。

これらのgapはfingerprintで埋めない。fingerprintはseal時のcurrent valueを束縛するだけであり、historyが示せない承認時点の内容を遡及して承認済みにしない。

## 検討した完全履歴gate（不採用）

当初は、automatic admissionを有効にするrepositoryごとに次の完全履歴gateを要求する案を検討した。

1. current Linear state、current attachment、GitHub Issue、GitHub/Linearのtitle・本文、target base ref/OIDを取得できること。
2. current Todo承認を一意に特定し、そのimmutable `IssueHistory.id`をapproval episode keyとして取得・再構成できること。keyが指す承認からread時点までのstate、attachment、title、本文に関するnative historyを全page・全必要fieldで取得できなければならない。group化、同時刻、partial error、missing page、またはfieldの意味が曖昧なら不合格とする。
3. GitHubとLinearの履歴を、承認対象の同一性と承認後の非変更を証明できる順序へ結び付けられること。provider timestampの比較だけ、webhook delivery順、またはcurrent valueの一致だけでは合格にしない。
4. GitHub App installation/tokenで、`updateRefs`のtarget base refに対する`beforeOid = afterOid = expectedBaseOid`のno-op compareが受け付けられること。実際のsealではこのcompareとcanonical refのzero-OID createを一つのatomic `updateRefs`に含める。未対応、権限不足、または結果不明なら別のcreate APIへfallbackしない。
5. branch create前後の再読でも同じ証明が維持されること。attachment relink、本文更新、base advance、token可視性低下、rate limit、API error、またはschema driftのどれかで証明不能になれば、そのattemptをfail closedすること。

実装前のcapability testはquery shape、required permission、error処理、pagination実装を確認する価値がある。しかし完全性を普遍化できず、通常の共同開発に対して過剰な停止条件になるため、このgateはadmission条件として採用しない。

## 2026-08-13 旧gateの実環境観測

対象をGitHub repository `mikan-919/oriel`と、接続済みLinear workspaceのteam `Mikan-919`に限定して、上記gateをread-onlyで評価した。既存の業務Issueをfixtureとして変更せず、gateの合否に不要なIssue、attachment、branchも作成しなかった。

| Criterion | Evidence | Reproduction | Environment | Status |
| --- | --- | --- | --- | --- |
| current Linear state、attachment、GitHub Issue、WHAT/HOW、target baseを取得できる | GitHub GraphQLではrepository node ID `R_kgDONNn0gg`、default branch `main`、current OIDを取得できた。一方、GitHubのopen Issueは0件で、Linear検索にもOriel Issueはなく、対応するWorkflow/attachmentが存在しない | GitHub repository queryとopen Issue countをGraphQLで取得し、Linear issue searchで`Oriel`を検索する | 2026-08-13、GitHub `mikan-919/oriel`、Linear team `Mikan-919` | UNPROVEN |
| Todo承認とimmutable `IssueHistory.id`を一意に再構成できる | team `Mikan-919`のstatusはBacklog、Todo、In Progress、In Review、Done、Canceled、Duplicateで、設計が承認eventとして要求するTriage状態が存在しない。したがってTriage→Todo episodeを生成・再構成できない | 接続済みLinear APIでteamの全issue statusを列挙する | 2026-08-13、Linear OAuth user `haruname315` | UNPROVEN |
| GitHub/Linear間で承認後の非変更と順序を証明できる | 対応Workflowがなく、公開契約にもcross-provider causal orderはない。provider timestampやcurrent valueの一致による代用は禁止している | Oriel対応Issue検索結果と上記provider surfaceの契約を照合する | 同上 | UNPROVEN |
| GitHub App installation tokenでatomic `updateRefs` no-op compareを実行できる | GraphQL schemaに`UpdateRefsInput`が存在することは確認できたが、現在の`gh` credentialはuser OAuth tokenである。repository installation endpointもApp JWTを要求して401となり、対象installation tokenによるmutationは検証できなかった | GraphQL introspectionで`UpdateRefsInput`を取得し、current credentialでrepository installation endpointをreadする | 2026-08-13、GitHub CLI user OAuth credential | UNPROVEN |
| branch create前後の再読で同じ証明を維持できる | 前提となるapproval episode、対応attachment、App installation tokenがないためbranch createを実行しなかった | 前4 criterionのstatusを確認する。いずれかがUNPROVENならmutationを開始しない | 同上 | UNPROVEN |

この観測は完全履歴gateを採用できない根拠になったが、現在のADR 0003ではautomatic admissionを無効化する条件ではない。実装前には専用GitHub/Linear Issueとattachmentを使って現在値の二重readを検証し、対象repositoryのGitHub App installation tokenでatomic `updateRefs`の実動作を確認する。検証用branchは専用namespaceに限定し、結果不明時に再送しない。

## 設計への帰結

- webhook delivery ID、payload、timestamp、history IDは通知または診断の補助情報であり、Job identity、lease key、canonical branch、external operation requestのversion tokenにしない。
- approval fingerprintの正確なencoding、branch封印順序、既存branch/resume、external operation fencingは[ADR 0003](../adr/0003-approval-admission-and-reconciliation.md)を正本とする。
- 履歴が不十分な場合にreceipt、comment、label、attachment、relay state、SQLite state、Git ref、または本文copyを追加して穴埋めしない。現在値の不一致を観測した場合は`serve`がTriageへ戻し、人間によるfresh Triage→Todoを待つ。
