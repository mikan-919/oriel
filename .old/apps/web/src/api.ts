import { identity } from "@mikan-919/oriel-identity";

const csrfHeaderName = `x-${identity.codeName}-csrf`;

export function environmentVariable(name: string): string {
  return `${identity.environmentPrefix}${name}`;
}

export async function postJson(
  path: string,
  csrfToken: string,
  body: unknown,
): Promise<{ ok: boolean; body: unknown }> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [csrfHeaderName]: csrfToken,
    },
    body: JSON.stringify(body),
  });

  return { ok: response.ok, body: await response.json().catch(() => null) };
}

export function getApiErrorMessage(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string" &&
    body.message !== ""
  ) {
    return body.message;
  }

  return "サーバーからエラーの詳細を取得できませんでした。";
}
