# 外部書き込みの冪等性と結果不明時の再調停

調査日: 2026-08-13

## 結論

GitHubとLinearの対象APIに、すべての書き込みで共通して使えるserver-side idempotency keyはない。しかし、結果不明や重複の処理を人間へ戻す必要はない。

- Git refは、GitHub GraphQL `updateRefs.beforeOid`または`git push --force-with-lease=<ref>:<expected>`を使えば、provider側の比較条件付き更新として処理できる。結果不明後はref名とOIDだけで一意に再調停できる。[GitHub GraphQL Git reference](https://docs.github.com/en/graphql/reference/git#updaterefs) [git-push](https://git-scm.com/docs/git-push#Documentation/git-push.txt---force-with-leaseltrefnamegtltexpectgt)
- Linearコメントは、`CommentCreateInput.id`へクライアント生成UUID v4を指定し、同じIDを`Query.comment`で取得できる。これは明示的にidempotency keyと呼ばれてはいないが、outboxで生成したresource IDを作成前から固定できるため、結果不明後も一意に収束できる。[Linear公式schema: `CommentCreateInput`](https://github.com/linear/linear/blob/a3480b14b31a0d92447224143ececa7698ac0625/packages/sdk/src/schema.graphql#L5348-L5416) [Linear公式schema: `Query.comment`](https://github.com/linear/linear/blob/a3480b14b31a0d92447224143ececa7698ac0625/packages/sdk/src/schema.graphql#L37798-L37814)
- GitHub Issue/PRコメントとPull Request作成にはクライアント指定resource IDがない。作成前に対象の既存resource ID集合をoutboxへ保存し、応答不明後に同じGitHub App actor・対象・内容・自然キーで差分を全page列挙する。複数の新規候補があれば一つをcanonicalとして残し、コメントは削除、PRはcloseすることで機械的に圧縮できる。[GitHub issue comments REST](https://docs.github.com/en/rest/issues/comments) [GitHub pull requests REST](https://docs.github.com/en/rest/pulls/pulls)
- GitHub Issue/PR bodyとLinear issue description/stateは、既知objectへのdesired-state設定である。current valueがdesiredなら完了、beforeなら再送、それ以外なら同時編集として再調停する。重複resourceは発生しないが、各APIにatomicなcompare-and-swapはないため、競合をproviderだけで防ぐことはできない。[GitHub update issue](https://docs.github.com/en/rest/issues/issues#update-an-issue) [GitHub update pull request](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request) [Linear公式schema: `IssueUpdateInput`](https://github.com/linear/linear/blob/a3480b14b31a0d92447224143ececa7698ac0625/packages/sdk/src/schema.graphql#L21612-L21741)

したがってv1で必要なのは「人間による重複管理」ではなく、`serve`が保持する永続intent ledgerである。各outbox entryに、論理operation ID、対象、before valueまたは作成前ID集合、desired value/digest、取得できたprovider resource IDを保存し、所有権を確認した単一writerがread-backと圧縮を完了させる。非表示IDを本文へ埋め込む必要はない。

## 共通のprovider制約

### HTTP idempotency keyと書き込みprecondition

GitHubの対象REST endpointが公開するrequest header/body parameterには`Idempotency-Key`がない。またGitHubは、`POST`、`PUT`、`PATCH`、`DELETE`のconditional requestを、そのendpointに個別記載がない限りサポートしないと明記している。対象のcomment、issue、pull request、Git ref endpointには`If-Match`の例外記載がないため、ETagをwrite CASとして使えない。[GitHub REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate) [issue comment parameters](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment) [issue update parameters](https://docs.github.com/en/rest/issues/issues#update-an-issue) [pull request parameters](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request) [Git ref parameters](https://docs.github.com/en/rest/git/refs#update-a-reference)

2026-08-13に取得したLinear公式GraphQL schemaでも、`commentCreate`、`commentDelete`、`issueUpdate`およびそれらのinputに、共通のidempotency key、`clientMutationId`、expected version、`updatedAt` preconditionは公開されていない。[Linear公式schema: mutations](https://github.com/linear/linear/blob/a3480b14b31a0d92447224143ececa7698ac0625/packages/sdk/src/schema.graphql#L23064-L23122) [Linear公式schema: `issueUpdate`](https://github.com/linear/linear/blob/a3480b14b31a0d92447224143ececa7698ac0625/packages/sdk/src/schema.graphql#L25391-L25403)

### GitHub GraphQL `clientMutationId`

GitHub GraphQLの`clientMutationId`はmutation inputへ渡し、直後のpayloadで返される「clientの一意識別子」である。`addComment`、`updateIssue`、`createPullRequest`、`updatePullRequest`、`updateRefs`に存在するが、作成後の`IssueComment`、`Issue`、`PullRequest`、`Ref`から検索するfieldとしては公開されず、同じ値の再送をdeduplicateする契約も記載されていない。したがって応答相関には使えるが、応答自体を失った後のreceiptやserver-side idempotency keyとしては扱えない。[GitHub GraphQL mutation guide](https://docs.github.com/en/graphql/guides/forming-calls-with-graphql#about-mutations) [Issues schema](https://docs.github.com/en/graphql/reference/issues#addcomment) [Pull requests schema](https://docs.github.com/en/graphql/reference/pulls#createpullrequest) [Git schema](https://docs.github.com/en/graphql/reference/git#updaterefs)

## API別の能力

### GitHub Issue/PR conversation comment

Pull Requestのconversation commentはIssue comment APIを使う。create requestは対象Issue/PR番号と`body`だけを受け取り、成功時にGitHub生成の一意な`id`と`node_id`、actor、body、作成時刻を返す。クライアント側でcomment IDを指定するfieldはない。[Create an issue comment](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)

個別GET、対象Issue/PRのcomment一覧、update、deleteがあり、一覧はpaginationできる。したがってIDを受け取れた通常系では、そのIDをoutboxへ保存して以後同じcommentを更新すればよい。[Get/list/update/delete issue comments](https://docs.github.com/en/rest/issues/comments)

create応答が不明なら、次の手順で人間を介さず収束できる。

1. create前に対象Issue/PRの既存comment ID集合を全page取得してoutboxへ保存する。
2. 応答不明後、同じ対象を再び全page列挙し、baselineにないcommentのうち、期待するGitHub App actorと正規化body digestが一致するものを候補にする。
3. 一件ならそのIDを採用する。複数なら最小IDなど事前に固定した規則で一件を残し、残りをID指定でdeleteする。0件なら同じintentを再送し、再び列挙する。[List issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments) [Delete an issue comment](https://docs.github.com/en/rest/issues/comments#delete-an-issue-comment)

この圧縮が厳密にoperationを識別できる条件は、同じactorが同じ対象へ同じ正規化bodyを送る別intentを並行実行しないことである。これはAPIの保証ではなく、Job所有権、外部操作直前のfencing、outboxの論理operation順序で`serve`が守る条件である。baselineを失った場合、GitHub APIだけでは以前から存在する同一actor・同一bodyのcommentと今回の結果を区別できない。この場合も人間に選別させるのではなく、append-onlyの新規commentを必須成果にせず、既知IDを持つ論理comment slotの更新へ寄せることが設計上の安全な帰結となる。

### GitHub Issue/PR body update

Issueは`PATCH /repos/{owner}/{repo}/issues/{issue_number}`、Pull Requestは`PATCH /repos/{owner}/{repo}/pulls/{pull_number}`でbodyを設定し、同じobjectをGETしてcurrent bodyを読める。requestにはexpected body digest、expected `updated_at`、`If-Match`などのatomic preconditionがない。[Update an issue](https://docs.github.com/en/rest/issues/issues#update-an-issue) [Update a pull request](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request) [unsafe methodのconditional request制約](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate)

結果不明時は`before digest`と`desired digest`を使い、currentがdesiredなら完了、beforeなら同じdesiredを再送する。currentがどちらでもなければ、別編集が発生しており、単純な再送はそれを上書きする。この分岐は重複管理ではないため、機械的なthree-way mergeがcleanなら新しいdesiredへ更新し、意味的競合なら通常のJob判断経路へ戻す。API単独ではreadとwriteの間の競合を閉じられないので、再送後にもcurrent valueを読み直す必要がある。

### GitHub Pull Request creation

create requestはrepository、head、base、title、body、draft等を受け取り、成功時にGitHub生成の`id`、`node_id`、`number`を返すが、クライアント側resource IDやidempotency keyは受け取らない。[Create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)

一覧は`state`、`head=user-or-org:ref-name`、`base`でfilterでき、各Pull Requestからhead/baseのrepository、ref、SHAとtitle/bodyを取得できる。このため、v1の「activeなcanonical branchとPull RequestはWorkflowごとに一つ」という不変条件の下では、`(repository, head repository, head ref, base ref, expected head OID)`を自然キーとしてread-backできる。[List pull requests](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests) [PullRequest GraphQL object](https://docs.github.com/en/graphql/reference/objects#pullrequest)

create応答が不明なら、create前に同じhead/baseに該当するPR ID/number集合を全page保存し、`state=all`で再列挙する。baselineにない自然キー一致候補が一件なら採用する。複数なら事前規則で一件をcanonicalにし、残りのopen PRを`PATCH state=closed`で閉じる。PRのdelete APIは公開されていないため、収束操作はdeleteではなくcloseになる。[List/create/update pull requests](https://docs.github.com/en/rest/pulls/pulls)

候補が0件ならcreateを再送し、`201`だけでなく`422`や通信断でも再列挙する。baseline以前のPRはcleanup対象にせず、応答不明中にPRがmergeまたはcloseされた場合は現在phaseを優先して新規作成しない。ここでも、同じ自然キーに対する並行createをJob所有権とbranch排他でfenceすることが必要である。

### Git ref updateとGit push

GitHub RESTのref updateは`sha`と`force`だけを受け取る。`force=false`はnon-fast-forwardを拒否するが、expected old OIDとの完全一致を要求するCASではない。ref名を指定したGETでcurrent OIDはread-backできる。[Git references REST](https://docs.github.com/en/rest/git/refs)

GitHub GraphQL `updateRefs`は複数の`RefUpdate`をatomicに適用し、どれかが拒否されれば一つも変更しない。`beforeOid`で更新前OIDとの一致を要求でき、zero OIDはref不存在の確認、`afterOid`のzero OIDはdeleteを表す。これは対象API中で最も強いprovider-native CASである。[GitHub GraphQL `updateRefs`](https://docs.github.com/en/graphql/reference/git#updaterefs)

system Gitでpushする場合、`git push --force-with-lease=<ref>:<expected-old>`はremote refが明示したexpected OIDと一致する時だけ更新し、一致しなければ失敗する。`<expect>`を空にすればref不存在を条件にできる。複数refには`--atomic`を付けると、serverが対応している場合に全ref成功または全ref失敗となり、非対応ならpush自体が失敗する。[git-push `--force-with-lease`](https://git-scm.com/docs/git-push#Documentation/git-push.txt---force-with-leaseltrefnamegtltexpectgt) [git-push `--atomic`](https://git-scm.com/docs/git-push#Documentation/git-push.txt---atomic)

GraphQLでもGit pushでも、結果不明後はcurrent ref OIDを読む。`current == after`なら完了、`current == before`なら同じCASを再送、どちらでもなければ競合である。branch createでは`before = zero`、deleteでは`after = zero`として同じ三分岐を使える。Git objectの再送自体は問題ではなく、refのcurrent OIDが外部結果の証明になる。

### Linear comment

Linearの`CommentCreateInput.id`は、指定しなければbackendが生成するUUID v4 resource IDを、クライアントから指定できる。`commentCreate`は作成された`Comment`を返し、`Query.comment(id:)`で特定commentを取得でき、`commentDelete(id:)`で削除できる。[Linear公式schema: `CommentCreateInput`](https://github.com/linear/linear/blob/a3480b14b31a0d92447224143ececa7698ac0625/packages/sdk/src/schema.graphql#L5348-L5416) [Linear公式schema: comment mutations](https://github.com/linear/linear/blob/a3480b14b31a0d92447224143ececa7698ac0625/packages/sdk/src/schema.graphql#L23064-L23122) [Linear公式schema: `Query.comment`](https://github.com/linear/linear/blob/a3480b14b31a0d92447224143ececa7698ac0625/packages/sdk/src/schema.graphql#L37798-L37814)

したがってoutbox commit時にUUID v4を生成し、最初のrequestから常に同じIDを渡す。応答不明後はそのIDをreadし、対象Issueとbodyがintentに一致すれば完了、一致しない既存objectなら衝突として停止、存在しなければ同じIDでcreateを再送する。同じIDの再送が成功応答を返すこと自体は公開契約にないが、既存IDエラーになってもread-backで結果を判定できるため、dedupe semanticsへ依存しない。

クライアント指定IDを使わなかった場合でもIssueのcomment connectionを全page列挙し、ID指定でdeleteできる。しかしGitHubと同じ候補同定問題が生じるため、v1では必ず作成前にIDを固定するのが最小で強い契約になる。[Linear公式schema: `Issue.comments`](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/objects/Issue) [Linear pagination](https://linear.app/developers/pagination)

### Linear issue description/state update

`issueUpdate(id:, input:)`は既知Issueを部分更新し、`IssueUpdateInput`に`description`と`stateId`がある。公式の例も同じmutationでstateを設定し、Issue queryでdescriptionとstateを取得する。[Linear GraphQL getting started](https://linear.app/developers/graphql#creating-and-editing-issues) [Linear公式schema: `IssueUpdateInput`](https://github.com/linear/linear/blob/a3480b14b31a0d92447224143ececa7698ac0625/packages/sdk/src/schema.graphql#L21612-L21741)

`IssueUpdateInput`にはexpected state、expected description、expected `updatedAt`のfieldがなく、mutation argumentも`id`と`input`だけである。`Issue.updatedAt`は観測値として読めるがwrite preconditionにはならない。[Linear公式schema: `issueUpdate`](https://github.com/linear/linear/blob/a3480b14b31a0d92447224143ececa7698ac0625/packages/sdk/src/schema.graphql#L25391-L25403) [Linear Issue schema](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/objects/Issue)

state/descriptionの結果不明時は、currentがdesiredなら完了、beforeなら同じdesiredを再送、どちらでもなければ外部変更として現在phaseまたはthree-way mergeへ進む。TodoからIn Progress、merge後のDoneのようなstate設定はdesired-state operationなので重複resourceを生まず、current stateの一致で機械的に収束できる。ただしread後の人間変更とwriteをatomicには排他できないため、write後の再読とWorkflow全体の再調停は必要である。

## 能力マトリクス

| 操作 | native idempotency / CAS | 結果不明後の一意なread-back | 重複後の機械収束 |
| --- | --- | --- | --- |
| GitHub Issue/PR comment create | なし。`clientMutationId`は永続receiptではない | provider IDを受信済みなら一意。未受信ならbaseline差分 + actor + body | 候補を一件採用し、余剰commentをIDでdelete |
| GitHub Issue/PR body update | なし | object ID + current body | desired-state再送。第三の値はmerge/reconciliation |
| GitHub PR create | なし | baseline差分 + head/base + expected head OID | 一件を採用し、余剰open PRをclose |
| GitHub ref update / push | `updateRefs.beforeOid`またはexplicit `--force-with-lease` | ref名 + current OID | afterなら完了、beforeならCAS再送、第三のOIDは競合 |
| Linear comment create | client指定UUID resource ID。明示的idempotency keyではない | `comment(id:)` | 同じIDでread/createを反復。余剰resourceを作らない |
| Linear issue description/state update | なし | issue ID + current description/state | desired-state再送。第三の値はmerge/reconciliation |

## 設計への帰結

- 外部write outboxの`idempotency key`はproviderへ送る共通headerではなく、`serve`内の論理intent IDとして扱う。providerごとのnatural key、before、desired、baseline ID集合、返却resource IDへ結び付ける。
- create系は送信前にbaselineを永続化し、update系はbeforeとdesiredを永続化する。外部操作直前の所有権確認後も、送信より前にこのoutbox commitが完了していなければならない。
- 応答不明は直ちに人間へ戻さず、まずread-backする。create系の複数候補はdeterministic compaction、update系の第三の値はprovider current stateからの再調停として処理する。
- GitHub commentだけは、baselineを失うとAPI-nativeにoperation attributionできない。これを人間へ押し付けるのではなく、同一actorの並行writerを禁止し、progress等の反復出力は既知comment IDのupdateへ寄せ、append-only commentを本当に一回だけ必要な成果へ限定する。
- Git refにはREST updateを使わず、GraphQL `updateRefs`または明示expected OID付きGit pushを使う。PR作成とcomment作成はCASがないため、接続所有権だけでなくin-flight旧requestを含む事後圧縮までを正常系に含める。

## 調査範囲と未証明点

- Linear schemaは2026-08-13に公式endpointのintrospectionと、同日の公式SDK repository `a3480b14b31a0d92447224143ececa7698ac0625`を照合したsnapshotである。Linear APIはversion固定ではなくschemaが変化するため、実装時には固定SDK版のschemaと検証専用環境での実動作を再確認する。[Linear GraphQL introspection](https://linear.app/developers/graphql) [Linear API deprecations](https://linear.app/developers/deprecations) [Linear公式SDK repository](https://github.com/linear/linear/tree/a3480b14b31a0d92447224143ececa7698ac0625/packages/sdk)
- Linearの同じclient指定comment IDを再送した時に「同じobjectを成功として返す」か「duplicate ID errorを返す」かは公開契約で確認できなかった。本設計はどちらにも依存せず、再送前後にIDでread-backする。
- GitHubの対象create endpointが同一payloadを自動deduplicateする契約は確認できなかった。本設計はdeduplicateを仮定せず、baseline差分の列挙と余剰resourceの削除/closeで収束する。
- GitHub上で`updateRefs`のno-op compare、Git transportの`--atomic`、Linear client指定UUIDのcreate/read/deleteは、実装前に検証専用環境で実動作を確認する。公開資料が示すschema能力と、対象GitHub App installation/Linear workspaceの実効権限は別に検証する必要がある。
