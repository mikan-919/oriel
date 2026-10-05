import { expect, test } from "bun:test";

import { modelSatisfiesCapabilities } from "./model-capabilities";

const model = {
  reasoning: false,
  input: ["text"],
  contextWindow: 32000,
  maxTokens: 4096,
};

test("no capabilities means no constraint", () => {
  expect(modelSatisfiesCapabilities(undefined, model)).toBe(true);
});

test("each field rejects a model that falls short", () => {
  expect(modelSatisfiesCapabilities({ reasoning: true }, model)).toBe(false);
  expect(modelSatisfiesCapabilities({ image: true }, model)).toBe(false);
  expect(modelSatisfiesCapabilities({ minContextWindow: 64000 }, model)).toBe(
    false,
  );
  expect(modelSatisfiesCapabilities({ minMaxTokens: 8192 }, model)).toBe(false);
});

test("a model that meets every requested field satisfies the request", () => {
  const capable = {
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 8192,
  };

  expect(
    modelSatisfiesCapabilities(
      {
        reasoning: true,
        image: true,
        minContextWindow: 128000,
        minMaxTokens: 8192,
      },
      capable,
    ),
  ).toBe(true);
});
