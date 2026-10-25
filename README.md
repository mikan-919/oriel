<h1 align="center">Oriel</h1>

<p align="center">ローカルの Codex をブラウザーから操作し、GitHub Issue と Linear で開発を進めるツール</p>

## 構成

| パッケージ | 役割 |
| --- | --- |
| [`orield`](crates/orield) | 利用端末で動くデーモン。Codexの実行、端末の接続、作業の進行を担当する |
| [`oriel-web`](crates/oriel-web) | ブラウザーの操作画面 |
| [`oriel-relay`](crates/oriel-relay) | 端末とブラウザーの通信、認証、GitHub・Linear連携を担当する中継サービス |

## 利用する

[最初の作業を完了する](docs/getting-started.md)に、端末登録、GitHub・Linearの接続、実行設定、WHATから完了までの手順をまとめています。

[orieldの導入・使い方](crates/orield/README.md)を参照してください。Codexと稼働中のWeb・Relayが必要です。`orield`のインストールには、Web・Relayの配備は含まれません。

`orield workflow`は、GitHub Issueの要求（WHAT）からLinearに実装計画（HOW）を作ります。計画の作成は読み取り専用です。コードの変更には、人によるLinear Todoでの承認と、対象リポジトリの`.oriel.yaml`による実行許可が必要です。

## 開発する

Rust stableとNode.jsを使用します。Nixを使う場合は、`nix develop`で開発環境に入れます。

リポジトリのルートで実行します。

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
npm --prefix crates/oriel-relay ci
npm --prefix crates/oriel-relay run typecheck
npm --prefix crates/oriel-relay run build
npm --prefix crates/oriel-relay test
npm --prefix crates/oriel-web ci
npm --prefix crates/oriel-web run typecheck
npm --prefix crates/oriel-web run build
npm --prefix crates/oriel-web test
```

このリポジトリで自動実装に使う検証コマンドは[.oriel.yaml](.oriel.yaml)にあります。
`typecheck`はWorker（Cloudflareで動く処理）のTypeScriptを検査します。実行環境の型を開発依存に含めており、`npm ci`後はビルド・配備・外部認証なしで実行できます。Rustから生成するRelayの入口だけは、`src/wasm.d.ts`で境界の型を定義しています。

## 公開と配備

- `orield`：[crates.ioへの公開手順](docs/orield-release.md)。mainの対象変更を検証し、未公開のバージョンを公開します。更新の公開にはバージョンを上げる必要があります。
- Web・Relay：[GitHub Actions](.github/workflows/ci.yml)で、mainの対象変更をCloudflareへ配備します。
- [Cloudflareの使用量と費用](CLOUDFLARE_COST.md)

## ライセンス

[MIT](crates/orield/LICENSE)
