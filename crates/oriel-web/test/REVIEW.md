# レスポンシブ表示レビュー（2026-10-15）

## 再開時の検証

指定基点 `1bee6356b809410dd1101185a7caf3f72f492314` は再開時のHEADに統合済み。
保存されていた端末操作の追加検証と途中の画像・計測を先にコミットして保持した。
Web/Relayのnode_modulesは存在し、追加インストールは不要だった。
静的生成、8状態fixture生成、npm test（3ファイル）、Clippy、既存Codexブラウザー
テスト（320px）、長文16ケースを再実行し通過した。
Chromiumはサンドボックス内でshutdownのEPERMにより起動できず、
許可された制限外実行でローカルfixtureを検証した。

端末の閉じるボタンについて、各viewportで画面内の位置・中央へのクリック到達・
キーボードフォーカスのoutlineを追加検証する。マウスで端末を開いた後はTab入力で
キーボード操作へ切り替えてから`:focus-visible`を検証する。
計測JSONは全操作終了後に一時ファイルから置換するよう変更し、
途中終了で320画面のみの結果が完全な328ケースの記録を上書きすることを防ぐ。
再実行は328ケースで横はみ出し0・ページ例外0、端末8サイズの追加検証も通過した。
Enterで閉じた後のフォーカスは「端末を開く」に復帰した。
320px設定と844×390端末の保存画像を再確認した。

保存済み作業はクリーンなコミットとして残っており、指定されたソース基点
`73cd09dd0d0c2c7b0c6b73c7a0cf71b702077f55` は既に統合済みだった。
過去のapp-server停止理由・担当者による復旧結果は、この作業に提供された情報からは確認できない。
非公開transcriptや外部アカウントは参照せず、app-serverの再起動も行っていない。
今回の静的生成・ブラウザー検証は実行可能だった。

## 環境と再実行

Node v24.21.0、Cargo 1.98.0、vlmkit 0.23.0、Chromium 153.0.8010.12。
開始時にWeb/Relay双方のnode_modulesが存在し、追加インストールは不要だった。
Chromiumは `/tmp/oriel-playwright`、共有ライブラリの探索パスは
`/tmp/playwright-libpath` に用意されたローカル環境を使用した。
標準Playwrightブラウザー配置には実行ファイルがなく、サンドボックス内では
HTTP待受とChromium起動が拒否された。許可された制限外実行で検証した。
ブラウザーや依存はダウンロードしていない。

```sh
cargo run --offline -p oriel-web
node crates/oriel-web/test/review.mjs
# 修正前のソース・fixtureでbefore、修正後にfixtureを再生成してafterを実行
PLAYWRIGHT_BROWSERS_PATH=/tmp/oriel-playwright LD_LIBRARY_PATH="$(cat /tmp/playwright-libpath)" node crates/oriel-web/test/responsive-browser.mjs before
PLAYWRIGHT_BROWSERS_PATH=/tmp/oriel-playwright LD_LIBRARY_PATH="$(cat /tmp/playwright-libpath)" node crates/oriel-web/test/responsive-browser.mjs after
PLAYWRIGHT_BROWSERS_PATH=/tmp/oriel-playwright LD_LIBRARY_PATH="$(cat /tmp/playwright-libpath)" REVIEW_WIDTH=320 node crates/oriel-web/test/codex-browser.mjs
PLAYWRIGHT_BROWSERS_PATH=/tmp/oriel-playwright LD_LIBRARY_PATH="$(cat /tmp/playwright-libpath)" node crates/oriel-web/test/long-content-browser.mjs
npm test --prefix crates/oriel-web
cargo clippy --offline -p oriel-web --all-targets -- -D warnings
```

fixtureは本番の生成HTML・CSS・JavaScriptとローカルxtermを使う。
Playwrightのroute.fulfillで模擬HTTPSページを返すためHTTPサーバーは不要。
API/WebSocketは模擬応答、外部通信は遮断する。ファイルURLでは本番の端末HTTPS要件を
満たさないため、端末テストには模擬HTTPSを使用する。
画像取得はvlmkitのcaptureNlAssertImageを使用し、自動VLM採点は行わない。

## 対象表

| 状態 | 概要・ワークフロー・Codex・端末一覧・設定 | 端末表示 |
| --- | --- | --- |
| signed-out / pairing / normal / empty / loading / failed / reconnecting / codex | 各8 viewport、計320ケース | normalのみ8ケース |

viewportは320・360・390・768・900・901・1440 × 高さ800、および844×390。
非表示画面も切り替えて測定し、detailsは展開する。
未ログイン等では画面を切り替えても認証案内や読み込み状態が維持される。
端末表示は接続可能なnormalで代表検証する。signed-out、pairing、empty、loading、failedは
接続対象なし。reconnectingは進捗未確認、codexはCodex操作専用fixtureなので端末の重複検証を省略。
長い端末名・リポジトリ名・選択肢・WHAT/HOW本文・Codex回答・差分を含む。

## 実測と画像

[evidence/before](evidence/before/) と [evidence/after](evidence/after/) に
vlmkit画像とresults.jsonを保存する。画像は320pxの全5画面（normal/codex）、
normal概要の全viewport、端末320×800と844×390を収録する。
全ケースのDOM計測はresults.jsonに残し、画像は代表ケースを保存する。

