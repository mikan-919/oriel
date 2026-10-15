# Oriel

Orielは、ローカルで動くCodexをブラウザーから操作し、GitHub IssueとLinearを使って開発作業を進めるためのツールです。

## 構成

| パッケージ | 役割 |
| --- | --- |
| [`orield`](crates/orield) | 利用端末で動くデーモン。Codexの実行、端末の接続、作業の進行を担当する |
| [`oriel-web`](crates/oriel-web) | ブラウザーの操作画面 |
| [`oriel-relay`](crates/oriel-relay) | 端末とブラウザーの通信、認証、GitHub・Linear連携を担当する中継サービス |

## 利用する

[orieldの導入・使い方](crates/orield/README.md)を参照してください。Codexと稼働中のWeb・Relayが必要です。`orield`のインストールには、Web・Relayの配備は含まれません。

`orield workflow`は、GitHub Issueの要求（WHAT）からLinearに実装計画（HOW）を作ります。計画の作成は読み取り専用です。コードの変更には、人によるLinear Todoでの承認と、対象リポジトリの`.oriel.yaml`による実行許可が必要です。

## 開発する

Rust stableとNode.jsを使用します。Nixを使う場合は、`nix develop`で開発環境に入れます。

リポジトリのルートで実行します。

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
npm --prefix crates/oriel-relay ci
npm --prefix crates/oriel-relay run build
npm --prefix crates/oriel-relay test
npm --prefix crates/oriel-web ci
npm --prefix crates/oriel-web run build
npm --prefix crates/oriel-web test
```

このリポジトリで自動実装に使う検証コマンドは[.oriel.yaml](.oriel.yaml)にあります。

## 公開と配備

- `orield`：[crates.ioへの公開手順](docs/orield-release.md)。mainの対象変更を検証し、未公開のバージョンを公開します。更新の公開にはバージョンを上げる必要があります。
- Web・Relay：[GitHub Actions](.github/workflows/ci.yml)で、mainの対象変更をCloudflareへ配備します。
- [Cloudflareの使用量と費用](CLOUDFLARE_COST.md)

## ライセンス

[MIT](crates/orield/LICENSE)
