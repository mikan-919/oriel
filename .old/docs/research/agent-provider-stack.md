# Agent / model provider 基盤の比較調査

調査日: 2026-08-12

## 結論

v1は **`@earendil-works/pi-agent-core` をharnessのAgent loop、`@earendil-works/pi-ai` をローカル`serve`のprovider adapterとして使う構成**が最も現在の境界に合う。

- `pi-agent-core`はtool実行とAgent lifecycleの詳細なeventを持ち、任意の`streamFn`と公式の`streamProxy`を受け取れる。このtransport境界を`serve` IPCへ対応させれば、Agent loopをharnessに置いたままmodel credentialを`serve`だけに保持できる。
- `pi-ai`はprovider native APIを個別に実装し、text、thinking、tool-call argument delta、usage、stopを共通eventへ変換する。Ollama、vLLM、LM Studio等にはOpenAI-compatible APIを介して接続できるが、すべてが専用の公式providerとして組み込まれているわけではない。
- LiteLLMは強力なprovider gatewayだがAgent loopではない。採用するとPython proxy processと、原則OpenAI形式への追加変換層が増える。v1の受け入れ基準に中央集約されたrate limit、予算、fallback、仮想keyがまだない限り、この追加層は不要である。
- Vercel AI SDKはTypeScriptのAgent/provider基盤として有力だが、`serve`とharnessをcredential境界で分ける公式の専用transportは確認できなかった。採用するなら独自providerまたはローカルgateway protocolを設計する必要があり、現時点ではpiより余分な実装になる。

ただし、piとVercel AI SDKの公開packageはいずれも現在`engines.node`を宣言している。TypeScript/ESMであることとBun上での正式な互換性保証は同義ではないため、採用確定前に選んだpackage/versionをBunで実行する小さな互換性spikeが必要だった。pi-agent-core/pi-aiについてはこのspikeを実施済みで、結果は下記「Bun互換gateの結果」に記録する。

## 前提となる設計境界

- 全体はTypeScript。
- ローカル`serve`とharnessはBunで動く別process。
- 公開relayはCloudflare Workers + Durable Objects。
- model provider credentialは`serve`だけが保持し、harnessおよびsandboxへ渡さない。
- transcript生成に十分なmodel stream、tool call、tool execution、Agent lifecycle eventが必要。
- local modelおよびOpenAI-compatible endpointを将来選べること。

## 比較

| 候補 | 主な役割 | Bun / TypeScript | credential隔離 | event fidelity | local / OpenAI-compatible | 追加runtime / process | ライセンス |
|---|---|---|---|---|---|---|---|
| pi-agent-core + pi-ai | Agent loop + provider adapter | TypeScript ESM。ただし両packageの公式宣言はNode `>=22.19.0` | **適合しやすい**。harnessの`streamFn`を`serve`へのproxyにし、provider authを`serve`側で解決できる | **高い**。Agent start/end、turn、message delta、tool execution start/update/endと、provider側のtext/thinking/tool argument deltaを持つ | OpenAI-compatible endpointへ接続可能。専用providerの有無は接続先ごとに異なる | 既存2 process内に配置可能 | MIT |
| LiteLLM Proxy | provider gateway | Python `>=3.10,<3.15`。TS/Bun libraryではない | **適合可能**。proxyがprovider credentialを保持し、harnessにはvirtual key等だけを渡せる。ただし`serve`とは別の秘密保持processになる | OpenAI形式へ正規化したstream/tool callsを提供。Agent lifecycle/tool execution eventは持たない。native/pass-through APIを選ぶとclient protocolが分岐する | Ollama等を含む多数providerを統一 | Python proxy（またはcontainer）が1つ増える。virtual key管理を使う構成ではDBも必要 | coreはMIT、`enterprise/`は別license |
| Vercel AI SDK | Agent loop + provider abstraction | TypeScript ESM。docsはBunでのinstall例を示すが、packageの公式宣言はNode `>=22` | **実装すれば適合**。providerを`serve`に置くか、custom provider/fetchで`serve`を呼ぶ必要がある。専用のprocess境界は標準化されていない | **高い**。`fullStream`にtext、reasoning、tool call/result、errorがあり、raw chunkとprovider metadataも選択可能 | `@ai-sdk/openai-compatible`、LM Studio等に対応 | library自体は追加process不要。隔離adapterは自作 | Apache-2.0 |

## 候補別の詳細

### pi-agent-core + pi-ai

`pi-agent-core`は「stateful agent with tool execution and event streaming」で、Agentへ必須の`streamFn`を注入する。公式READMEにはbackend proxyへ接続する`streamProxy`も示されている。このため、harness側はprovider credentialを知らず、`serve`側の認証済みmodel streamだけを利用する形を自然に作れる。[pi-agent-core README: quick start / event flow / proxy usage](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)

