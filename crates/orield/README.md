# orield

`orield`は、ローカルで動くCodexをOrielのブラウザー画面と中継サービス（Relay）に接続するデーモンです。

## 前提

- Linux x86_64とRust stable。初回リリースの検証環境はUbuntu x86_64です。他のOS・CPUと、最低Rustバージョンは検証対象外です。
- `codex`コマンドが実行できること。自動実装には`auto_review`に対応したCodexが必要です。
- OrielのWeb・Relayが稼働していること。これらの配備は`orield`のインストールには含まれません。

## インストール

crates.ioへの公開後は、次のコマンドで導入できます。

```sh
cargo install orield --locked --version '=0.1.0'
orield --help
```

公開前やソースから導入する場合は、リポジトリのルートで実行します。

```sh
cargo install --path crates/orield --locked
orield --help
```

## 使い方

作業するリポジトリで`orield`を起動します。初回はブラウザーでパスキーのアカウントに端末を接続し、端末側でも接続先を確認します。接続済みの端末は、次回から自動で再接続します。

| コマンド | 動作 |
| --- | --- |
| `orield` | Codexを起動し、ブラウザーに端末を接続する |
| `orield codex` | Codex app-serverを起動し、ブラウザーの会話画面に接続する |
| `orield integrations` | GitHub・Linearの接続状況を表示する |
| `orield workflow` | Issueの変更を監視して、計画・承認済み作業を進める。Ctrl-Cで終了する |
| `orield workflow --once` | 監視を続けず、作業の確認と処理を1回行う |
| `orield --help` | コマンドと設定を表示する |

同じ端末の`orield codex`と`orield workflow`は同時に起動できません。

相談用のapp-serverが終了するとRelay接続と再接続を停止し、Webには端末での起動案内が表示されます。`orield codex`は再起動を案内するエラーで終了します。終了コード0やstdoutの切断も相談サービスの終了として扱い、自動再起動はしません。Ctrl-Cによる停止は、子プロセスの回収に成功すれば正常終了します。

`workflow`／`workflow --once`では相談用app-serverが終了しても作業を継続します。その間は実行中のworkflowを含めWebからの操作ができません。Web操作を復旧する場合はworkflowをCtrl-Cで停止してから再起動してください。Relayだけの切断ではapp-serverを維持して再接続します。

## 自動実装の条件

Web画面でGitHub・Linearの連携を設定し、対象リポジトリのコミットに`.oriel.yaml`を含めてください。設定形式は[Orielリポジトリの例](https://github.com/mikan-919/oriel/blob/main/.oriel.yaml)を参照できます。検証コマンドは対象プロジェクトに合わせて指定します。

計画（HOW）の作成は読み取り専用です。実装には、人によるLinear Todoでの承認と、`.oriel.yaml`での自律実行の許可が必要です。

承認後の実装は、Codexの`auto_review`で実行要求を自動審査します。実行権限の境界は維持され、審査で拒否された操作や人の判断が必要な質問では停止する場合があります。計画作成と手動の会話は、利用者による承認を使います。

## 設定と保存先

| 設定 | 既定値・用途 |
| --- | --- |
| `ORIEL_RELAY_URL` | 接続先。既定値は`https://oriel-relay.mikan-919.workers.dev`。パスや認証情報を含まない接続先を指定する |
| `ORIEL_IDENTITY_FILE` | 端末の認証ファイルの保存先を上書きする |
| `XDG_CONFIG_HOME` | 認証ファイルを`oriel/device.json`に保存する。未設定時は`~/.config/oriel/device.json` |
| `XDG_STATE_HOME` | 作業用チェックアウトと実行記録を`oriel/workflow`に保存する。未設定時は`~/.local/state/oriel/workflow` |

認証ファイルには端末の秘密情報が含まれます。共有や公開をしないでください。中断時の作業は保存先に残ります。

検証用の依存関係のキャッシュは、利用者のキャッシュへのリンクを再利用します。参照先が削除・変更された場合はリンクを外し、保存先やキャッシュ本体を削除せずに再作成できる状態に戻します。ホスト側の検証では不足した依存関係を取得できます。Codex側はネットワークを使わないキャッシュ利用を維持し、パッケージ管理の認証設定は引き継ぎません。

`orield workflow`は、PRのマージを検知すると、対応する実装用の作業ツリー（Gitの分離された作業ディレクトリ）を自動で削除します。変更・未追跡ファイルがなく、現在のコミットがマージ済みPRの最終コミットと一致する場合に削除します。無視対象の生成物も作業ツリーとともに削除されます。ローカルのブランチと実行記録は残ります。削除できない場合は理由を表示して作業を保持し、次回の監視時に再試行します。Linearが既にDoneの作業も対象で、再起動後や`workflow --once`でも処理します。

## 開発・公開

[Orielの開発手順](https://github.com/mikan-919/oriel#開発する)と[crates.ioへの公開手順](https://github.com/mikan-919/oriel/blob/main/docs/orield-release.md)を参照してください。ライセンスは[MIT](https://github.com/mikan-919/oriel/blob/main/crates/orield/LICENSE)です。

Linux x86_64 の workflow 検証は独立した監視プロセスが実行します。
デーモンの SIGKILL、Ctrl-C、検証の正常終了・失敗時に、専用プロセス群の
子・孫を SIGKILL で停止し、Linux subreaper で回収します。デーモン切断は
20ms 間隔で監視し、停止確認まで作業ルートのロックを保持します。
再起動時にロックが競合した場合は作業を保存して中断するため、旧監視の
回収完了後に再試行してください。ログと検証の終了コードは保持されます。
保証対象は同じプロセス群に残る子孫です。setsid/setpgid による離脱、監視
プロセス自体の同時強制終了、他OSは保証対象外です。停止は非同期であり、
デーモン終了と同時の停止は保証しません（試験の停止期限は5秒です）。

停止・回収の確認に失敗した監視はロックを保持して待機します。この場合は
ログを調査し、残存プロセスの停止を確認してから監視を終了してください。

Linuxでは、検証の監視とGitの認証補助処理を、起動中のorield本体から起動します。実行ファイルが再ビルド・更新で置き換わっても、動作中の版を使って作業を続けます。新しい版へ切り替える場合は、workflowをCtrl-Cで停止して再起動してください。

npmのパッケージキャッシュは専用ホームへコピーします。共有キャッシュが検証途中で削除されても参照切れにならず、npm設定・認証情報はコピーしません。既存のキャッシュリンクは専用ディレクトリへ置き換えます。
