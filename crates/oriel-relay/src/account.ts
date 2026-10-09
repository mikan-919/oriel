import { DurableObject } from "cloudflare:workers";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import { Integrations, type Device, type IntegrationEnv } from "./integrations";
import { WorkflowLeaseError, WorkflowLeases } from "./workflow-lease";

export interface AccountEnv extends IntegrationEnv { RELAY: DurableObjectNamespace; }

type User = { id: string; display_name: string };
type Session = { hash: string; user: User };
type Challenge = {
  hash: string;
  purpose: string;
  challenge: string;
  user_id: string | null;
  display_name: string | null;
  session_hash: string | null;
  origin: string;
  expires_at: number;
};
type Credential = {
  id: string;
  user_id: string;
  public_key: ArrayBuffer;
  counter: number;
  transports: string;
};
type Pairing = {
  device_id: string;
  name: string;
  host_hash: string;
  token_hash: string;
  expires_at: number;
  candidate_id: string | null;
};

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const CHALLENGE_SECONDS = 5 * 60;
const PAIR_SECONDS = 10 * 60;
const DEVICE_ID = /^[a-f0-9]{32}$/;
const SECRET = /^[a-f0-9]{64}$/;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
// ES256 and RS256 are supported by both Workers WebCrypto and common Passkeys.
const ALGORITHMS = [-7, -257];
const encoder = new TextEncoder();

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomSecret(bytes = 32): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hash(secret: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret))));
}

function cookie(request: Request, name: string): string | null {
  const matches = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}

function json(data: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(JSON.stringify(data), { status, headers });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    fail(415, "Expected application/json");
  }
  const text = await request.text();
  if (text.length > 65536) fail(413, "Request is too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    fail(400, "Invalid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) fail(400, "Expected a JSON object");
  return body as Record<string, unknown>;
}

function label(value: unknown, maximum: number): string {
  if (typeof value !== "string") fail(400, "Expected a name");
  const name = value.trim();
  if (!name || name.length > maximum || /[\x00-\x1f\x7f]/.test(name)) fail(400, "Invalid name");
  return name;
}

function deviceID(value: unknown): string {
  if (typeof value !== "string" || !DEVICE_ID.test(value)) fail(400, "Invalid device ID");
  return value;
}

function pairingToken(value: unknown): string {
  if (typeof value !== "string" || !SECRET.test(value)) fail(400, "Invalid pairing token");
  return value;
}

