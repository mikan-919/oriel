# 本番配備の順序検証

ローカルでは `python3 -m unittest discover -s scripts -p test_deploy_order.py`
を実行する。一時Gitリポジトリをoriginとして実際の先端確認スクリプトを実行し、
配備はSHAとRelay/Webを記録するスタブに置き換える。一時origin内でコミットと参照を作成し、pushは実行しない。テストは待機順のFIFOを仮定しない。
ワークフローのジョブロック、配備条件、既定の成功条件と失敗時停止も検査する。
9件のテストには不正な配備SHAの拒否と、取得失敗時にtransportの診断情報をログへ出さない検証も含む。

## ホストでの検証

`actionlint .github/workflows/ci.yml` でYAMLとGitHub Actionsの条件式を検査する。
エージェント環境にはactionlintがなく、npmのオフラインキャッシュも不足していたため、
この構文検証と既存のnpmビルド・テストはホストで実施する。
指定基点 `740716fe0ac931e85349ec9ceae5cd1a9b22a618` の統合後も再検証済み。
両パッケージへの `npm ci --offline` は隔離キャッシュで試行したが、zodのキャッシュ不足で失敗した。
`bash -n scripts/check-deploy-head.sh`、ローカル順序テスト、
`cargo clippy --offline --workspace --all-targets` はエージェント環境で通過した。

## GitHubのconcurrency実動作（レビュー担当者）

本番には競合配備しない。秘密情報のない隔離リポジトリにワークフローと先端確認
スクリプトをコピーし、ビルド・依存導入・配備コマンドをログ出力と待機だけの
スタブに置き換える。Cloudflareのenvは削除する。ジョブ単位のconcurrencyと4つの
条件式、先端確認の位置は維持する。配備スタブは `github.sha` と対象名を記録する。
ローカルテストはGitHubサービスのロック実装を検証するものではないため、次を確認する。

1. Aを先端確認前で待機させ、Bをpushする。Aを再開するとAは正常スキップし、
   BのRelay→Webだけが記録されること。
2. AのRelayスタブを待機させてBをpushする。Bが待機し、AのWeb完了後に
   BのRelay→Webが記録されること。AのWebはmain更新でスキップされないこと。
3. B完了後にAを再実行する。Aの対象SHAとスキップ理由がログに残り、配備しないこと。
4. ビルド・既存テスト・先端取得・Relay配備をそれぞれ失敗させ、後続配備がないこと。

これらの外部実行はこの変更作業では行っていない。最新版の配備失敗時の自動再試行や、
paths対象外の更新に対する代替配備は追加していない。

## ホスト検証のキャッシュ修正

ホストの `npm --prefix crates/oriel-relay ci` は、ホーム側のキャッシュが
ディレクトリとして使えず `ENOTDIR` で失敗した。両パッケージの `.npmrc` に
`cache=${PWD}/.npm-cache` を設定し、実行ディレクトリ内の書き込み可能な
キャッシュを使う。`npm --prefix` での実行とパッケージ内での実行の双方に適用される。
キャッシュはGitの追跡対象外とし、lockfileや検証コマンドは変更していない。

修正後のキャッシュ設定は両パッケージで確認済み。順序テスト9件、シェル構文検査、
`cargo clippy --offline --workspace --all-targets` は通過した。
オフラインの依存導入は引き続きzodのキャッシュ不足で停止するため、依存導入と
ビルド・既存npmテストはホストで再検証する。
元の依存導入コマンドも再実行した。ネットワーク再試行・待機時間を制限した結果、
`ENOTDIR` は再発せず、registry.npmjs.orgの名前解決が `EAI_AGAIN` で失敗した。
