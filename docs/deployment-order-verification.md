# 本番配備の順序検証

ローカルでは `python3 -m unittest discover -s scripts -p test_deploy_order.py`
を実行する。一時Gitリポジトリをoriginとして実際の先端確認スクリプトを実行し、
配備はSHAとRelay/Webを記録するスタブに置き換える。テストは待機順のFIFOを仮定しない。
ワークフローのジョブロック、配備条件、既定の成功条件と失敗時停止も検査する。

## ホストでの検証

`actionlint .github/workflows/ci.yml` でYAMLとGitHub Actionsの条件式を検査する。
エージェント環境にはactionlintがなく、npmのオフラインキャッシュも不足していたため、
この構文検証と既存のnpmビルド・テストはホストで実施する。
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
