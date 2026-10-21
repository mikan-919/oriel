# PTY終了通知

通常PTYモードではchild.waitの結果を保持し、終了後は同じPTYへの再接続を停止する。
EOFだけでは終了と判定しない。終了時は出力排出を最大2秒、通知送信を最大2秒、
接続終了を最大1秒待つ。同期PTY操作はblocking poolで実行し、runtime終了待ちも1秒に制限する。

制御フレームは `oriel-terminal-exit:` にJSONを続ける。
`{"state":"exited","code":0,"signal":null}` または `{"state":"wait_failed"}` を送る。
Relayは現在のhost世代の通知だけを受理し、offlineと終了情報を保存する。
終了情報は次の正規host接続で消去する。通常の通信断では従来の猶予を維持する。
通信断中の終了はローカルログに残し、通知の再送経路は設けない。

Webは制御フレームを端末出力へ流さず、開いている端末と一覧にtextContentで理由を表示する。
一覧APIのterminal_statusは既存値を維持し、terminal_exitを追加する。
内部terminal-status応答は同じ2フィールドのJSONになった。

## 検証

- `cargo clippy --workspace --all-targets -- -D warnings`: 通過。
- daemonの終了状態保持、購読前終了通知、送信停滞の個別テスト: 通過。
- Relay Rust unit tests: 3件通過。
- `node --test crates/oriel-web/test/dashboard.test.mjs`: 通過。
- Rust対象全体（`cargo test -p orield --bin orield`）: 48件通過、13件失敗。12件はsandboxのOperation not permitted、
  1件はsignal fixtureの起動失敗。ホスト環境で再実行が必要。
- Relay/Webで `npm ci --offline --prefix <directory>` を試行したが、zod等の
  オフラインキャッシュ不足で失敗。Relay統合テストはws未導入で起動不能。
  ホスト環境で依存導入・Relayビルド後、terminal-presence.test.mjsを実行する。

## ホスト検証の依存導入失敗

2026-10-20のホスト検証は `npm --prefix crates/oriel-relay ci` で停止した。
`verification-home/.npm/_cacache` は `/home/nixos/.npm/_cacache` へのリンクで、
提示されたログの主エラーはこのパスに対する `ENOTDIR`。
`node_modules` 削除時の `ENOTEMPTY` はcleanup警告であり、PTY終了処理の失敗ではない。

独立した既存キャッシュで、同じコマンドを
`npm_config_offline=true npm_config_cache=/tmp/oriel-npm-cache` を付けて再実行した。
`ENOTDIR` は発生しないが、`zod-4.4.3.tgz` の `ENOTCACHED` で停止する。
Webの依存導入も同じ理由で失敗し、Relay統合テストは `ws` 不足で起動できない。
再検証ではclippy、Relay Rust単体テスト3件、Web dashboardテストが通過した。

Relay/Webの `.npmrc` に `cache=.npm-cache` を追加し、通常の `npm --prefix <directory> ci`
でも作業ディレクトリ内のキャッシュを使用するよう修正した。生成キャッシュはGit対象外とする。
ホストのキャッシュ、検証設定、テスト条件は変更していない。
オフライン再試行では `ENOTDIR` は解消し、未キャッシュの `zod-4.4.3.tgz` に対する
`ENOTCACHED` を確認した。ネットワークを利用できるホストで依存導入と全検証を再実行する。

修正後の通常導入も再実行した（待機を制限するためfetch retries=0、timeout=10000）。
`npm --prefix crates/oriel-relay ci` は `ENOTDIR` ではなく、registry.npmjs.org の
名前解決制限 `EAI_AGAIN` で停止した。clippy、Relay Rust単体3件、Web dashboardは再度通過。
daemon全体は再度48件通過・13件失敗（sandboxの権限制限とsignal fixture起動失敗）。
Relay統合テストは依存未導入のためwsの解決に失敗した。

## 一覧応答の検証修正

ホスト検証で判明した `relay.test.mjs` の一覧応答の期待値2か所を更新した。
新規登録と旧devicesスキーマからの移行の双方で、終了前は `terminal_exit: null`
となることを厳密比較する。既存の所有権・repository検証は維持した。

修正後、`npm --prefix crates/oriel-relay test` を再実行したが、sandboxでは
ローカルサーバー起動が `listen EPERM 127.0.0.1` となる。
対象テストをisolationなしで実行してこの原因を確認した。ホストで全件再検証が必要。
Webのnpmテストは4件すべて通過、workspace全対象のclippyも通過。
daemon全体は48件通過・13件失敗で、sandboxの権限制限とsignal fixture起動失敗が残る。

## 指定更新元の統合と終了競合の補強

`740716fe0ac931e85349ec9ceae5cd1a9b22a618` を現在のブランチへマージした。
接続試行と再試行待機は保持済み終了状態を優先する共通処理へまとめ、
購読前・接続待機中・再試行待機中の終了が操作を開始／継続させないことを検証する。
PTY入力・リサイズはロック取得後にも終了状態を確認し、ロック待ち中に終了した場合の操作を抑止する。

今回の検証ではWebのnpmテスト4件とRelay Rust単体テスト3件が通過した。
daemon全体は50件通過・13件失敗。追加した接続／再試行終了テスト、
終了状態保持、購読前通知、送信停滞テストは通過している。
失敗は従来と同じsandboxのOperation not permittedとsignal fixture起動失敗で、
Relay terminal-presence統合テストもローカル待受が `listen EPERM 127.0.0.1` となる。
ホストで設定済みの検証を再実行する必要がある。

統合・補強後の `cargo clippy --workspace --all-targets -- -D warnings` も通過した。