修正前は328ケース中88ケースで横はみ出しを再現した。
原因はgithub-target、linear-target、workflow-device、codex-deviceのselectが
長いoptionの固有幅を保っていたこと。例として320pxの設定でscrollWidthが2075pxだった。
selectにmin-width:0とmax-width:100%を指定し、親領域に収める。
端末の長いタイトルは折り返し、閉じるボタンの幅を保つツールバーとした。
ページ全体のoverflowを隠す変更は行っていない。

修正後は328ケースすべてでscrollWidth <= clientWidth + 1、ページ例外0件。
端末8サイズすべてでxtermの右端・下端がviewport内に収まった。
端末終了後のフォーカスは「端末を開く」に戻り、320pxでのフォーム作成も通過した。
修正前後の320px設定、ワークフロー、Codexと横向き端末の代表画像を目視し、
選択肢の横はみ出し解消と主要操作の配置を確認した。
画像のレビューは代表画像であり、全328ケース個別の目視は行っていない。
長いWHAT/HOW本文とCodex回答はlong-content-browser.mjsで別途展開し、
8 viewport × 2画面の16ケースすべてで横はみ出しがないことを確認した。
計測はevidence/after/long-content.json、320pxの画像はlong-plan-320.pngと
long-answer-320.pngに保存する。既定状態マトリクスとは別の追加検証である。

npm testは3ファイル通過、Clippy（全ターゲット・警告エラー化）通過、
既存Codexブラウザーテストは320×800で通過。Rust静的生成と8状態生成も成功した。

## 操作と制約

端末は幅・高さを順次変更してfitを測定し、Enterで閉じた後に元の「端末を開く」へ
フォーカスが戻ることを確認する。幅320pxでナビゲーションのEnter操作、WHATフォームの
入力・Tab移動・作成も検証する。既存Codexブラウザーテストは幅320pxで質問回答、承認、
送信、中断、会話切替、モデル選択等を確認する。
実端末、ソフトウェアキーボード、Safari固有挙動、実アカウント認証は対象外。

---

# オフライン画面レビュー

## 2026-10-14の実装・配備確認

作業一覧・検索・状態の絞り込み・詳細・WHAT作成を、既存の取得APIに接続した。端末の検証結果とGitHub CIを分け、対象コミットと一致する結果だけを表示する。実行履歴は、この画面で受信した進捗通知を表示する。作業一覧はIssue番号の降順とし、検索・絞り込み・新規作成後も新しい作業を上に表示する。

生成する本番ファイルは `build/public/` の5ファイルに限定し、`build/review/` の試験用画面は配備しない。Relayの88件の検証、Webの検証、Rustの検証、Clippy、型検査、Cloudflareのビルド・配備前確認が通過した。ブラウザーで画面の表示・記載・スクロール・操作・画面幅を確認し、問題の判定は0件だった。作業一覧の順番、検索、詳細切替、新規作成を含む16段階の操作確認も通過した。

Relayは `4de0cad4-7845-43ec-a63f-1b8dd0ce82a4`、Webは `b76e8980-7bfb-4c25-84b4-d690ad2aced6` を `cf deploy --prebuilt` で配備した。本番の配信ファイルは生成結果と一致し、匿名セッションの200、未認証取得の401、内部経路と試験用画面の404を確認した。端末の検証結果の表示は、更新した `target/release/orield` の次回起動から有効になる。本番で認証した端末との操作や24時間運転は未検証である。

## 以前の検証記録

Rust・topcoatの静的生成を維持した自作の表示部品と共通CSSを使用しています。Reactやshadcn/uiの依存は追加していません。

リポジトリのルートで以下を実行すると、実際の生成HTML・CSS・JavaScriptを使った8状態のfixtureを作成します。外部リンクとAPI通信はfixture内で置き換え、外部アカウントを使いません。

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
- `codex.html`: Codex接続済み、質問・承認待ち

各幅で横スクロール、操作の欠落、Tab・Enter操作とフォーカスを確認してください。WHAT/HOW本文は詳細を展開して表示します。端末接続とrunner接続は別々に示します。

fixtureではPasskeyや実端末のWebSocket接続は行いません。実端末の表示切替・サイズ調整・終了後の復帰は別途実環境で確認してください。

検証では `npm test` と `cargo clippy --offline -p oriel-web --all-targets -- -D warnings` が通過しました。端末取得失敗時の設定への案内、runner一時停止・未知状態の表示、端末終了時のフォーカス復帰も回帰テストで確認しています。外部サービスの認可から戻った場合は設定画面を開き、日本語の案内に沿って連携先を保存できます。認可成功・失敗時の画面切替も回帰テストで確認しています。

この実装環境では利用可能なブラウザー実行ファイルがなく、画面幅の実測・画像生成は未実施です。`npm ci --offline` はキャッシュ内に `zod-4.4.3.tgz` がなく失敗しました。`npm run build` のRust生成は成功しましたが、その後の `cf build` は `cf: command not found` で失敗しました。上記fixtureを使った画像レビューとCloudflareビルドは、依存とブラウザーのある環境で確認してください。

今回の再検証では、初回セッション取得中の概要を「確認中」に揃え、未ログインと断定しないよう修正しました。読み込み完了後の案内への復帰を回帰テストで確認しました。`npm test`、JavaScript構文チェック、Clippy（警告をエラーとして扱う）は通過しました。Rustのリリース生成と8状態のfixture再生成も成功しています。オフライン依存インストールは引き続きzodのキャッシュ不足、Cloudflareビルドはcf未インストールで未完了です。
