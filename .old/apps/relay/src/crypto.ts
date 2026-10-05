const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function randomSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));

  return toBase64Url(new Uint8Array(digest));
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** 署名済みの短命payload。relayへ状態を増やさずにOAuth往復と管理sessionを持たせる。 */
export async function signPayload(
  secret: string,
  payload: unknown,
): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    encoder.encode(body),
  );

  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifyPayload<T>(
  secret: string,
  token: string,
): Promise<T | null> {
  const [body, signature] = token.split(".");

  if (body === undefined || signature === undefined) {
    return null;
  }

  const expected = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    encoder.encode(body),
  );

  if (toBase64Url(new Uint8Array(expected)) !== signature) {
    return null;
  }

  try {
    return JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(body.replaceAll("-", "+").replaceAll("_", "/")),
          (character) => character.charCodeAt(0),
        ),
      ),
    ) as T;
  } catch {
    return null;
  }
}

function base64UrlJson(value: unknown): string {
  return toBase64Url(encoder.encode(JSON.stringify(value)));
}

/** PEMのPKCS#8秘密鍵をWorkers互換のWeb Crypto keyへ読み込む。 */
async function importPkcs8(privateKeyPem: string): Promise<CryptoKey> {
  const body = privateKeyPem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);

  return crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }

  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

/**
 * webhookのraw bodyへのHMAC-SHA256を検証する。GitHubの`X-Hub-Signature-256`
 * (`sha256=`prefixを剥がした値)とLinearの`Linear-Signature`はどちらもこの形式。
 * `crypto.subtle.verify`はconstant-time比較を行うため、`signPayload`/
 * `verifyPayload`の`!==`比較より安全なprimitiveとして使い分ける。
 */
export async function verifyHmacSha256Hex(
  secret: string,
  rawBody: string,
  signatureHex: string,
): Promise<boolean> {
  const signature = hexToBytes(signatureHex);

  if (signature === null) {
    return false;
  }

  return crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    signature as BufferSource,
    encoder.encode(rawBody),
  );
}

/**
 * GitHub AppのJWT。秘密鍵はrelayのsecretから読み、署名だけに使って保存しない。
 */
export async function createAppJwt(input: {
  appId: string;
  privateKeyPem: string;
  now: number;
  lifetimeSeconds: number;
}): Promise<string> {
  const issuedAt = Math.floor(input.now / 1000);
  const signingInput = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson(
    {
      iat: issuedAt - 60,
      exp: issuedAt + input.lifetimeSeconds,
      iss: input.appId,
    },
  )}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await importPkcs8(input.privateKeyPem),
    encoder.encode(signingInput),
  );

  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}
