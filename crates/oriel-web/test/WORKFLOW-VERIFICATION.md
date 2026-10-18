# 検証表示の確認（2026-10-18）

工程は作業phaseと有効な実行通知から表示する。レビュー到達は検証成功の根拠にしない。
端末検証には実行・作業・対象/基準コミット・設定内容と識別子・受信時刻を表示し、
CIは取得成功の検査0件と未取得を区別する。0件の理由は推測しない。
承認条件、実行コマンド、CI起動条件は変更していない。

画面内の端末証拠は最大64作業分で、ユーザー・端末・リポジトリ・接続設定世代で分離する。
次の実行や通知切断で確定済み結果を消さず、実行中の古い通知は未確認として表示する。
コマンド別の表示には報告に付属する設定を使う。旧形式は証拠不足と表示する。
永続履歴や再取得経路は追加しておらず、再読み込み後はその制限を表示する。

実行した確認:

- Web: オフライン依存導入後の `npm --prefix crates/oriel-web test`、`npm --prefix crates/oriel-web run build` が成功。
  分離なしのNodeテスト実行でも22テストが成功。
- `cargo test --workspace` は通常sandboxではローカル待受が拒否された。
  ローカル実行制限を解除した再実行は成功。
- `cargo clippy --workspace --all-targets -- -D warnings` は成功。
- 本番HTML/CSSとworkflow.jsを使う `workflow-browser.mjs` がChromiumで成功。
  レビュー・CI0件/実行中/失敗、push前の完了件数、切断・再接続、
  次の作業、成功/失敗の保持、設定変更、ユーザー/端末/リポジトリ/世代変更、
  画面を作り直した際の取得不能説明を確認した。外部リクエストは遮断。
- Relay: esbuildでTypeScript全体のバンドルが成功（未生成のRustモジュールはexternal）。
  通常のオフラインnpm ciはesbuildインストール処理のEPERMで失敗したため、
  `npm ci --offline --ignore-scripts` で依存を導入した。
  `npm --prefix crates/oriel-relay run build` はworker-buildのキャッシュ書込制限、
  隔離した書込先での再試行はローカルにWasm Bindgen 0.2.129がないため失敗。
  `npm --prefix crates/oriel-relay test` も生成済みworker設定がなく統合テストが失敗した。
  Relayの回帰テストは追加済みだが、この環境での通過は確認できていない。

ホストでRelayのビルドとnpm testを実施する必要がある。ブラウザー検証の再実行:

```sh
npm --prefix crates/oriel-web run build
PLAYWRIGHT_BROWSERS_PATH=/tmp/oriel-playwright node crates/oriel-web/test/workflow-browser.mjs
```

ブラウザーの配置先はホスト環境に合わせる。対象基点
`82101303fadf49aeb5272d55fc8627494f1f8891` は開始時HEADで、現在の履歴に統合済み。
