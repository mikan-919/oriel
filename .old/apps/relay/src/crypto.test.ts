import { describe, expect, it } from "vitest";

import { verifyHmacSha256Hex } from "./crypto";

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );

  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifyHmacSha256Hex", () => {
  it("accepts a signature computed over the exact raw body", async () => {
    const secret = "webhook-secret";
    const body = '{"action":"opened"}';

    expect(
      await verifyHmacSha256Hex(secret, body, await hmacHex(secret, body)),
    ).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const secret = "webhook-secret";
    const signature = await hmacHex(secret, '{"action":"opened"}');

    expect(
      await verifyHmacSha256Hex(secret, '{"action":"closed"}', signature),
    ).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const secret = "webhook-secret";
    const body = '{"action":"opened"}';
    const signature = await hmacHex(secret, body);
    const flipped = signature.replace(/^./, signature[0] === "0" ? "1" : "0");

    expect(await verifyHmacSha256Hex(secret, body, flipped)).toBe(false);
  });

  it("rejects non-hex or malformed signatures without throwing", async () => {
    expect(await verifyHmacSha256Hex("secret", "body", "not-hex")).toBe(false);
    expect(await verifyHmacSha256Hex("secret", "body", "abc")).toBe(false);
    expect(await verifyHmacSha256Hex("secret", "body", "")).toBe(false);
  });
});
