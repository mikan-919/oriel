/**
 * harnessとのNDJSON IPC。
 *
 * 所有権を失ったら、harnessからの新しい要求を受け取る経路自体を閉じる。
 */
export async function* readNdjson(
  input: ReadableStream<Uint8Array>,
  stopSignal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = input.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const stop = () => void reader.cancel().catch(() => {});
  const stopped = () => stopSignal?.aborted ?? false;
  stopSignal?.addEventListener("abort", stop, { once: true });

  try {
    if (stopped()) {
      return;
    }

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (stopped()) {
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line !== "") {
          yield parseLine(line);
        }
      }
    }

    const finalLine = buffer + decoder.decode();

    if (finalLine !== "") {
      yield parseLine(finalLine);
    }
  } finally {
    stopSignal?.removeEventListener("abort", stop);
    reader.releaseLock();
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return {};
  }
}

export async function writeNdjson(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  message: unknown,
): Promise<void> {
  await writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
}
