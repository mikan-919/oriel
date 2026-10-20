# 単発走査の終了状態

`orield --once` は走査中の通常の作業失敗を issue 番号と元のエラーとともに保持し、shutdown 後に失敗を返す。後続の作業が成功しても先行する失敗は消えない。承認待ちのみ、作業なし、全作業成功の場合は成功を返す。

失敗報告、suppressed 更新、lease 解放、作業ファイルと停止理由の保持は既存の処理を維持する。結果反映が失敗した場合も元の作業エラーを含めて失敗する。継続運転では通常の作業失敗を再接続の理由にせず、同じセッションで次回走査へ進む。

回帰試験は、失敗後の後続成功、再承認、claim/release、結果反映失敗、継続運転、および子プロセスの成功時 0／失敗時非 0 を確認する。ローカル HTTP/WebSocket と注入した Work を利用し、外部アカウントは使用しない。

## 2026-10-20 の検証再実行

- `cargo fmt --all -- --check`: 成功。
- `cargo clippy -p orield --all-targets --locked -- -D warnings`: 成功。
- `cargo test -p orield --locked`: 46 件成功、14 件失敗。ローカルソケットの bind がサンドボックス内で `Operation not permitted` となり、終了状態および SIGINT の子プロセス試験も実行できなかった。ホストで全試験を再実行する必要がある。
- ホストで失敗した `npm --prefix crates/oriel-relay ci` も再実行した。既定キャッシュでの実行は取得待ちのため中断し、`npm_config_cache=/tmp/oriel-npm-cache npm_config_offline=true` を指定して再実行したところ、`zod-4.4.3.tgz` の `ENOTCACHED` で失敗した。

提供されたホスト診断の直接のエラーは `verification-home/.npm/_cacache` の `ENOTDIR` だった。このキャッシュパスは作業ツリー外にあり、リポジトリの実装や lockfile の問題とは確認できない。ホスト所有者は検証環境のキャッシュ参照先が利用可能なディレクトリであることと、lockfile に必要なパッケージが揃っていることを確認してから、設定済みの全検証を再実行する。今回、実行・承認ポリシー、試験、依存バージョンは緩和していない。

## 指定ベース統合後の検証

`740716fe0ac931e85349ec9ceae5cd1a9b22a618` を既存の実装へマージした。複数作業が失敗したときに両方の issue と理由がプロセスのエラーへ残る試験ケースも追加した。

- `cargo fmt --all -- --check`: 成功。
- `cargo clippy -p orield --all-targets --locked -- -D warnings`: 成功。
- `cargo test -p orield --locked`: 単体試験47件成功、14件失敗。失敗した試験はローカルソケット作成時の `Operation not permitted`、またはその子プロセス失敗によるもの。単体試験の失敗により後続の統合試験には到達していない。ホストで全試験を再実行する必要がある。

## npm キャッシュの検証修復

ホスト検証の npm キャッシュは共有 `_cacache` へのリンクを使用せず、検証用 HOME 内の実ディレクトリを使用するよう修正した。既存のリンクはリンクだけを解除し、共有データと既存のローカルキャッシュ内容は保持する。リンク先が存在する場合・消失した場合・共有元の指定がない場合を回帰試験で確認した。エージェントのオフラインキャッシュ再利用と検証・承認ポリシーは維持している。この修復をホストへ反映するには、修正後の orield で検証を実行する必要がある。

- `cargo fmt --all -- --check`、`cargo clippy -p orield --all-targets --locked -- -D warnings`: 成功。
- `cargo test -p orield --locked`: 48件成功、14件失敗。追加したキャッシュ回復試験は成功。失敗は従来同様、サンドボックスのローカルソケット作成制限と関連する子プロセス試験による。
- `npm_config_cache=/tmp/oriel-npm-cache npm_config_offline=true npm --prefix crates/oriel-relay ci`: 再実行したが `zod-4.4.3.tgz` の `ENOTCACHED` で停止。ホストで依存取得と全設定済み検証を再実行する。

## npm ENOTDIR 再発時の追加確認

検証用 `_cacache` のリンク先がディレクトリではなく通常ファイルである場合も、リンクだけを解除して npm が必要とする階層を作成できることを回帰試験に追加した。共有元のファイルは保持する。リンク解除・ディレクトリ作成に失敗した場合は、対象パスと操作をエラーへ付加する。

再発したホスト診断は、既存修正が作成する実ディレクトリと異なるキャッシュ状態を示している。リポジトリの修復だけで稼働中のホスト実行ファイルは更新されないため、修正後の orield による検証が必要である。作業ツリー外のキャッシュや実行ポリシーは変更していない。

`npm_config_cache=/tmp/oriel-npm-cache npm_config_offline=true npm --prefix crates/oriel-relay ci` を再実行した。今回も `zod-4.4.3.tgz` の `ENOTCACHED` で停止したため、依存インストールの成功は未確認。

追加修復後の `cargo fmt --all -- --check` と `cargo clippy -p orield --all-targets --locked -- -D warnings` は成功。`cargo test -p orield --locked` は49件成功、14件失敗。新規回帰試験は成功し、失敗はサンドボックスのソケット作成制限と関連する子プロセス試験による。ホストで全設定済み検証を再実行する。
