import { expect, test } from "bun:test";

import { createModels } from "@earendil-works/pi-ai";

import { createLmStudioProvider } from "./lm-studio-provider";

const catalog = {
  object: "list",
  data: [
    {
      id: "qwen3-coder-30b",
      object: "model",
      type: "llm",
      state: "loaded",
      max_context_length: 32768,
    },
    {
      id: "qwen2-vl-7b",
      object: "model",
      type: "vlm",
      state: "not-loaded",
      max_context_length: 4096,
    },
    // 埋め込みmodelはAgent loopのmodelにしない。
    { id: "nomic-embed-text", object: "model", type: "embeddings" },
    // 上限を提供元が答えない項目は、既定値で埋めずに落とす。
    { id: "broken", object: "model", type: "llm" },
  ],
};

async function refreshed(
  fetchImpl: (request: Request) => Promise<Response>,
  baseUrl = "http://127.0.0.1:1234",
) {
  const models = createModels();

  models.setProvider(createLmStudioProvider({ baseUrl, fetchImpl }));
  await models.refresh({ allowNetwork: true });

  return models;
}

test("the local catalog and its context limits come from the running server", async () => {
  const requested: string[] = [];
  const models = await refreshed(async (request) => {
    requested.push(request.url);

    return Response.json(catalog);
  });

  // 上限はこの設計文書ではなく、動いている提供元が答えた値だけを使う。
  expect(requested).toEqual(["http://127.0.0.1:1234/api/v0/models"]);
  expect(models.getModel("lm-studio", "qwen3-coder-30b")).toMatchObject({
    id: "qwen3-coder-30b",
    api: "openai-completions",
    provider: "lm-studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    contextWindow: 32768,
    maxTokens: 32768,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  expect(models.getModel("lm-studio", "qwen2-vl-7b")?.input).toEqual([
    "text",
    "image",
  ]);

  // 使えないmodelを推測で足さない。
  expect(models.getModel("lm-studio", "nomic-embed-text")).toBeUndefined();
  expect(models.getModel("lm-studio", "broken")).toBeUndefined();
});

test("a server that cannot be listed offers no model instead of a guessed one", async () => {
  for (const fetchImpl of [
    async () => new Response("nope", { status: 500 }),
    async () => Response.json({ data: "not a list" }),
    () => Promise.reject(new Error("connection refused")),
  ]) {
    expect((await refreshed(fetchImpl)).getModels("lm-studio")).toEqual([]);
  }
});