function webauthnCredential(body: Record<string, unknown>, purpose: "register"): RegistrationResponseJSON;
function webauthnCredential(body: Record<string, unknown>, purpose: "login"): AuthenticationResponseJSON;
function webauthnCredential(
  body: Record<string, unknown>, purpose: "register" | "login",
): RegistrationResponseJSON | AuthenticationResponseJSON {
  const value = body.credential;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !("type" in value) || value.type !== "public-key" ||
      !("id" in value) || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,2048}$/.test(value.id) ||
      !("rawId" in value) || value.rawId !== value.id ||
      !("response" in value) || !value.response || typeof value.response !== "object") {
    fail(400, "Invalid Passkey response");
  }
  const response = value.response;
  if (!("clientDataJSON" in response) || typeof response.clientDataJSON !== "string") {
    fail(400, "Invalid Passkey client data");
  }
  try {
    const data = decodeClientDataJSON(response.clientDataJSON);
    if ((data.crossOrigin !== undefined && data.crossOrigin !== false) || data.topOrigin !== undefined) {
      fail(400, "Cross-origin Passkey ceremonies are not allowed");
    }
  } catch {
    fail(400, "Invalid Passkey client data");
  }
  if (purpose === "register") {
    if (!("attestationObject" in response) || typeof response.attestationObject !== "string" ||
        !("clientExtensionResults" in value) || !value.clientExtensionResults ||
        typeof value.clientExtensionResults !== "object" ||
        !("credProps" in value.clientExtensionResults) || !value.clientExtensionResults.credProps ||
        typeof value.clientExtensionResults.credProps !== "object" ||
        !("rk" in value.clientExtensionResults.credProps) || value.clientExtensionResults.credProps.rk !== true) {
      fail(400, "A discoverable Passkey response is required");
    }
    const transports: string[] = [];
    if ("transports" in response && response.transports !== undefined) {
      if (!Array.isArray(response.transports) || response.transports.length > 16) {
        fail(400, "Invalid Passkey transports");
      }
      for (const transport of response.transports) {
        if (typeof transport !== "string" || !/^[a-z-]{1,32}$/.test(transport)) {
          fail(400, "Invalid Passkey transports");
        }
        transports.push(transport);
      }
    }
    return {
      id: value.id, rawId: value.rawId, type: "public-key",
      response: { clientDataJSON: response.clientDataJSON, attestationObject: response.attestationObject, transports },
      clientExtensionResults: { credProps: { rk: true } },
    };
  }
  if (!("authenticatorData" in response) || typeof response.authenticatorData !== "string" ||
      !("signature" in response) || typeof response.signature !== "string" ||
      !("userHandle" in response) || typeof response.userHandle !== "string") {
    fail(400, "Invalid Passkey authentication response");
  }
  return {
    id: value.id, rawId: value.rawId, type: "public-key",
    response: {
      clientDataJSON: response.clientDataJSON, authenticatorData: response.authenticatorData,
      signature: response.signature, userHandle: response.userHandle,
    },
    clientExtensionResults: {},
  };
}

/** Account/authentication metadata only; terminal frames never enter this object. */
export class AccountRegistry extends DurableObject<AccountEnv> {
  private readonly sql = this.ctx.storage.sql;
  private readonly origin: string;
  private readonly rpID: string;
  private readonly secure: boolean;
  private readonly sessionCookie: string;
  private readonly challengeCookie: string;
  private readonly integrations: Integrations;
  private readonly workflows: WorkflowLeases;

