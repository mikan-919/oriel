/**
 * `AbortSignal`の`abort` eventは失効の瞬間に一度だけ発火するため、登録前に
 * 既に失効していたsignalへ`addEventListener`しても呼ばれない。登録時点の
 * 失効も同じ扱いにする。
 */
export function onAbort(
  signal: AbortSignal | undefined,
  listener: () => void,
): void {
  if (signal === undefined) {
    return;
  }

  if (signal.aborted) {
    listener();
    return;
  }

  signal.addEventListener("abort", listener, { once: true });
}
