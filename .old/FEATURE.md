# FEATURE

この文書はv1で対象にする機能と、意図的に対象外とする機能だけを定める。存在理由と不変の原則は[CONCEPT.md](./CONCEPT.md)、現在の技術方向と未解決事項は[ROADMAP.md](./ROADMAP.md)を正本とする。

## v1の対象

- LinuxとWSL2でrepository単位のlocal `serve`を動かし、localhost Web UIを提供する。
- GitHub IssueをWHAT、Linear issueをHOWと実行承認、GitHub Pull Requestを実装結果とmerge承認の正本として扱う。
- GitHub AppとLinear WebhookをCloudflareリレーで受け、リポジトリを担当する接続中`serve`へ通知し、接続中だけ有効なJob所有権とブランチ排他を調停する。
- GitHub loginとApp installationを使ってrepository単位のdeviceを登録し、Web UIからdeviceを失効できるようにする。
- Jobごとのharness processとworktreeを作り、repositoryが`.oriel.yaml`で`worktree`と`autonomous: true`を明示した場合に自立Jobを許可する。
- AgentへGitHub、Linear、model credentialを渡さず、`serve`がJobと対象を限定した外部操作を提供する。
- Job単位の接続所有権と、コードを変更するJobだけのcanonicalブランチ接続排他により、外部操作直前の所有権を確認する。
- local SQLiteへJob state、outbox、transcriptを保存し、自動削除せず、Web UIからの明示操作だけで削除する。
- local、current Job、repositoryの範囲でtranscriptを検索し、同じrepositoryを担当する接続中`serve`間の検索をrelayする。
- checkpoint commitと一時的なHANDOFFにより、別の`serve`がGitHub、Linear、GitからJobを再構成できるようにする。
- `bunx @mikan-919/oriel serve`で試用し、exact versionを指定して再現可能に起動できるようにする。

## v1の対象外

- native macOSとnative Windows
- Docker、Podman、Nix、Dev Containerの実行backend
- worktreeを越えるhost filesystem、process、networkの強い隔離保証
- AgentによるLinearのTriage→Todo、Pull Requestのmerge
- relayへのコード、Job DB、Agent session、transcriptの保存
- D1、KV、R2、Cloudflare Workflows、外部queue service
- SSR、React Server Components、server function、TanStack Start
- vector検索、embedding、外部検索service
- modelの暗黙fallback、LiteLLM、中央予算、rate limit、virtual key管理
- 外部observability service、multi-cloud relay、self-hosting互換
- Node runtime対応、global install、postinstall、自動update
- 共有ROADMAP、FEATURE.md、Web UI会話、local transcriptをJob入力の正本として扱う機能
- HANDOFF.mdを常設workspace documentとして無条件に読み込む機能
- Git上の専用ブランチ、タグ、Git参照、コミットメタデータによる所有権、排他、操作履歴の保存
