# HTTP期限とWHAT再確認の検証

2026-10-19。指定ベース d3f132f34bf6a67b4858eaad8a8b174540fd2c9a を統合。

- `npm test`（crates/oriel-web）: 全4テストファイル成功。
- `cargo clippy -p oriel-web --all-targets -- -D warnings`: 成功。
- `cargo run -p oriel-web`: 静的アセット生成成功。
- `node crates/oriel-web/test/review.mjs`: fixture生成成功。

制御タイマーでfetch待ち・本文待ち、signal無視、期限後の成功・拒否、
タイマー解放、アカウント変更後の成功・401・期限切れを検証。
共有端末取得の再試行、WHATの同一ID再確認、旧操作による新操作のbusy・通知への
干渉防止、端末消失時のWHAT対象保持も検証した。

通常の `npm ci --offline --prefix crates/oriel-web` はesbuildのインストール処理で
サンドボックスのEPERMとなった。`--ignore-scripts`を加えた導入は成功し、
上記テストとfixture生成を実行できた。

ブラウザーによる実画面確認は未実施。ホストでloading.htmlを開き、約1秒後に
30秒期限の案内とログイン操作の復帰を確認すること（fixtureのみ期限を短縮）。
WHATのrequest_idはページ内のみ保持し、再読込すると同一IDでの再確認・重複防止の
保証が失われる。サーバー側の処理取消しや自動再送は行わない。
