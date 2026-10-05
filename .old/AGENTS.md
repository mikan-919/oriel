# AGENTS.md — BFV Kernel

`AC` = Acceptance Criterion.

## Contract

Before work define:

`Contract = Outcome + minimum ACs sufficient to prove it + Interpretation`

The Contract is required minimum and scope maximum. Resolve ambiguity; otherwise use the narrowest interpretation consistent with request/context/inputs/environment.

## Claims

`Claim` = proposed work, finding, or verification.

**Deletion Test:** reject a Claim if the Contract remains provable without it; otherwise retain only its minimum form:

`Claim / Broken Criterion / Failure / Evidence / Minimum Form`

A Claim is necessary only if it observably affects an AC under current inputs/environment.

## Run

A Round is:

`enumerate Claims → deletion-test → execute admitted minimum forms → verify every AC → collect new Claims`

For each AC record:

`Criterion / Evidence / Reproduction / Environment / Status: PROVEN | UNPROVEN`

Use only necessary evidence.

Reject a Claim first raised in Round `n+1` if observable in Round `n`, unless new evidence changed its necessity.

Fixed Point:

`all ACs PROVEN AND no remaining Claim passes Deletion Test`

Stop immediately at Fixed Point. Otherwise repeat for at most 3 Rounds; this is the sole unsourced numeric limit. If still unresolved, stop with unresolved Claims: `FUSE_STOPPED ≠ COMPLETED`.

Other numeric limits require a requester, target-specification, project-policy, or Contract-required measurement source; record `Limit / Source / Required For`.

## Report

Output only:

```text
Outcome:
Proof:
Rejected Claims:  # requester-relevant only
Open Items:       # only after Fuse stop
Status: COMPLETED | FUSE_STOPPED
```

No diary, internal reasoning, exhaustive rejected Claims, or unrelated findings.


# AGENTS.md
このリポジトリで作業するエージェント向けの指示。

## ドキュメント構成

4つのworkspace documentがあり、それぞれ一つの役割だけを持つ（CONCEPT.md原則3: 情報源を複製しない）。新しい情報をどこかに書く前に、必ずこの表で置き場所を決めること。

| ドキュメント | 役割 | 更新頻度 |
|---|---|---|
| **CONCEPT.md** | なぜハーネスが存在するか、何を絶対に譲らないか（不変の原則） | 稀。ここが変わる＝ハーネスの存在意義が変わったということ |
| **ROADMAP.md** | 今どこに向かっているか。アーキテクチャ方向性、優先順位、未解決の論点 | 頻繁に変わってよい |
| **FEATURE.md** | 今何を対象にして・何を対象にしないか（スコープの境界） | 実装が進むたびに更新 |
| **HANDOFF.md** | 直近セッションの申し送りのみ | 毎セッション |

## 用語と識別情報

文書ではコードネームを繰り返さず、「実行ハーネス」「サーバ」「CLI」「提案ラベル」などの役割語を使う。実装はリセットされており、実行時識別子はまだ定義しない。実装開始時にコードネーム、User-Agent、状態ディレクトリ、環境変数接頭辞、Issueラベル、およびworkspace documentのファイル一覧について、コードから参照できる単一の正本を設ける。識別情報を文書や複数のmoduleへ複製しないこと。

判定に迷ったら：「なぜ」の話ならCONCEPT、「今どうするか／何をするしないか」の話ならROADMAPかFEATURE、「次のセッションは何から再開するか」の話ならHANDOFF。

### FEATURE.mdへの記載ルール（重要）

FEATURE.mdに**実装済み/未実装のようなステータスを書かない**。それはPR・commit履歴が既に持っている情報であり、複製すると原則3違反になる。「今どこまで進んでいるか」はGitHub上のPR/commitを見ればわかる。FEATURE.mdに書くのは「スコープに含むもの」（対象とする機能そのものの列挙）と「やらないこと」（意図的な非スコープの決定——これはgit履歴からは読み取れない、記録しないと失われる情報）のみ。

### 原則の追加・変更はユーザーの承認を経ること

CONCEPT.mdの「不変の原則」を追加・削除・変更する場合、あるいはドキュメント間で矛盾する記述（例: 過去に保留にした原則が復活可能かどうか）を見つけた場合は、エージェントが単独で判断せず、grill-meスキル等でユーザーに確認してから反映する。これはハーネス自体の「Agentは提案するが、承認は人間が行う」という設計思想（CONCEPT.md原則2）をドキュメント作業自体にも適用したもの。

## HANDOFF.mdの蒸留フロー

HANDOFF.mdは無限に追記されるログにしない。セッション終了時、あるいはHANDOFF.mdが肥大化してきたと感じたタイミングで、以下を行う。

1. HANDOFF.mdに書かれている内容のうち、**確定した設計・思想**をCONCEPT.md / ROADMAP.md / FEATURE.mdへ振り分ける（振り分け基準は上の表を参照）。
2. **実装セッションの経緯・作業ログ**（何を試した、テストが何件通った等）は移さず削除する。再現性が必要ならgit commit履歴を参照する（CONCEPT.md原則1: 状態は外部に置く）。
3. HANDOFF.mdは**直近セッションの「次への申し送り」だけ**を残した薄いファイルに書き直す。過去セッションの見出しごと積み上げない。

## 作業の始め方

新しいセッションは、まずCONCEPT.md → ROADMAP.md → FEATURE.md → HANDOFF.mdの順に目を通し、HANDOFF.mdの「次のセッションへの申し送り」から再開する。