  constructor(ctx: DurableObjectState, env: AccountEnv) {
    super(ctx, env);
    const origin = new URL(env.PUBLIC_ORIGIN);
    const loopback = LOOPBACK_HOSTS.includes(origin.hostname);
    if (origin.origin !== env.PUBLIC_ORIGIN ||
        (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback))) {
      throw new Error("PUBLIC_ORIGIN must be an exact HTTPS origin or loopback HTTP origin");
    }
    this.origin = origin.origin;
    this.rpID = origin.hostname;
    this.secure = origin.protocol === "https:";
    this.sessionCookie = this.secure ? "__Host-oriel-session" : "oriel-session";
    this.challengeCookie = this.secure ? "__Host-oriel-challenge" : "oriel-challenge";
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS credentials (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          public_key BLOB NOT NULL,
          counter INTEGER NOT NULL,
          transports TEXT NOT NULL,
          device_type TEXT NOT NULL,
          backed_up INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS credentials_user ON credentials(user_id);
        CREATE TABLE IF NOT EXISTS sessions (
          hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS challenges (
          hash TEXT PRIMARY KEY,
          purpose TEXT NOT NULL,
          challenge TEXT NOT NULL,
          user_id TEXT,
          display_name TEXT,
          session_hash TEXT REFERENCES sessions(hash) ON DELETE CASCADE,
          origin TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS challenges_expiry ON challenges(expires_at);
        CREATE INDEX IF NOT EXISTS challenges_session ON challenges(session_hash);
        CREATE TABLE IF NOT EXISTS devices (
          device_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id),
          host_hash TEXT NOT NULL,
          repository TEXT,
          repository_generation TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS devices_owner ON devices(user_id, name, device_id);
        CREATE TABLE IF NOT EXISTS pairings (
          device_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          host_hash TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at INTEGER NOT NULL,
          candidate_id TEXT REFERENCES users(id)
        );
      `);
      const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(devices)").toArray();
      if (!columns.some(column => column.name === "repository")) this.sql.exec("ALTER TABLE devices ADD COLUMN repository TEXT");
      if (!columns.some(column => column.name === "repository_generation")) this.sql.exec("ALTER TABLE devices ADD COLUMN repository_generation TEXT NOT NULL DEFAULT ''");
    });
    this.integrations = new Integrations(this.sql, env, {
      host: async (request, id) => {
        const supplied = await this.hostHash(request);
        const device = this.sql.exec<Device>("SELECT * FROM devices WHERE device_id = ?", id).toArray()[0];
        if (!device) fail(403, "Device is not paired");
        this.checkHost(device.host_hash, supplied);
        return device;
      },
      session: (request) => this.requireSession(request),
      liveSession: (session) => this.requireLiveSession(session),
      changed: () => this.workflows.publish(),
      body: readBody, fail, json,
    });
    this.workflows = new WorkflowLeases(this.ctx, this.integrations,
      id => this.sql.exec<Device>("SELECT * FROM devices WHERE device_id = ?", id).toArray()[0],
      userId => this.sql.exec<Pick<Device, "device_id">>("SELECT device_id FROM devices WHERE user_id = ? ORDER BY name, device_id", userId).toArray(),
      (sessionHash, userId) => {
        const session = this.sql.exec<{ expires_at: number }>(
          "SELECT sessions.expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.hash = ? AND users.id = ? AND sessions.expires_at > ?",
          sessionHash, userId, now(),
        ).toArray()[0];
        return session ? session.expires_at * 1000 : null;
      });
  }

  async fetch(request: Request): Promise<Response> {
    let clearChallenge = false;
    let response: Response;
    try {
      const url = new URL(request.url);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))) {
        fail(403, "HTTPS is required outside loopback development");
      }
      const websocket = /^\/device\/([a-f0-9]{32})\/(host|client)$/.exec(url.pathname);
      if (websocket) {
        if (request.method !== "GET" || url.search || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          fail(400, "Expected a WebSocket upgrade without query parameters");
        }
        return await this.authorizeSocket(request, websocket[1], websocket[2]);
      }
      const workflowSocket = /^\/api\/workflows\/([a-f0-9]{32})\/connect$/.exec(url.pathname);
      if (workflowSocket) {
        if (request.method !== "GET" || url.search || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          fail(400, "Expected a WebSocket upgrade without query parameters");
        }
        const supplied = await this.hostHash(request);
        const device = this.sql.exec<Device>("SELECT * FROM devices WHERE device_id = ?", workflowSocket[1]).toArray()[0];
        if (!device) fail(403, "Device is not paired");
        this.checkHost(device.host_hash, supplied);
        return this.workflows.connect(device);
      }
      if (url.pathname === "/api/workflow-progress/connect") {
        if (request.method !== "GET" || url.search || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          fail(400, "Expected a WebSocket upgrade without query parameters");
        }
        this.requireOrigin(request);
        if (request.headers.has("Authorization")) fail(403, "Workflow progress requires an owning browser session");
        const session = await this.requireSession(request);
        this.requireLiveSession(session);
        return this.workflows.watch(session.hash, session.user.id);
      }
      const route = `${request.method} ${url.pathname}`;
      const daemon = route === "POST /api/pair/start" ||
        /^GET \/api\/pair\/[a-f0-9]{32}\/status$/.test(route) ||
        /^POST \/api\/pair\/[a-f0-9]{32}\/(confirm|cancel)$/.test(route) ||
        Integrations.daemonRoute(request);
      if (!daemon && url.pathname.startsWith("/api/")) {
        if (request.method === "POST" || request.headers.has("Origin")) this.requireOrigin(request);
      }
      const workflowRoute = url.pathname === "/api/workflows" || url.pathname.startsWith("/api/workflows/");
      if (workflowRoute || url.pathname === "/api/integrations" || url.pathname.startsWith("/api/integrations/")) {
        try {
          response = await (workflowRoute
            ? this.integrations.workflow(request, this.workflows)
            : this.integrations.handle(request));
        } catch (error) {
          if (!(error instanceof HttpError) && !(error instanceof WorkflowLeaseError)) throw error;
          response = json({ error: error.message }, error.status);
        } finally {
          this.workflows.publish();
        }
        response.headers.set("Referrer-Policy", "no-referrer");
        return response;
      }
      clearChallenge = route === "POST /api/auth/register/verify" || route === "POST /api/auth/login/verify";
      switch (route) {
        case "GET /api/session":
          response = json({ user: (await this.session(request))?.user ?? null });
          break;
        case "GET /api/devices": {
          const session = await this.requireSession(request);
          const devices = this.sql.exec<Pick<Device, "device_id" | "name" | "repository">>(
            "SELECT device_id, name, repository FROM devices WHERE user_id = ? ORDER BY name, device_id", session.user.id,
          ).toArray().map(({ repository, ...device }) => ({ ...device, repository: JSON.parse(repository ?? "null"), terminal_status: "unknown" }));
          let cursor = 0;
          await Promise.all(Array.from({ length: Math.min(8, devices.length) }, async () => {
            while (cursor < devices.length) {
              const device = devices[cursor++];
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                const relay = this.env.RELAY.get(this.env.RELAY.idFromName(device.device_id));
                const state = await Promise.race([
                  relay.fetch(new Request("https://relay/internal/terminal-status")).then(async response => {
                    if (!response.ok) throw new Error("State query failed");
                    return response.text();
                  }),
                  new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error("State query timeout")), 2000); }),
                ]);
                if (["online", "grace", "offline", "unknown"].includes(state)) device.terminal_status = state;
              } catch { /* Keep unknown when the relay cannot be queried. */ }
              finally { clearTimeout(timer); }
            }
          }));
          response = json({ devices });
          break;
        }
        case "POST /api/auth/register/options":
          response = await this.registerOptions(request, await readBody(request));
          break;
        case "POST /api/auth/register/verify":
          response = await this.registerVerify(request, await readBody(request));
          break;
        case "POST /api/auth/login/options":
          await readBody(request);
          response = await this.loginOptions(request);
          break;
        case "POST /api/auth/login/verify":
          response = await this.loginVerify(request, await readBody(request));
          break;
        case "POST /api/auth/logout": {
          await readBody(request);
          const session = await this.session(request);
          const secret = cookie(request, this.challengeCookie);
          const challengeHash = secret && SECRET.test(secret) ? await hash(secret) : null;
          this.ctx.storage.transactionSync(() => {
            if (session) this.sql.exec("DELETE FROM sessions WHERE hash = ?", session.hash);
            if (challengeHash) this.sql.exec("DELETE FROM challenges WHERE hash = ?", challengeHash);
          });
          this.workflows.publish();
          response = json({ ok: true }, 200, [
            this.setCookie(this.sessionCookie, "", 0), this.setCookie(this.challengeCookie, "", 0),
          ]);
          break;
        }
        case "POST /api/pair/start":
          response = await this.pairStart(request, await readBody(request));
          break;
        case "POST /api/pair/inspect":
        case "POST /api/pair/claim":
          response = await this.pairBrowser(request, await readBody(request), route.endsWith("/claim"));
          break;
        default: {
          const pairing = /^\/api\/pair\/([a-f0-9]{32})\/(status|confirm|cancel)$/.exec(url.pathname);
          if (!pairing || (pairing[2] === "status" ? request.method !== "GET" : request.method !== "POST")) {
            fail(404, "Not found");
          }
          response = await this.pairDaemon(
            request, pairing[1], pairing[2], request.method === "POST" ? await readBody(request) : {},
          );
        }
      }
    } catch (error) {
      if (error instanceof HttpError || error instanceof WorkflowLeaseError) {
        response = json({ error: error.message }, error.status);
      } else {
        console.error("AccountRegistry request failed");
        response = json({ error: "Authentication service failed" }, 500);
      }
    }
    if (clearChallenge) response.headers.append("Set-Cookie", this.setCookie(this.challengeCookie, "", 0));
    this.workflows.publish();
    return response;
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.workflows.message(ws, message);
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    this.workflows.close(ws);
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    this.workflows.close(ws);
  }

  alarm(): Promise<void> {
    return this.workflows.alarm();
  }

  private requireOrigin(request: Request): void {
    if (request.headers.get("Origin") !== this.origin) fail(403, "Invalid browser Origin");
  }

  private setCookie(name: string, value: string, seconds: number): string {
    const expires = new Date(seconds ? Date.now() + seconds * 1000 : 0).toUTCString();
    return `${name}=${value}; Path=/; HttpOnly; SameSite=${name === this.sessionCookie ? "Lax" : "Strict"}; Max-Age=${seconds}; Expires=${expires}${this.secure ? "; Secure" : ""}`;
  }

  private currentSession(sessionHash: string): Session | null {
    const user = this.sql.exec<User>(
      "SELECT users.id, users.display_name FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.hash = ? AND sessions.expires_at > ?",
      sessionHash, now(),
    ).toArray()[0];
    return user ? { hash: sessionHash, user } : null;
  }

  private async session(request: Request): Promise<Session | null> {
    const secret = cookie(request, this.sessionCookie);
    return secret && SECRET.test(secret) ? this.currentSession(await hash(secret)) : null;
  }

  private async requireSession(request: Request): Promise<Session> {
    const session = await this.session(request);
    if (!session) fail(401, "Sign in first");
    return session;
  }

  private requireLiveSession(session: Session): void {
    if (this.currentSession(session.hash)?.user.id !== session.user.id) fail(401, "Session expired or revoked");
  }

  private cleanupExpired(): void {
    this.sql.exec("DELETE FROM challenges WHERE expires_at <= ?", now());
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now());
  }

  private async storeChallenge(
    request: Request, purpose: string, challenge: string, session: Session | null, user: User | null,
  ): Promise<string> {
    const secret = randomSecret();
    const secretHash = await hash(secret);
    const previous = cookie(request, this.challengeCookie);
    const previousHash = previous && SECRET.test(previous) ? await hash(previous) : null;
    this.ctx.storage.transactionSync(() => {
      if (session) this.requireLiveSession(session);
      this.cleanupExpired();
      if (previousHash) this.sql.exec("DELETE FROM challenges WHERE hash = ?", previousHash);
      this.sql.exec(
        "INSERT INTO challenges (hash, purpose, challenge, user_id, display_name, session_hash, origin, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        secretHash, purpose, challenge, user?.id ?? null, user?.display_name ?? null,
        session?.hash ?? null, this.origin, now() + CHALLENGE_SECONDS,
      );
    });
    return this.setCookie(this.challengeCookie, secret, CHALLENGE_SECONDS);
  }

  private async consumeChallenge(request: Request, purpose: string): Promise<{ challenge: Challenge; session: Session | null }> {
    const secret = cookie(request, this.challengeCookie);
    if (!secret || !SECRET.test(secret)) fail(400, "Missing Passkey challenge");
    const challengeHash = await hash(secret);
    const session = await this.session(request);
    // Consume before any asynchronous signature verification, including failed attempts.
    const challenge = this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec<Challenge>("SELECT * FROM challenges WHERE hash = ?", challengeHash).toArray()[0];
      this.sql.exec("DELETE FROM challenges WHERE hash = ?", challengeHash);
      return row;
    });
    if (!challenge || challenge.purpose !== purpose || challenge.expires_at <= now() ||
        challenge.origin !== this.origin || challenge.session_hash !== (session?.hash ?? null)) {
      fail(400, "Passkey challenge expired, used, or belongs to another session");
    }
    if (purpose === "register" && session && challenge.user_id !== session.user.id) {
      fail(403, "Passkey belongs to another account");
    }
    return { challenge, session };
  }

  private ceremonyStillValid(challenge: Challenge, session: Session | null): void {
    if (challenge.expires_at <= now()) fail(400, "Passkey challenge expired");
    if (session) this.requireLiveSession(session);
  }

  private async newSession(): Promise<{ secret: string; hash: string }> {
    const secret = randomSecret();
    return { secret, hash: await hash(secret) };
  }

  private persistSession(user: User, sessionHash: string, previous: Session | null): void {
    this.cleanupExpired();
    if (previous) this.sql.exec("DELETE FROM sessions WHERE hash = ?", previous.hash);
    this.sql.exec("INSERT INTO sessions (hash, user_id, expires_at) VALUES (?, ?, ?)", sessionHash, user.id, now() + SESSION_SECONDS);
  }

  private async registerOptions(request: Request, body: Record<string, unknown>): Promise<Response> {
    const session = await this.session(request);
    const id = randomSecret(16);
    const user = session?.user ?? {
      id, display_name: body.display_name === undefined ? `Oriel-${id.slice(0, 6)}` : label(body.display_name, 64),
    };
    const credentials = session ? this.sql.exec<{ id: string; transports: string }>(
      "SELECT id, transports FROM credentials WHERE user_id = ?", user.id,
    ).toArray() : [];
    const options = await generateRegistrationOptions({
      rpName: "Oriel", rpID: this.rpID,
      userID: encoder.encode(user.id), userName: user.display_name, userDisplayName: user.display_name,
      timeout: CHALLENGE_SECONDS * 1000, attestationType: "none",
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      extensions: { credProps: true }, supportedAlgorithmIDs: ALGORITHMS,
      excludeCredentials: credentials.map((credential) => ({ id: credential.id, transports: JSON.parse(credential.transports) })),
    });
    const challengeCookie = await this.storeChallenge(request, "register", options.challenge, session, user);
    return json({ options }, 200, [challengeCookie]);
  }

  private async registerVerify(request: Request, body: Record<string, unknown>): Promise<Response> {
    const { challenge, session } = await this.consumeChallenge(request, "register");
    const response = webauthnCredential(body, "register");
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response, expectedChallenge: challenge.challenge, expectedOrigin: this.origin,
        expectedRPID: this.rpID, requireUserVerification: true, supportedAlgorithmIDs: ALGORITHMS,
      });
    } catch {
      fail(400, "Passkey registration verification failed");
    }
    if (!verification.verified || !challenge.user_id || !challenge.display_name) fail(400, "Passkey registration verification failed");
    const info = verification.registrationInfo;
    if (info.credential.id !== response.id) fail(400, "Passkey credential ID mismatch");
    const user: User = { id: challenge.user_id, display_name: challenge.display_name };
    const fresh = await this.newSession();
    const key = info.credential.publicKey;
    const publicKey = key.byteOffset === 0 && key.byteLength === key.buffer.byteLength
      ? key.buffer : key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength);
    this.ctx.storage.transactionSync(() => {
      this.ceremonyStillValid(challenge, session);
      if (this.sql.exec("SELECT id FROM credentials WHERE id = ?", info.credential.id).toArray().length) {
        fail(409, "This Passkey is already registered");
      }
      if (!session) this.sql.exec("INSERT INTO users (id, display_name) VALUES (?, ?)", user.id, user.display_name);
      this.sql.exec(
        "INSERT INTO credentials (id, user_id, public_key, counter, transports, device_type, backed_up) VALUES (?, ?, ?, ?, ?, ?, ?)",
        info.credential.id, user.id, publicKey, info.credential.counter,
        JSON.stringify(info.credential.transports ?? []), info.credentialDeviceType, Number(info.credentialBackedUp),
      );
      this.persistSession(user, fresh.hash, session);
    });
    return json({ user }, 200, [this.setCookie(this.sessionCookie, fresh.secret, SESSION_SECONDS)]);
  }

  private async loginOptions(request: Request): Promise<Response> {
    const session = await this.session(request);
    const options = await generateAuthenticationOptions({
      rpID: this.rpID, timeout: CHALLENGE_SECONDS * 1000, userVerification: "required",
    });
    const challengeCookie = await this.storeChallenge(request, "login", options.challenge, session, null);
    return json({ options }, 200, [challengeCookie]);
  }

  private async loginVerify(request: Request, body: Record<string, unknown>): Promise<Response> {
    const { challenge, session } = await this.consumeChallenge(request, "login");
    const response = webauthnCredential(body, "login");
    const credential = this.sql.exec<Credential>("SELECT * FROM credentials WHERE id = ?", response.id).toArray()[0];
    if (!credential || response.response.userHandle !== btoa(credential.user_id).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")) {
      fail(400, "Passkey account handle does not match");
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge.challenge, expectedOrigin: this.origin, expectedRPID: this.rpID,
        requireUserVerification: true,
        credential: {
          id: credential.id, publicKey: new Uint8Array(credential.public_key), counter: credential.counter,
          transports: JSON.parse(credential.transports),
        },
      });
    } catch {
      fail(400, "Passkey login verification failed");
    }
    if (!verification.verified) fail(400, "Passkey login verification failed");
    const info = verification.authenticationInfo;
    const user = this.sql.exec<User>("SELECT id, display_name FROM users WHERE id = ?", credential.user_id).toArray()[0];
    if (!user) fail(400, "Passkey account is unavailable");
    const fresh = await this.newSession();
    this.ctx.storage.transactionSync(() => {
      this.ceremonyStillValid(challenge, session);
      const current = this.sql.exec<Credential>("SELECT * FROM credentials WHERE id = ?", credential.id).toArray()[0];
      // A second ceremony may have advanced the counter while signature verification awaited.
      if (!current || current.user_id !== user.id ||
          ((info.newCounter > 0 || current.counter > 0) && info.newCounter <= current.counter)) {
        fail(409, "Passkey counter was already used");
      }
      this.sql.exec("UPDATE credentials SET counter = ?, device_type = ?, backed_up = ? WHERE id = ?",
        info.newCounter, info.credentialDeviceType, Number(info.credentialBackedUp), credential.id);
      this.persistSession(user, fresh.hash, session);
    });
    return json({ user }, 200, [this.setCookie(this.sessionCookie, fresh.secret, SESSION_SECONDS)]);
  }

  private async hostHash(request: Request): Promise<string> {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("Authorization") ?? "");
    if (!token) fail(401, "A device host credential is required");
    return hash(token[1]);
  }

  private checkHost(stored: string, supplied: string): void {
    if (stored !== supplied) fail(403, "Device host credential does not match");
  }

  private async pairStart(request: Request, body: Record<string, unknown>): Promise<Response> {
    const id = deviceID(body.device_id);
    const name = label(body.name, 255);
    const hostHash = await this.hostHash(request);
    const token = randomSecret();
    const tokenHash = await hash(token);
    const result = this.ctx.storage.transactionSync(() => {
      const device = this.sql.exec<Device>("SELECT * FROM devices WHERE device_id = ?", id).toArray()[0];
      if (device) {
        this.checkHost(device.host_hash, hostHash);
        return { status: "paired" };
      }
      const pending = this.sql.exec<Pairing>("SELECT * FROM pairings WHERE device_id = ?", id).toArray()[0];
      // Expired pending rows still reserve the device ID for its original host secret.
      if (pending) this.checkHost(pending.host_hash, hostHash);
      const expiresAt = now() + PAIR_SECONDS;
      this.sql.exec(
        "INSERT INTO pairings (device_id, name, host_hash, token_hash, expires_at, candidate_id) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash, expires_at = excluded.expires_at, candidate_id = NULL",
        id, name, hostHash, tokenHash, expiresAt,
      );
      return { status: "pending", url: `${this.origin}/#pair=${token}`, expires_at: expiresAt };
    });
    return json(result);
  }

