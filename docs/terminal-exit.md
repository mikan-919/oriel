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
- Rust対象全体: 47件通過、13件失敗。12件はsandboxのOperation not permitted、
  1件はsignal fixtureの起動失敗。ホスト環境で再実行が必要。
- Relay/Webで `npm ci --offline --prefix <directory>` を試行したが、zod等の
  オフラインキャッシュ不足で失敗。Relay統合テストはws未導入で起動不能。
  ホスト環境で依存導入・Relayビルド後、terminal-presence.test.mjsを実行する。
