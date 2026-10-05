import {
  createProvider,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/** 暫定接続部が使う提供元の論理識別子。 */
export const lmStudioProviderId = "lm-studio";

export interface LmStudioProviderOptions {
  /** 人間が`serve`へ設定したLM Studio serverのorigin。harnessへは渡さない。 */
  baseUrl: string;
  fetchImpl?: (request: Request) => Promise<Response>;
}

interface LmStudioModelEntry {
  id?: unknown;
  type?: unknown;
  max_context_length?: unknown;
}

/**
 * LM Studioの暫定接続部。
 *
 * ROADMAPのとおり、LM Studioは`serve`側の暫定接続部で対応し、pi-aiの公式provider
 * が利用可能になった後、同じ検証を通過した版へ更新するときに削除して置き換える。
 *
 * context長やtoken上限は設計文書へ固定せず、動いている提供元が答えた値だけを使う。
 * 答えないmodelは既定値で補わずcatalogから落とす。
 *
 * | Limit | Source | Required For |
 * | --- | --- | --- |
 * | `contextWindow` / `maxTokens` | LM Studio `GET /api/v0/models`の`max_context_length` | model選択と要求の組み立て |
 */
export function createLmStudioProvider({
  baseUrl,
  fetchImpl = (request) => fetch(request),
}: LmStudioProviderOptions): Provider<"openai-completions"> {
  const origin = baseUrl.replace(/\/+$/, "");

  return createProvider<"openai-completions">({
    id: lmStudioProviderId,
    name: "LM Studio",
    baseUrl: `${origin}/v1`,
    auth: {
      apiKey: {
        name: "LM Studio API key",
        /**
         * ローカルserverはkeyを要求しないため、環境変数からは解決しない。実際の
         * 要求へ載せるcredentialの正本は`serve`の`Bun.secrets`にあり、stream呼び
         * 出しの引数としてだけ渡す。
         */
        resolve: async ({ credential }) => ({
          auth: { apiKey: credential?.key },
          source: "LM Studio",
        }),
      },
    },
    models: [],
    async fetchModels({ signal }) {
      let entries: unknown;

      try {
        const response = await fetchImpl(
          new Request(`${origin}/api/v0/models`, { signal }),
        );

        if (!response.ok) {
          return [];
        }

        entries = ((await response.json()) as { data?: unknown }).data;
      } catch {
        // 一覧できない提供元は、modelを推測で足さない。
        return [];
      }

      if (!Array.isArray(entries)) {
        return [];
      }

      const models: Model<"openai-completions">[] = [];

      for (const entry of entries as LmStudioModelEntry[]) {
        const contextWindow = entry.max_context_length;

        if (
          typeof entry.id !== "string" ||
          entry.id === "" ||
          (entry.type !== "llm" && entry.type !== "vlm") ||
          typeof contextWindow !== "number" ||
          !Number.isInteger(contextWindow) ||
          contextWindow <= 0
        ) {
          continue;
        }

        models.push({
          id: entry.id,
          name: entry.id,
          api: "openai-completions",
          provider: lmStudioProviderId,
          baseUrl: `${origin}/v1`,
          reasoning: false,
          input: entry.type === "vlm" ? ["text", "image"] : ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens: contextWindow,
        });
      }

      return models;
    },
    api: openAICompletionsApi(),
  });
}
