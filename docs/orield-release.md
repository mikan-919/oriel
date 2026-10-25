# orieldの公開

利用者向けのインストールと端末登録は[導入手順](getting-started.md)を参照してください。

`orield`だけをcrates.ioへ公開します。バージョンはルートの`Cargo.toml`の`[workspace.package]`から継承し、初回は`0.1.0`、ライセンスはMIT、所有者は`mikan-919`です。Web・Relayの配備は別の処理です。

## 初回の設定

1. crates.ioへGitHubの`mikan-919`でログインし、[プロフィール](https://crates.io/settings/profile)でメールアドレスを登録・認証します。
2. [APIトークン](https://crates.io/settings/tokens)を作成します。対象を`orield`、権限を初回公開用の`publish-new`と更新用の`publish-update`にします。
3. GitHubに公開用環境（Environment）`crates-io`を作り、利用元をmainブランチだけに制限します。自動公開するため、公開時の承認者は設定しません。
4. 以下を登録し、最後に`ORIELD_RELEASE_ENABLED`を`true`にします。

| 登録場所 | 名前 | 値 |
| --- | --- | --- |
| 環境`crates-io`の**Environment secrets** | `ORIELD_CRATES_IO_TOKEN` | crates.ioのAPIトークン |
| 環境`crates-io`のEnvironment variables | `ORIELD_CRATES_IO_OWNER` | `mikan-919` |
| リポジトリのActions variables | `ORIELD_RELEASE_ENABLED` | `true` |

トークンは**Secrets**に登録します。Variablesに登録しても公開処理には渡りません。トークンをソースコード・コマンドの引数・チャットに貼らず、GitHubの設定画面から入力してください。期限がある場合は、期限前に更新します。

`ORIELD_RELEASE_ENABLED`が未設定または`true`以外なら、検証だけが動作し、公開は行われません。

## 初回公開と再実行

公開設定がmainに反映された状態で実行します。

```sh
gh workflow run orield.yml --ref main -f publish=true
gh run list --workflow orield.yml --branch main --limit 1
gh run watch <run-id> --exit-status
```

`publish`を省略した手動実行は検証だけを行います。プルリクエストとmain以外のブランチからは公開しません。

公開の前に、書式、Clippy、テスト、梱包内容、公開の模擬実行、配布用パッケージのインストールと`--help`を検証します。検証環境はUbuntu x86_64とRust stableです。通常起動、端末の接続、外部連携、自動実装の実行は公開時の検証には含みません。

公開後は、crates.ioから対象バージョンを指定してインストールし、リポジトリ外で`orield --help`を実行します。取得に失敗した場合は30秒間隔で最大10回試します。実行結果と概要に、公開・公開済みによる省略・配布後の検証結果が記録されます。

## 次のバージョンを公開する

1. ルートの`Cargo.toml`の`[workspace.package].version`を上げ、`Cargo.lock`の対応するワークスペースパッケージのバージョンを更新します。共有設定のため、他のワークスペースパッケージも同じバージョンになります。
2. 変更をmainへ反映します。[公開処理](../.github/workflows/orield.yml)の対象パスに変更があれば、検証後に未公開のバージョンを公開します。公開処理は同時に実行されません。
3. 公開処理と配布後のインストール確認が成功したことを確認します。

同じバージョンでの変更は再公開されません。公開済みならアップロードを省略し、既存の配布物のインストールを確認します。

## 失敗した場合

| 原因・状態 | 対応 |
| --- | --- |
| メールアドレスが未認証 | crates.ioのプロフィールで認証し、公開を再実行する |
| トークン未設定・期限切れ・権限不足 | 環境`crates-io`のSecretと、トークンの期限・公開権限を確認する |
| 名前の所有者が不一致 | 公開を停止し、crates.ioの所有者と`ORIELD_CRATES_IO_OWNER`を確認する |
| crates.ioからの情報取得に失敗 | 通信・サービスの状態を確認する。取得失敗を未公開とは扱わない |
| 対象バージョンが公開取り消し済み（yanked） | 公開を停止し、取り消し理由と次のバージョンを判断する |
| 公開は成功し、その後のインストール確認が失敗 | 同じバージョンで再実行する。公開済みバージョンは上書きできない |

初回の名前の空き確認は予約ではありません。他の所有者が先に登録した場合、公開は失敗します。名前・所有者・対象バージョンの確認は[公開スクリプト](../scripts/orield-release.py)で行います。
