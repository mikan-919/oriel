import { expect, test } from "bun:test";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";

import { createLmStudioProvider } from "./lm-studio-provider";
import {
  createPiModelStreamProvider,
  resolveModelCapabilities,
} from "./pi-model-provider";

function withFauxModels() {
  const faux = fauxProvider({
    provider: "lm-studio",
    models: [{ id: "local-model" }],
  });
  const models = createModels();

  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("implemented the HOW")]);

  return { faux, models };
}

type StreamResult = AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

/** 最初のeventだけを取り出す。stopの証明にはこれで足りる。 */
async function firstEvent(stream: StreamResult) {
  return (await stream)[Symbol.asyncIterator]().next();
}

async function collect(stream: AsyncIterable<unknown>) {
  const events: unknown[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

test("the provider streams pi events unchanged and resolves the credential inside serve", async () => {
  const { models } = withFauxModels();
  const requested: string[] = [];
  const provider = createPiModelStreamProvider({
    models,
    resolveApiKey: async (id) => {
      requested.push(id);
      return "provider-credential";
    },
  });

  const events = (await collect(
    await provider.stream({
      provider: "lm-studio",
      model: "local-model",
      context: { messages: [{ role: "user", content: "implement the HOW" }] },
      signal: new AbortController().signal,
    }),
  )) as { type: string }[];

  expect(requested).toEqual(["lm-studio"]);
  expect(events[0]?.type).toBe("start");
  expect(events.at(-1)?.type).toBe("done");
});

test("an unknown model or an unresolvable credential stops the run", async () => {
  const { models } = withFauxModels();

  await expect(
    firstEvent(
      createPiModelStreamProvider({
        models,
        resolveApiKey: async () => "provider-credential",
      }).stream({
        provider: "lm-studio",
        model: "another-model",
        context: { messages: [] },
        signal: new AbortController().signal,
      }),
    ),
  ).rejects.toThrow();

  await expect(
    firstEvent(
      createPiModelStreamProvider({
        models,
        resolveApiKey: async () => null,
      }).stream({
        provider: "lm-studio",
        model: "local-model",
        context: { messages: [] },
        signal: new AbortController().signal,
      }),
    ),
  ).rejects.toThrow();
});

test("resolveModelCapabilities returns the catalog metadata, or null when the model is unknown", async () => {
  const { models } = withFauxModels();

  expect(
    await resolveModelCapabilities(models, "lm-studio", "local-model"),
  ).toEqual({
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
  });
  expect(
    await resolveModelCapabilities(models, "lm-studio", "no-such-model"),
  ).toBeNull();
});

test("a model that is not in the catalog yet is looked up again before the run stops", async () => {
  const listed: string[] = [];
  const models = createModels();

  models.setProvider(
    createLmStudioProvider({
      baseUrl: "http://127.0.0.1:1234",
      fetchImpl: async (request) => {
        listed.push(request.url);

        return Response.json({
          data: [
            {
              id: "local-model",
              type: "llm",
              max_context_length: 8192,
            },
          ],
        });
      },
    }),
  );

  // 事前のrefreshなしでも、要求されたmodelを一度だけ読み直して解決する。
  const stream = createPiModelStreamProvider({
    models,
    resolveApiKey: async () => "provider-credential",
  }).stream({
    provider: "lm-studio",
    model: "local-model",
    context: { messages: [] },
    signal: new AbortController().signal,
  });

  await firstEvent(stream);

  expect(listed).toEqual(["http://127.0.0.1:1234/api/v0/models"]);
});
