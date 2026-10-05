import type { TranscriptEntry } from "@mikan-919/oriel-contracts";

export interface ConversationEvent {
  key: string;
  role: "assistant" | "tool" | "system" | "error";
  text: string;
}

const externalOperationLabel: Record<string, string> = {
  "external.linear_in_progress": "Linear: In Progressへ反映",
  "external.pull_request": "Pull Request",
  "external.review_state": "Linear: レビュー用stateへ反映",
  "external.returned_to_triage": "Linear: Triageへ差し戻し",
};

/**
 * model.stream.eventの生イベント(pi-aiのAssistantMessageEvent)から、会話として
 * 意味のある要素だけを取り出す。text_delta等の途中経過は積み上げず、確定した
 * text_end/toolcall_end/errorだけを拾う。job.start/job.resultはworker側の
 * 節目としてそのまま系統的イベントに変換する。
 */
export function parseTranscriptEvent(
  entry: TranscriptEntry,
): ConversationEvent | null {
  const key = `${entry.jobId}-${entry.sequence}`;

  if (entry.kind === "job.start") {
    return { key, role: "system", text: "Jobを開始しました" };
  }

  if (entry.kind === "job.result") {
    return { key, role: "system", text: entry.content };
  }

  if (entry.kind in externalOperationLabel) {
    let status: unknown;

    try {
      status = (JSON.parse(entry.content) as { status: unknown }).status;
    } catch {
      status = entry.content;
    }

    return {
      key,
      role: "system",
      text: `${externalOperationLabel[entry.kind]}: ${String(status)}`,
    };
  }

  if (entry.kind !== "model.stream.event") {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(entry.content);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    typeof (parsed as { type: unknown }).type !== "string"
  ) {
    return null;
  }

  const event = parsed as Record<string, unknown>;

  if (event.type === "text_end" && typeof event.content === "string") {
    return { key, role: "assistant", text: event.content };
  }

  if (
    event.type === "toolcall_end" &&
    typeof event.toolCall === "object" &&
    event.toolCall !== null
  ) {
    const toolCall = event.toolCall as { name?: unknown; arguments?: unknown };

    return {
      key,
      role: "tool",
      text: `${String(toolCall.name)}(${JSON.stringify(toolCall.arguments)})`,
    };
  }

  if (event.type === "error") {
    return { key, role: "error", text: JSON.stringify(event.error ?? event) };
  }

  return null;
}

/** 検索結果の一行は、会話表示と同じ整形を通し、拾えない種別だけ生の内容へ落とす。 */
export function transcriptSnippet(entry: TranscriptEntry): string {
  return parseTranscriptEvent(entry)?.text ?? entry.content;
}

/** transcriptは`sequence`の昇順が正本。取得順に依らず会話の並びをここで決める。 */
export function toConversation(
  entries: TranscriptEntry[],
): ConversationEvent[] {
  return entries
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
    .map(parseTranscriptEvent)
    .filter((event): event is ConversationEvent => event !== null);
}