Agent eventは`agent_start/end`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end`を含む。provider streamは`text_*`、`thinking_*`、`toolcall_*`、`done`、`error`を含み、tool argumentのpartial JSONも公開する。transcriptとWeb UIに必要な観測点が、Agent loopとproviderの両層にある。[pi-ai complete event reference](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#complete-event-reference)

`pi-ai`はOpenAI、Anthropic、Google等のnative APIに加え、OpenAI-compatible APIと互換endpoint差分のflagsを持つ。この経路でOllama、vLLM、LM Studio等へ接続できる。ただしLM Studio専用の公式providerは2026-08-12時点のmainにはない。[pi-ai supported providers and compatibility settings](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#supported-providers)

LM Studioをfirst-class providerにする提案はmaintainerからPR提出を承認され、`packages/ai/src/providers/lm-studio.ts`を追加するPRがopenである。提案はnative `/api/v1/models`によるmodel discoveryとOpenAI-compatible `/v1/responses`を組み合わせる。ただし未mergeのため、採用を前提にはしない。[LM Studio provider proposal](https://github.com/earendil-works/pi/issues/7668) / [LM Studio provider PR](https://github.com/earendil-works/pi/pull/7762)

llama.cpp routerはfirst-class対応がmainへ入っている。一方、local OllamaとvLLMについて同等の公式providerは今回確認できなかった。[llama.cpp support](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/llama-cpp.md) / [official local provider discussion](https://github.com/earendil-works/pi/issues/3357)

注意点はruntime宣言である。現在の`pi-agent-core`と`pi-ai`はTypeScript ESMだが、package metadataの`engines`はNode `>=22.19.0`であり、Bunを公式runtimeとして列挙していない。一方、`pi-ai`にはBun用OAuth exportが存在する。これはBunを意識した実装の証拠にはなるが、package全体の互換性保証ではない。[pi-agent-core package.json](https://github.com/earendil-works/pi/blob/main/packages/agent/package.json) / [pi-ai package.json](https://github.com/earendil-works/pi/blob/main/packages/ai/package.json)

### LiteLLM

LiteLLMの二つの製品面はPython SDKとProxy Server（LLM gateway）である。Proxyは認証・認可、virtual key、rate limit、cost tracking、複数deploymentのretry/fallback等を提供するが、toolを反復実行するAgent loopではない。[LiteLLM getting started](https://docs.litellm.ai/)

Proxyはprovider keyを保持できるためcredential隔離には使える。しかしOrielでは既に信頼された`serve`がcredentialを保持するため、LiteLLMを別processにするとcredential責務が二箇所に割れるか、`serve`の内側にもう一つ信頼processを設けることになる。これはgateway固有機能が必要になった時には合理的だが、provider統一だけのためには重い。

virtual keyを使う標準構成はmaster keyとdatabase URLを設定し、keyをDBで管理する。したがって「harnessへprovider keyを渡さない」ためだけに導入すると、既存の`serve` credential境界にDB付きkey管理を重ねることになる。[LiteLLM virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys)

標準completion pathのstreaming responseはOpenAI形式へ統一される。text/tool-call streamの共通化には有効だが、provider native eventをそのまま保持する設計ではない。LiteLLMにはnative/pass-through系endpointもあるためfidelityを優先する逃げ道はあるが、その場合は共通protocolという利点が弱まり、harness向けAgent lifecycle eventは別途必要なままである。[LiteLLM streaming response format](https://docs.litellm.ai/)

公式metadataはPython `>=3.10,<3.15`とproxy用FastAPI/Uvicorn等の依存を宣言しているため、Bun-only runtimeにはならない。[LiteLLM pyproject.toml](https://github.com/BerriAI/litellm/blob/main/pyproject.toml) coreはMITだが、repositoryの`enterprise/`配下は別licenseである。[LiteLLM LICENSE](https://github.com/BerriAI/litellm/blob/main/LICENSE)

LiteLLMを再評価する条件は、複数利用者・複数`serve`を横断した予算、rate limit、provider fallback、virtual key、共通observabilityがv1の必須条件になった場合である。その時もAgent loopの代替ではなく、`serve`配下のprovider gatewayとして評価する。

### Vercel AI SDK

Vercel AI SDKはprovider abstractionだけでなく、toolを複数stepで実行する`ToolLoopAgent`を持つ。`streamText().fullStream`はtext、reasoning、tool call、tool result、errorを公開し、未正規化のprovider chunkを含めるoptionとprovider metadataもあるため、event fidelityは十分高い。[ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) / [streamText](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)

OpenAI-compatible providerは`baseURL`、API key、custom `fetch`、request変換、provider metadata抽出を設定でき、self-hosted modelにも接続できる。[OpenAI Compatible Providers](https://ai-sdk.dev/providers/openai-compatible-providers) toolの`execute`を省略してclientやqueueへ転送する使い方も公式に説明されている。[Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)

一方、Orielの境界ではAgent loopをharnessに置きつつprovider callだけを`serve`に渡す必要がある。AI SDKのcustom provider/fetchで実現は可能だが、piの`streamFn`/`streamProxy`に相当する専用transportを公式資料では確認できなかった。よってprotocol adapterとevent mappingをOriel側で所有することになる。

docsはBunをpackage install手段として示すが、現在の`ai` package metadataはNode `>=22`を宣言する。Bun runtime上の採用には互換性spikeが必要である。[AI SDK package.json](https://github.com/vercel/ai/blob/main/packages/ai/package.json) ライセンスはApache-2.0。[AI SDK LICENSE](https://github.com/vercel/ai/blob/main/LICENSE)

## 推奨構成の最小形

```text
harness (Bun)
  pi-agent-core
  Agent loop / tool execution / Agent events
          |
          | credentialを含まないlocal IPC stream
          v
