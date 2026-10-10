# オフライン画面レビュー

Rust・topcoatの静的生成を維持した自作の表示部品と共通CSSを使用しています。Reactやshadcn/uiの依存は追加していません。

リポジトリのルートで以下を実行すると、実際の生成HTML・CSS・JavaScriptを使った7状態のfixtureを作成します。外部リンクとAPI通信はfixture内で置き換え、外部アカウントを使いません。

```sh
cargo run --offline -p oriel-web
node crates/oriel-web/test/review.mjs
```

`crates/oriel-web/build/review/` 内のHTMLをブラウザーで開き、360px・768px・1440pxで確認してください。

- `signed-out.html`: 未ログイン、Passkey導線
- `pairing.html`: 端末承認待ち
- `normal.html`: 端末online・runner実行中、概要と4領域の切替
- `empty.html`: ログイン済み・端末未登録
- `loading.html`: セッション取得待ち
- `failed.html`: 状態取得失敗
- `reconnecting.html`: 端末online・runner情報未確認

各幅で横スクロール、操作の欠落、Tab・Enter操作とフォーカスを確認してください。WHAT/HOW本文は詳細を展開して表示します。端末接続とrunner接続は別々に示します。

fixtureではPasskeyや実端末のWebSocket接続は行いません。実端末の表示切替・サイズ調整・終了後の復帰は別途実環境で確認してください。

検証では `npm test` と `cargo clippy --offline -p oriel-web --all-targets -- -D warnings` が通過しました。端末取得失敗時の設定への案内、runner一時停止・未知状態の表示、端末終了時のフォーカス復帰も回帰テストで確認しています。外部サービスの認可から戻った場合は設定画面を開き、日本語の案内に沿って連携先を保存できます。認可成功・失敗時の画面切替も回帰テストで確認しています。

この実装環境では利用可能なブラウザー実行ファイルがなく、画面幅の実測・画像生成は未実施です。`npm ci --offline` はキャッシュ内に `zod-4.4.3.tgz` がなく失敗しました。`npm run build` のRust生成は成功しましたが、その後の `cf build` は `cf: command not found` で失敗しました。上記fixtureを使った画像レビューとCloudflareビルドは、依存とブラウザーのある環境で確認してください。

今回の再検証では、初回セッション取得中の概要を「確認中」に揃え、未ログインと断定しないよう修正しました。読み込み完了後の案内への復帰を回帰テストで確認しました。`npm test`、JavaScript構文チェック、Clippy（警告をエラーとして扱う）は通過しました。Rustのリリース生成と7状態のfixture再生成も成功しています。オフライン依存インストールは引き続きzodのキャッシュ不足、Cloudflareビルドはcf未インストールで未完了です。