  private async pairBrowser(request: Request, body: Record<string, unknown>, claim: boolean): Promise<Response> {
    const session = await this.requireSession(request);
    const tokenHash = await hash(pairingToken(body.token));
    const result = this.ctx.storage.transactionSync(() => {
      this.requireLiveSession(session);
      const pending = this.sql.exec<Pairing>("SELECT * FROM pairings WHERE token_hash = ?", tokenHash).toArray()[0];
      if (!pending) fail(404, "Pairing link is invalid or has already completed");
      if (pending.expires_at <= now()) fail(410, "Pairing link expired");
      if (claim) {
        if (pending.candidate_id !== null) fail(409, "Pairing link has already been claimed");
        this.sql.exec("UPDATE pairings SET candidate_id = ? WHERE device_id = ?", session.user.id, pending.device_id);
        return { ok: true };
      }
      return { device_id: pending.device_id, name: pending.name, expires_at: pending.expires_at };
    });
    return json(result);
  }

  private async pairDaemon(request: Request, id: string, action: string, body: Record<string, unknown>): Promise<Response> {
    const hostHash = await this.hostHash(request);
    if (action === "confirm" && (typeof body.user_id !== "string" || !DEVICE_ID.test(body.user_id))) {
      fail(400, "Invalid account ID");
    }
    const result = this.ctx.storage.transactionSync(() => {
      const device = this.sql.exec<Device>("SELECT * FROM devices WHERE device_id = ?", id).toArray()[0];
      if (device) {
        this.checkHost(device.host_hash, hostHash);
        if (action === "status") return { status: "paired" };
        if (action === "cancel") return { ok: true };
        fail(409, "Device is already paired");
      }
      const pending = this.sql.exec<Pairing>("SELECT * FROM pairings WHERE device_id = ?", id).toArray()[0];
      if (pending) this.checkHost(pending.host_hash, hostHash);
      if (action === "cancel") {
        if (pending) this.sql.exec("DELETE FROM pairings WHERE device_id = ?", id);
        return { ok: true };
      }
      if (!pending || pending.expires_at <= now()) {
        if (action === "status") return { status: "expired" };
        fail(410, "Pairing request expired");
      }
      if (action === "status") {
        if (!pending.candidate_id) return { status: "waiting" };
        const user = this.sql.exec<User>("SELECT id, display_name FROM users WHERE id = ?", pending.candidate_id).toArray()[0];
        if (!user) fail(409, "Pairing account is unavailable");
        return { status: "confirmation", user };
      }
      if (!pending.candidate_id || pending.candidate_id !== body.user_id) {
        fail(409, "Local confirmation does not match the selected account");
      }
      this.sql.exec("INSERT INTO devices (device_id, name, user_id, host_hash) VALUES (?, ?, ?, ?)",
        id, pending.name, pending.candidate_id, hostHash);
      this.sql.exec("DELETE FROM pairings WHERE device_id = ?", id);
      return { status: "paired" };
    });
    return json(result);
  }

  private async authorizeSocket(request: Request, id: string, role: string): Promise<Response> {
    if (role === "host") {
      const supplied = await this.hostHash(request);
      const device = this.sql.exec<Device>("SELECT * FROM devices WHERE device_id = ?", id).toArray()[0];
      if (!device) fail(403, "Device is not paired");
      this.checkHost(device.host_hash, supplied);
    } else {
      this.requireOrigin(request);
      if (!(request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((value) => value.trim()).includes("oriel-client")) {
        fail(403, "Expected oriel-client WebSocket protocol");
      }
      const session = await this.requireSession(request);
      const device = this.sql.exec<Device>("SELECT * FROM devices WHERE device_id = ?", id).toArray()[0];
      if (!device || device.user_id !== session.user.id) fail(403, "Device belongs to another account");
    }
    return json({ ok: true });
  }
}
