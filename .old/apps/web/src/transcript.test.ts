import { expect, test } from "bun:test";
import type { TranscriptEntry } from "@mikan-919/oriel-contracts";

import {
  parseTranscriptEvent,
  toConversation,
  transcriptSnippet,
} from "./transcript";

function entry(kind: string, content: string, sequence = 1): TranscriptEntry {
  return {
    jobId: "job-1",
    sequence,
    kind,
    content,
    createdAt: 1_755_734_400_000,
  };
}

test("job.startとjob.resultはworkerの節目として系統的イベントになる", () => {
  expect(parseTranscriptEvent(entry("job.start", ""))).toEqual({
    key: "job-1-1",
    role: "system",
    text: "Jobを開始しました",
  });
  expect(parseTranscriptEvent(entry("job.result", "完了"))?.text).toBe("完了");
});

test("外部操作は既知のlabelとstatusへ畳み、JSONでなければ内容をそのまま出す", () => {
  expect(
    parseTranscriptEvent(
      entry("external.pull_request", JSON.stringify({ status: "created" })),
    )?.text,
  ).toBe("Pull Request: created");
  expect(
    parseTranscriptEvent(entry("external.review_state", "not json"))?.text,
  ).toBe("Linear: レビュー用stateへ反映: not json");
});

test("model.stream.eventは確定したtext_end/toolcall_end/errorだけを拾う", () => {
  expect(
    parseTranscriptEvent(
      entry(
        "model.stream.event",
        JSON.stringify({ type: "text_end", content: "答え" }),
      ),
    ),
  ).toEqual({ key: "job-1-1", role: "assistant", text: "答え" });

  expect(
    parseTranscriptEvent(
      entry(
        "model.stream.event",
        JSON.stringify({
          type: "toolcall_end",
          toolCall: { name: "read", arguments: { path: "a.ts" } },
        }),
      ),
    ),
  ).toEqual({
    key: "job-1-1",
    role: "tool",
    text: 'read({"path":"a.ts"})',
  });

  expect(
    parseTranscriptEvent(
      entry(
        "model.stream.event",
        JSON.stringify({ type: "error", error: "x" }),
      ),
    ),
  ).toEqual({ key: "job-1-1", role: "error", text: '"x"' });
});

test("途中経過、壊れたJSON、未知の種別はnullへ落とす", () => {
  expect(
    parseTranscriptEvent(
      entry(
        "model.stream.event",
        JSON.stringify({ type: "text_delta", content: "途" }),
      ),
    ),
  ).toBeNull();
  expect(parseTranscriptEvent(entry("model.stream.event", "{"))).toBeNull();
  expect(parseTranscriptEvent(entry("model.stream.event", "[]"))).toBeNull();
  expect(parseTranscriptEvent(entry("unknown.kind", "x"))).toBeNull();
});

test("検索結果の一行は拾えない種別だけ生の内容へ落とす", () => {
  expect(transcriptSnippet(entry("job.start", ""))).toBe("Jobを開始しました");
  expect(transcriptSnippet(entry("unknown.kind", "生の内容"))).toBe("生の内容");
});

test("会話はsequence昇順に並べ、拾えないeventを落とす", () => {
  const events = toConversation([
    entry(
      "model.stream.event",
      JSON.stringify({ type: "text_end", content: "後" }),
      3,
    ),
    entry("model.stream.event", JSON.stringify({ type: "text_delta" }), 2),
    entry("job.start", "", 1),
  ]);

  expect(events.map((event) => event.text)).toEqual([
    "Jobを開始しました",
    "後",
  ]);
});
