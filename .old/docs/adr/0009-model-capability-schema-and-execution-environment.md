# ADR 0009: model capability schemaと実行環境選択

- 状態: Accepted
- 日付: 2026-08-19

## 背景

ROADMAP.mdの「設計を固める順序」6番目は「capability schemaと実行環境選択を定義する」だが、これまでどのADRにも詳細が書かれていなかった。ADR 0001は「repositoryは自動検査可能なmodel capabilityを要求できるが、provider固有のmodel IDを選ばない」と述べるだけで、具体的なfield形状、配置場所、適用範囲、不一致時の挙動は未定義だった。

実行環境選択については、ROADMAP.mdの「実行環境」節が既にv1の実行backendを`WorktreeBackend`だけと決定し、`packages/contracts/src/execution-config.ts`の`executionConfigSchema`として実装済みである。このADRはその既存決定を追加変更せず、capability schemaの設計だけを行う。

## 決定

### 実行環境選択

追加の設計判断はない。v1の実行backendは`WorktreeBackend`のみとする既存決定（ROADMAP.md「実行環境」節、`executionConfigSchema`の`execution.backend: v.literal("worktree")`）をそのまま正本とする。新しいbackendを追加する時点で、その時のADRとして拡張点を決める。

### capability schemaの対象種別

`@earendil-works/pi-ai`の`Model<TApi>`型が持つ、自動検査可能な4つのフィールドに対応する要求だけをv1の対象にする。

- `reasoning`: `Model.reasoning`（推論/thinkingトークン対応）が`true`であることの要求
- `image`: `Model.input`が`"image"`を含むことの要求
- `minContextWindow`: `Model.contextWindow`の下限
- `minMaxTokens`: `Model.maxTokens`の下限

provider固有のmodel IDやprovider名を直接指定するfieldは持たない（ADR 0001の「provider固有のmodel IDを選ばない」を維持する）。

### 配置

`.oriel.yaml`に新規top-level `modelCapabilities`を追加する。既存の`schemaVersion`・`execution`と並列に置き、同じ`schemaVersion: 1`を共有する。`execution`は実行backendの選択と検証commandだけに責務を限定し、model要求とは分離する。

`modelCapabilities`は省略可能とする。省略時はmodelに関する制約を課さない。`execution`と異なり「実行を許可するかどうか」のgateではなく、任意で追加できる制約であるため、既存の`execution`のような必須strict fieldにはしない。

`packages/contracts/src/execution-config.ts`のschema形状:

```ts
export const orielConfigSchema = v.strictObject({
  schemaVersion: v.literal(1),
  execution: v.strictObject({
    backend: v.literal("worktree"),
    autonomous: v.literal(true),
    verification: v.pipe(
      v.array(v.pipe(v.array(nonEmptyString), v.minLength(1))),
      v.minLength(1),
    ),
  }),
  modelCapabilities: v.optional(
    v.strictObject({
      reasoning: v.optional(v.literal(true)),
      image: v.optional(v.literal(true)),
      minContextWindow: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1)),
      ),
      minMaxTokens: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1)),
      ),
    }),
  ),
});
```

`reasoning`・`image`は「要求する」ことだけを表現できればよいため、`v.optional(v.literal(true))`とし、`false`を明示する形は持たない（`autonomous: true`と同じ慣習）。既存の`executionConfigSchema`という名前は`execution`だけを指すschemaとして残すか、`orielConfigSchema`のような全体schema名へ改名するかは実装時の詳細とし、このADRでは固定しない。

### 粒度

Job種別（`what_confirmation`/`how_confirmation`/`pr_response`/`implementation`）ごとに分けず、`modelCapabilities`は1つの制約セットとして全種別に共通適用する。model既定値解決自体はissue #48で決めたinstance/per-kind/Job overrideの3層fallbackのままであり、capability要求はその結果選ばれたmodelが満たすべきgateとして別層で働く。種別ごとに異なるcapability要求が必要になった実例が出てから、per-kind化を別途検討する。

### 適用範囲

`.oriel.yaml`が存在し、かつmodelを使うJob種別（`what_confirmation`・`how_confirmation`・`pr_response`・implementation`）すべてに適用する。`issue_conversation`は人間が書いた返答本文をそのまま中継するだけでmodelを使わないため、ROADMAP.mdの既存除外方針のとおり対象外のままとする。`.oriel.yaml`が存在しないrepositoryでは、ADR 0001のとおり実装Job・PR対応Jobはそもそも起動できず、対話Jobにはcapability制約がかからない。

### 不一致時の挙動

`serve`が該当Jobを開始する前に、model既定値解決チェーンで解決済みのmodelのメタデータ（`Models.getModel()`が返す`reasoning`・`input`・`contextWindow`・`maxTokens`）と`modelCapabilities`を照合する。いずれか一つでも満たさなければ、そのJobの作成を拒否し、harnessを起動しない。

これはROADMAP.md「Agentとモデル提供元」節の「モデルを利用できない場合は、別のモデルへ暗黙に切り替えず実行を止める」という既存方針をそのまま適用したものであり、新しい例外を設けない。

## 帰結

- `modelCapabilities`は`.oriel.yaml`という単一の正本にとどまり、servの設定（model既定値解決チェーン）とは責務が分離される。servはmodel選択の正本、repositoryはmodel要求の正本という役割分担を維持する。
- 省略可能なため、既存の`.oriel.yaml`（本repositoryの`.oriel.yaml`を含む）は変更なしで動作し続ける。
- fail closedかつ暗黙fallbackなしのため、capability不一致は必ず人間が気づける形（Job作成拒否）で止まる。

## 対象外

- Job種別ごとのcapability要求の分離（per-kind化）。実例が出てから検討する。
- provider固有のmodel ID・provider名の直接指定。
- 新しい実行backend（Docker、Podman、Nix、Dev Container等）の追加。v1では`WorktreeBackend`のみ。
- capability不一致時に自動で別modelへ切り替える、または警告のみで継続する挙動。