serve (Bun, trusted)
  pi-ai
  credential resolution / provider selection / model stream
  LM Studio暫定provider
```

プロセス間は`pi-agent-core`が受け取る`StreamFn`を境界とする。pi-aiのstream eventを独自形式へ正規化せず、IPCは要求の対応付け、event配送、中止、切断検知だけを加える。callback、`fetch`、`AbortSignal`自体は送らず、中止は制御messageとして表す。

提供元とモデルの接続先、認証情報、互換性設定は`serve`を正本とする。実行ハーネスは論理的なprovider IDとmodel IDだけを指定し、利用不能時に別のモデルへ暗黙に切り替えない。

transcriptは`serve`が所有する単一の時系列記録とする。`serve`が観測するモデルからのstreamと、実行ハーネスから届くAgent lifecycle・ツール実行eventを統合し、provider eventを別の正本として二重保存しない。

プロセス切断時は進行中のturnを`interrupted`として記録する。受信済みeventは残すが、未完了のassistant messageを次のmodel contextへ入れず、モデルへの要求と完了未確認のtool callを自動再実行しない。

## 採用条件

固定したpi-agent-coreとpi-aiの版について、Bun上で次を検証し、通過した版だけを採用する。

- textのstream
- thinkingのstream
- tool call引数の差分
- ツール実行後の次のturn
- 中止
- IPC経由のstream
- LM Studio暫定provider

LM Studio暫定providerは`serve`側に置き、pi-aiの`Provider`契約を実装する。公式providerがmergeされても自動では切り替えない。同じ検証を通過し、認証情報の境界とstream eventの意味を維持でき、暫定接続部を完全に削除できる版へ更新するときだけ置き換える。

中央予算、rate limit、provider fallback、仮想keyがv1の受け入れ基準に入らない限り、LiteLLMは採用しない。

## Bun互換gateの結果（2026-08-12実施）

固定した`@earendil-works/pi-agent-core@0.84.1`と`@earendil-works/pi-ai@0.84.1`について、Bun 1.3.14上で上記7項目すべてを検証し、全て合格した。

- text stream: `pi-ai`の`fauxProvider`で、thinking deltaに続けてtext deltaが順序通り届き、完了messageで終わることを確認した。
- thinking stream: 同上。
- tool call引数の差分: `pi-agent-core`の`Agent`が公開する`message_update`の`toolcall_delta`列を連結し、`tool_execution_start`より前に完全な引数JSONへ復元できることを確認した。
- ツール実行後の次のturn: tool実行後にAgentが2回目のturnへ進み、follow-up応答を返すことを確認した。
- 中止: `agent.abort()`実行中の呼び出しで、例外を投げずに`stopReason: "aborted"`の最終messageへ収束することを確認した。
- `StreamFn`をNDJSON経由のBun子processへ跨がせた場合のstream: 別のBun子processが`pi-ai`のevent streamをNDJSON化して送り返し、親のAgentがeventをreshapeせずに同じ結果へ到達することを確認した。子processは`process.execPath`（実行中Bunの絶対path）で起動し、PATH上の`bun`解決には依存しない。
- LM Studio暫定provider: 実LM Studio processではなく、`Bun.serve`によるlocal mockに対して検証した。mockは実際に届いたPOSTボディを検証し、model id、`stream: true`、ユーザー入力のOpenAI Responses `input_text`アイテムが期待通りであることを確認した上で、streamした応答をpi-aiが完成させることを確認した。

`bun install --frozen-lockfile`はexit 0（`engines.node >= 22.19.0`宣言に対する失敗・警告なし）。テストは5 pass / 0 fail / 31 expect() calls（3ファイル）。検証に使った使い捨てtest workspaceはPRから削除済みで、この記録が正本である。

既知の限界:

- LM Studio検証はwire protocolを再現したlocal mockに対するものであり、実LM Studio processへは未接続。
- 正式なIPC contract（`packages/contracts`のschema化）と、process再接続protocolは対象外のまま。
- `StreamFn`が返すevent streamの完了（`agent.prompt()`の解決）と、それを供給する子processの実際のexitは別のlifecycleである。両方の完了を確認したい呼び出し側は明示的に同期する必要がある。

採用含意: v1は`@earendil-works/pi-agent-core@0.84.1`と`@earendil-works/pi-ai@0.84.1`を初期採用版として固定する（[ROADMAP.md](../../ROADMAP.md)「Agentとモデル提供元」）。版を上げる場合は同じ7項目のgateを新しい版で再度通過させる。

## 今回追加比較しなかったもの

他のAgent frameworkやmanaged gatewayは、上の三候補がすでに「Agent loop」「provider adapter」「gateway」の各役割を代表し、現在の受け入れ基準を変える固有能力が確認できなかったため追加しなかった。
