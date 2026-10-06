import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { Miniflare } from "miniflare";
import { test } from "node:test";

const origin = "https://oriel.example";
const device = "a".repeat(32);
const hostToken = "b".repeat(64);

// A software authenticator signs real P-256 WebAuthn responses. No auth API mocks.
function authenticator() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = keys.publicKey.export({ format: "jwk" });
  const id = randomBytes(32);
  const cose = isoCBOR.encode(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, new Uint8Array(Buffer.from(publicKey.x, "base64url"))],
    [-3, new Uint8Array(Buffer.from(publicKey.y, "base64url"))],
  ]));
  let userHandle;
  let counter = 0;
  return {
    register(options) {
      userHandle = options.user.id;
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin }));
      const size = Buffer.alloc(2);
      size.writeUInt16BE(id.length);
      const authData = Buffer.concat([
        createHash("sha256").update(new URL(origin).hostname).digest(),
        Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), size, id, Buffer.from(cose),
      ]);
      return {
        id: id.toString("base64url"), rawId: id.toString("base64url"), type: "public-key",
        response: {
          clientDataJSON: clientData.toString("base64url"),
          attestationObject: Buffer.from(isoCBOR.encode(new Map([
            ["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)],
          ]))).toString("base64url"),
          transports: ["internal"],
        },
        clientExtensionResults: { credProps: { rk: true } }, authenticatorAttachment: "platform",
      };
    },
    login(options) {
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin }));
      const count = Buffer.alloc(4);
      count.writeUInt32BE(++counter);
      const authData = Buffer.concat([
        createHash("sha256").update(new URL(origin).hostname).digest(), Buffer.from([0x05]), count,
      ]);
      const signature = sign("sha256", Buffer.concat([
        authData, createHash("sha256").update(clientData).digest(),
      ]), keys.privateKey);
      return {
        id: id.toString("base64url"), rawId: id.toString("base64url"), type: "public-key",
        response: {
          clientDataJSON: clientData.toString("base64url"), authenticatorData: authData.toString("base64url"),
          signature: signature.toString("base64url"), userHandle,
        },
        clientExtensionResults: {}, authenticatorAttachment: "platform",
      };
    },
  };
}

async function runtime(env = {}, outbound) {
  const base = ".cloudflare/output/v0/workers/default/";
  const config = JSON.parse(await readFile(`${base}worker.config.json`, "utf8"));
  const modules = {};
  for (const [name, metadata] of Object.entries(config.manifest.modules)) {
    modules[name] = {
      ...metadata,
      contents: await readFile(`${base}bundle/${name}`, metadata.type === "esm" ? "utf8" : undefined),
    };
  }
  const integrationEnv = {
    GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "", GITHUB_APP_ID: "", GITHUB_APP_PRIVATE_KEY: "", LINEAR_CLIENT_ID: "", INTEGRATION_ENCRYPTION_KEY: "",
    ...env,
  };
  return new Miniflare({ unsafeInspectDurableObjects: true, workers: [{ config: {
    ...config,
    env: {
      ...config.env, PUBLIC_ORIGIN: { type: "text", value: origin },
      ...Object.fromEntries(Object.entries(integrationEnv).map(([key, value]) => [key, { type: "text", value }])),
    },
    manifest: { mainModule: config.manifest.mainModule, modules },
  }, ...(outbound ? { dev: { outboundService: { type: "fetcher", handler: outbound } } } : {}) }] });
}

function client(worker) {
  const cookies = new Map();
  return {
    cookies,
    async api(path, body, headers = {}) {
      const response = await worker.dispatchFetch(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin, Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";", 1)[0];
        const equal = pair.indexOf("=");
        cookies.set(pair.slice(0, equal), pair.slice(equal + 1));
      }
      return { status: response.status, data: await response.json() };
    },
    async callback(provider, state, code = "authorization-code") {
      return worker.dispatchFetch(`${origin}/api/integrations/callback/${provider}?${new URLSearchParams({ state, code })}`, {
        headers: { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") },
        redirect: "manual",
      });
    },
    async enroll(key) {
      const options = await this.api("/api/auth/register/options", {});
      assert.equal(options.status, 200);
      const response = await this.api("/api/auth/register/verify", { credential: key.register(options.data.options) });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      return response.data.user;
    },
    async upgrade(role, extra = {}) {
      return worker.dispatchFetch(`${origin}/device/${device}/${role}`, {
        headers: {
          Upgrade: "websocket", Origin: origin,
          ...(role === "client" ? { "Sec-WebSocket-Protocol": "oriel-client" } : {}),
          Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "), ...extra,
        },
      });
    },
  };
}

// Run npm run build first. Every test uses isolated real Worker/SQLite storage.
test("Passkeys, local pairing confirmation and ownership protect opaque terminal relay", { timeout: 30000 }, async () => {
  const worker = await runtime();
  const owner = client(worker);
  const stranger = client(worker);
  const anonymous = client(worker);
  const key = authenticator();
  try {
    assert.equal((await anonymous.upgrade("host")).status, 401);
    assert.equal((await anonymous.upgrade("client")).status, 401);
    assert.equal((await anonymous.api("/api/auth/register/options", {}, { Origin: "https://evil.example" })).status, 403);
    const user = await owner.enroll(key);
    await stranger.enroll(authenticator());
    const backup = authenticator();
    assert.deepEqual(await owner.enroll(backup), user);
    assert.equal((await owner.api("/api/auth/logout", {})).status, 200);
    assert.equal((await owner.api("/api/devices")).status, 401);

    const loginOptions = await owner.api("/api/auth/login/options", {});
    const credential = backup.login(loginOptions.data.options);
    const challengeCookie = [...owner.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const login = await owner.api("/api/auth/login/verify", { credential });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    assert.deepEqual(login.data.user, user);
    assert.equal((await owner.api("/api/auth/login/verify", { credential }, { Cookie: challengeCookie })).status, 400);
    const invalidOptions = await stranger.api("/api/auth/login/options", {});
    const invalid = key.login(invalidOptions.data.options);
    invalid.response.signature = randomBytes(72).toString("base64url");
    assert.equal((await stranger.api("/api/auth/login/verify", { credential: invalid })).status, 400);

    const daemon = client(worker);
    const hostHeaders = { Authorization: `Bearer ${hostToken}` };
    const started = await daemon.api("/api/pair/start", { device_id: device, name: "test-machine" }, hostHeaders);
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.status, "pending");
    const token = new URL(started.data.url).hash.slice("#pair=".length);
    assert.equal((await anonymous.api("/api/pair/claim", { token })).status, 401);
    assert.equal((await owner.api("/api/pair/inspect", { token })).data.device_id, device);
    assert.equal((await owner.api("/api/pair/claim", { token })).status, 200);
    assert.equal((await stranger.api("/api/pair/claim", { token })).status, 409);
    assert.equal((await owner.upgrade("client")).status, 403);
    assert.equal((await daemon.api(`/api/pair/${device}/confirm`, { user_id: "0".repeat(32) }, hostHeaders)).status, 409);
    const pending = await daemon.api(`/api/pair/${device}/status`, undefined, hostHeaders);
    assert.equal(pending.data.status, "confirmation");
    assert.deepEqual(pending.data.user, user);
    assert.equal((await daemon.api(`/api/pair/${device}/confirm`, { user_id: user.id }, hostHeaders)).status, 200);
    assert.equal((await daemon.api("/api/pair/start", { device_id: device, name: "test-machine" }, hostHeaders)).data.status, "paired");
    assert.equal((await daemon.api("/api/pair/start", { device_id: device, name: "stolen" }, { Authorization: `Bearer ${"c".repeat(64)}` })).status, 403);
    assert.equal((await stranger.upgrade("client")).status, 403);
    assert.equal((await owner.upgrade("client", { Origin: "https://evil.example" })).status, 403);
    assert.equal((await stranger.api("/api/devices")).data.devices.length, 0);
    assert.equal((await owner.api("/api/devices")).data.devices[0].device_id, device);

    const host = await daemon.upgrade("host", { ...hostHeaders, Cookie: "" });
    assert.equal(host.status, 101);
    host.webSocket.accept();
    const terminal = await owner.upgrade("client");
    assert.equal(terminal.status, 101);
    assert.equal(terminal.headers.get("Sec-WebSocket-Protocol"), "oriel-client");
    terminal.webSocket.accept();
    assert.equal((await anonymous.upgrade("host")).status, 401);
    assert.equal((await anonymous.upgrade("client")).status, 401);
    const atHost = new Promise((resolve, reject) => {
      host.webSocket.addEventListener("message", event => resolve(event.data), { once: true });
      host.webSocket.addEventListener("close", () => reject(new Error("unauthorized connection evicted host")), { once: true });
    });
    const input = new Uint8Array([0, 255, 27, 13, 128]);
    terminal.webSocket.send(input);
    assert.deepEqual(new Uint8Array(await atHost), input);
    const atClient = new Promise((resolve, reject) => {
      terminal.webSocket.addEventListener("message", event => resolve(event.data), { once: true });
      terminal.webSocket.addEventListener("close", () => reject(new Error("unauthorized connection evicted client")), { once: true });
    });
    host.webSocket.send("opaque terminal-independent frame");
    assert.equal(await atClient, "opaque terminal-independent frame");
  } finally {
    await worker.dispose();
  }
});

const hostHeaders = { Authorization: `Bearer ${hostToken}` };

async function pair(worker) {
  const owner = client(worker);
  const daemon = client(worker);
  const key = authenticator();
  const user = await owner.enroll(key);
  const start = await daemon.api("/api/pair/start", { device_id: device, name: "integration-host" }, hostHeaders);
  const token = new URL(start.data.url).hash.slice("#pair=".length);
  assert.equal((await owner.api("/api/pair/claim", { token })).status, 200);
  assert.equal((await daemon.api(`/api/pair/${device}/confirm`, { user_id: user.id }, hostHeaders)).status, 200);
  return { owner, daemon, user, key };
}

function githubFixture({ paginated = false } = {}) {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const repository = { installation_id: 101, repository_id: 501, owner: "octocat", name: "connected" };
  const fixture = {
    repository,
    management: true,
    organization: false,
    exchange: undefined,
    refresh: undefined,
    issues: undefined,
    expiresIn: undefined,
    revokeFailed: false,
    apiFailed: false,
    githubAuthorizationRevoked: false,
    oauthError: undefined,
    noInstallations: false,
    githubToken: "private-github-access",
    linearToken: "private-linear-access",
    refreshCount: 0,
    pkce: undefined,
    team: { team_id: "team", team_name: "Engineering", workspace_id: "workspace" },
    env: {
      GITHUB_CLIENT_ID: "github-client", GITHUB_CLIENT_SECRET: "github-secret", GITHUB_APP_ID: "123",
      INTEGRATION_ENCRYPTION_KEY: "CD".repeat(32),
      GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ format: "pem", type: "pkcs1" }),
      LINEAR_CLIENT_ID: "linear-client",
    },
    async fetch(request) {
      const url = new URL(request.url);
      if ((url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") ||
          (url.origin === "https://api.linear.app" && url.pathname === "/oauth/token")) {
        const fields = new URLSearchParams(await request.text());
        const linear = url.origin === "https://api.linear.app";
        if (fields.get("grant_type") === "refresh_token") {
          assert.equal(fields.get("refresh_token"), linear ? "private-linear-refresh" : "private-github-refresh");
          fixture.refreshCount++;
          if (fixture.refresh) await fixture.refresh();
          if (linear) fixture.linearToken = "rotated-linear-access";
          else fixture.githubToken = "rotated-github-access";
          return Response.json({ access_token: linear ? fixture.linearToken : fixture.githubToken,
            refresh_token: linear ? "rotated-linear-refresh" : "rotated-github-refresh", expires_in: 86400 });
        }
        if (linear) {
          assert.equal(fields.get("grant_type"), "authorization_code");
          assert.equal(fields.get("client_id"), "linear-client");
          assert.equal(fields.get("redirect_uri"), `${origin}/api/integrations/callback/linear`);
          assert.equal(createHash("sha256").update(fields.get("code_verifier")).digest("base64url"), fixture.pkce);
          assert.equal(fields.has("client_secret"), false);
        } else assert.equal(fields.get("client_secret"), "github-secret");
        if (fixture.exchange) await fixture.exchange();
        if (fixture.oauthError) return Response.json({ error: fixture.oauthError, error_description: "private-provider-diagnostic", access_token: "must-not-leak" });
        return Response.json({ access_token: linear ? fixture.linearToken : fixture.githubToken,
          refresh_token: linear ? "private-linear-refresh" : "private-github-refresh", expires_in: fixture.expiresIn ?? 86400 });
      }
      if (url.pathname === "/oauth/revoke" || url.pathname === "/applications/github-client/grant") {
        if (url.pathname === "/oauth/revoke") assert.ok((new URLSearchParams(await request.text())).get("token"));
        else {
          assert.equal(request.method, "DELETE");
          assert.equal(request.headers.get("Authorization"), `Basic ${Buffer.from("github-client:github-secret").toString("base64")}`);
          assert.ok((await request.json()).access_token);
        }
        return new Response(null, { status: fixture.revokeFailed ? 503 : 204 });
      }
      if (url.origin === "https://api.linear.app" && url.pathname === "/graphql") {
        assert.equal(request.headers.get("Authorization"), `Bearer ${fixture.linearToken}`);
        if (fixture.apiFailed) return Response.json({ errors: [{ message: "secret-provider-diagnostic" }] });
        const { query, variables } = await request.json();
        if (query.includes("teams(")) return Response.json({ data: { organization: { id: "workspace" },
          teams: { nodes: [{ id: "team", name: "Engineering" }], pageInfo: { hasNextPage: false, endCursor: null } } } });
        assert.equal(variables.id, "team");
        if (fixture.issues) await fixture.issues();
        return Response.json({ data: { team: { issues: { nodes: [{ identifier: "ENG-42", title: "Linear issue" }] } } } });
      }
      assert.equal(url.origin, "https://api.github.com");
      if (url.pathname === "/app/installations/101/access_tokens") {
        const jwt = request.headers.get("Authorization").slice("Bearer ".length);
        const [header, payload, signature] = jwt.split(".");
        assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, "base64url")), true);
        const claims = JSON.parse(Buffer.from(payload, "base64url"));
        assert.equal(claims.iss, "123");
        assert.ok(claims.exp > Math.floor(Date.now() / 1000) && claims.exp - claims.iat <= 600);
        assert.deepEqual(await request.json(), {
          repository_ids: [501],
          permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" },
        });
        return Response.json({ token: "limited-installation-token", expires_at: new Date(Date.now() + 3600000).toISOString() });
      }
      if (url.pathname === "/repos/octocat/connected/issues") {
        if (fixture.apiFailed) return new Response("private-provider-diagnostic", { status: 500 });
        assert.equal(request.headers.get("Authorization"), "Bearer limited-installation-token");
        return Response.json([{ number: 1, title: "Pull request", pull_request: {} },
          ...Array.from({ length: 25 }, (_, index) => ({ number: index + 2, title: `Issue ${index + 2}` }))]);
      }
      assert.equal(request.headers.get("Authorization"), `Bearer ${fixture.githubToken}`);
      if (fixture.githubAuthorizationRevoked) return new Response(null, { status: 401 });
      if (url.pathname === "/user/installations") {
        if (fixture.noInstallations) return Response.json({ installations: [] });
        const account = { id: 7, login: "octocat", type: fixture.organization ? "Organization" : "User" };
        if (paginated && url.searchParams.get("page") === "1") {
          return Response.json({ installations: Array.from({ length: 100 }, (_, index) => ({ id: index + 1, app_id: 999, account })) });
        }
        return Response.json({ installations: [{ id: 101, app_id: 123, account }] });
      }
      const repos = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
      if (repos) {
        if (repos[1] !== "101") return Response.json({ repositories: [] });
        if (paginated && url.searchParams.get("page") === "1") {
          return Response.json({ repositories: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1, name: `repo-${index}`, owner: { login: "octocat" },
          })) });
        }
        return Response.json({ repositories: [{ id: 501, name: "connected", owner: { login: "octocat" } }] });
      }
      if (url.pathname === "/user") return Response.json({ id: fixture.management ? 7 : 8 });
      if (url.pathname === "/user/memberships/orgs/octocat") return Response.json({ role: fixture.management ? "admin" : "member", state: "active" });
      assert.fail(`Unexpected provider request: ${url.pathname}`);
    },
  };
  return fixture;
}
async function authorize(owner, fixture, provider) {
  const started = await owner.api(`/api/integrations/${provider}/start`, {});
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const url = new URL(started.data.url);
  assert.equal(url.origin, provider === "github" ? "https://github.com" : "https://linear.app");
  assert.equal(url.searchParams.get("redirect_uri"), `${origin}/api/integrations/callback/${provider}`);
  if (provider === "linear") {
    fixture.pkce = url.searchParams.get("code_challenge");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  }
  return url.searchParams.get("state");
}

async function connect(owner, fixture, provider) {
  const state = await authorize(owner, fixture, provider);
  assert.equal((await owner.callback(provider, state)).headers.get("Location"), `${origin}/#connected=${provider}`);
  const target = provider === "github" ? { installation_id: 101, repository_id: 501 } : { team_id: "team" };
  assert.equal((await owner.api(`/api/integrations/${provider}/select`, target)).status, 200);
  return state;
}

async function unseal(ciphertext, user, provider, purpose = "credentials") {
  const sealed = JSON.parse(ciphertext);
  const key = await crypto.subtle.importKey("raw", Buffer.from("CD".repeat(32), "hex"), "AES-GCM", false, ["decrypt"]);
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(sealed.iv, "base64"),
    additionalData: Buffer.from(JSON.stringify([user, provider, purpose])) }, key, Buffer.from(sealed.data, "base64"));
  return JSON.parse(Buffer.from(bytes).toString());
}

test("Account connections serve both owned devices, keep credentials encrypted across eviction and logout", { timeout: 60000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  try {
    const { owner, daemon, user } = await pair(worker);
    const other = "d".repeat(32);
    const start = await daemon.api("/api/pair/start", { device_id: other, name: "second" }, hostHeaders);
    const token = new URL(start.data.url).hash.slice("#pair=".length);
    await owner.api("/api/pair/claim", { token });
    assert.equal((await daemon.api(`/api/pair/${other}/confirm`, { user_id: user.id }, hostHeaders)).status, 200);
    const stranger = client(worker);
    await stranger.enroll(authenticator());
    for (const provider of ["github", "linear"]) await connect(owner, fixture, provider);
    const expected = { github: fixture.repository, linear: fixture.team };
    assert.deepEqual((await daemon.api(`/api/integrations/${device}`, undefined, hostHeaders)).data, expected);
    assert.deepEqual((await daemon.api(`/api/integrations/${other}`, undefined, hostHeaders)).data, expected);
    assert.deepEqual((await stranger.api("/api/integrations")).data, {
      github: null, linear: null, choices: { github: [], linear: [] },
      authorization: { github: null, linear: null },
    });
    assert.equal((await stranger.api("/api/integrations/github/select", { installation_id: 101, repository_id: 501 })).status, 409);
    assert.equal((await stranger.api(`/api/integrations/${device}`, undefined, { Authorization: `Bearer ${"e".repeat(64)}` })).status, 403);
    assert.equal((await client(worker).api(`/api/integrations/${device}`)).status, 401);
    assert.equal((await owner.api("/api/integrations/github/start", {}, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await daemon.api(`/api/integrations/${device}/github/start`, {}, hostHeaders)).status, 404);
    const browser = (await owner.api("/api/integrations")).data;
    assert.deepEqual(browser, { ...expected, choices: { github: [], linear: [] }, authorization: { github: null, linear: null } });
    const issued = await daemon.api(`/api/integrations/${other}/github/token`, {}, hostHeaders);
    assert.deepEqual(issued.data.repository, fixture.repository);
    assert.equal(issued.data.token, "limited-installation-token");
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    const rows = await storage.exec("SELECT * FROM account_integrations");
    for (const row of rows) {
      assert.equal(row.user_id, user.id);
      assert.equal(JSON.stringify(row).includes("private-"), false);
      assert.equal((await unseal(row.active, user.id, row.provider)).access_token, row.provider === "github" ? fixture.githubToken : fixture.linearToken);
      await assert.rejects(unseal(row.active, "foreign-account", row.provider));
      await assert.rejects(unseal(row.active, user.id, row.provider === "github" ? "linear" : "github"));
    }
    const issues = (await owner.api("/api/integrations/issues")).data;
    assert.deepEqual(issues.linear, { team: fixture.team, issues: [{ identifier: "ENG-42", title: "Linear issue" }] });
    assert.deepEqual(issues.github.issues, Array.from({ length: 20 }, (_, index) => ({ number: index + 2, title: `Issue ${index + 2}` })));
    assert.deepEqual((await daemon.api(`/api/integrations/${device}/issues`, undefined, hostHeaders)).data, issues);
    assert.equal(JSON.stringify([browser, issued.data, issues]).includes("private-"), false);
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    assert.deepEqual((await owner.api("/api/integrations")).data, browser);
    assert.deepEqual((await daemon.api(`/api/integrations/${other}/issues`, undefined, hostHeaders)).data, issues);
    await owner.api("/api/auth/logout", {});
    assert.deepEqual((await daemon.api(`/api/integrations/${device}`, undefined, hostHeaders)).data, expected);
  } finally { await worker.dispose(); }
});

test("OAuth choices survive eviction, reject fabricated targets and recheck GitHub installation management", { timeout: 60000 }, async () => {
  const fixture = githubFixture({ paginated: true });
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  try {
    const { owner, daemon } = await pair(worker);
    const state = await authorize(owner, fixture, "github");
    await owner.callback("github", state);
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    const choices = (await owner.api("/api/integrations")).data.choices.github;
    assert.ok(choices.some(repository => JSON.stringify(repository) === JSON.stringify(fixture.repository)));
    assert.ok(choices.every(repository => repository.installation_id === 101));
    assert.equal((await owner.callback("github", state)).status, 409);
    const path = "/api/integrations/github/select";
    assert.equal((await owner.api(path, { installation_id: 1, repository_id: 501 })).status, 403);
    assert.equal((await owner.api(path, { installation_id: 101, repository_id: 9999 })).status, 403);
    fixture.management = false;
    assert.equal((await owner.api(path, { installation_id: 101, repository_id: 501 })).status, 403);
    fixture.organization = true;
    assert.equal((await owner.api(path, { installation_id: 101, repository_id: 501 })).status, 403);
    fixture.management = true;
    assert.equal((await owner.api(path, { installation_id: 101, repository_id: 501 })).status, 200);
    await connect(owner, fixture, "linear");
    const pending = await authorize(owner, fixture, "linear");
    await owner.callback("linear", pending);
    assert.deepEqual((await daemon.api(`/api/integrations/${device}`, undefined, hostHeaders)).data.linear, fixture.team);
    assert.equal((await owner.api("/api/integrations/linear/select", { team_id: "foreign", team_name: "Forged", workspace_id: "foreign" })).status, 403);
    assert.equal((await owner.api("/api/integrations/linear/select", { team_id: "team", team_name: "Forged", workspace_id: "foreign" })).status, 200);
    assert.deepEqual((await owner.api("/api/integrations")).data.linear, fixture.team);
  } finally { await worker.dispose(); }
});

test("OAuth binds the exact live session and rejects expired, superseded and logout-racing exchanges", { timeout: 30000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  let release;
  try {
    const { owner, key } = await pair(worker);
    const stranger = client(worker);
    await stranger.enroll(authenticator());
    const state = await authorize(owner, fixture, "github");
    assert.equal((await stranger.callback("github", state)).status, 403);
    const secondSession = client(worker);
    const login = await secondSession.api("/api/auth/login/options", {});
    assert.equal((await secondSession.api("/api/auth/login/verify", { credential: key.login(login.data.options) })).status, 200);
    assert.equal((await secondSession.callback("github", state)).status, 403);
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    await storage.exec("UPDATE account_oauth SET expires_at = ? WHERE state = ?", Math.floor(Date.now() / 1000) - 1, state);
    assert.equal((await owner.callback("github", state)).status, 410);
    const first = await authorize(owner, fixture, "github");
    const replacement = await authorize(owner, fixture, "github");
    assert.equal((await owner.callback("github", first)).status, 409);
    let entered;
    const fetching = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    fixture.exchange = async () => { entered(); await gate; };
    const pending = owner.callback("github", replacement);
    await fetching;
    const newest = await authorize(owner, fixture, "github");
    release();
    assert.equal((await pending).headers.get("Location"), `${origin}/#connection-error=authorization-failed`);
    let enteredAgain;
    const fetchingAgain = new Promise(resolve => { enteredAgain = resolve; });
    const gateAgain = new Promise(resolve => { release = resolve; });
    fixture.exchange = async () => { enteredAgain(); await gateAgain; };
    const revoked = owner.callback("github", newest);
    await fetchingAgain;
    const oldCookies = [...owner.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    await owner.api("/api/auth/logout", {});
    release();
    assert.equal((await revoked).headers.get("Location"), `${origin}/#connection-error=authorization-failed`);
    assert.equal((await worker.dispatchFetch(`${origin}/api/integrations/callback/github?state=${newest}&code=secret`, { headers: { Cookie: oldCookies } })).status, 401);
    const afterLogout = (await secondSession.api("/api/integrations")).data;
    assert.equal(afterLogout.github, null);
    assert.deepEqual(afterLogout.choices.github, []);
    assert.equal(afterLogout.authorization.github.status, "failed");
  } finally { release?.(); await worker.dispose(); }
});

test("Relay exchanges PKCE and rotates both providers; disconnect prevents refresh resurrection", { timeout: 60000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  let release;
  try {
    const { owner, daemon, user } = await pair(worker);
    const state = await authorize(owner, fixture, "linear");
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    const flow = (await storage.exec("SELECT * FROM account_oauth WHERE state = ?", state))[0];
    const verifier = await unseal(flow.verifier, user.id, "linear", "pkce");
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), fixture.pkce);
    assert.equal(flow.verifier.includes(verifier), false);
    fixture.expiresIn = 1;
    await owner.callback("linear", state);
    assert.equal((await owner.api("/api/integrations/linear/select", { team_id: "team" })).status, 200);
    assert.equal(fixture.refreshCount, 1);
    let row = (await storage.exec("SELECT * FROM account_integrations WHERE provider = 'linear'"))[0];
    let value = await unseal(row.active, user.id, "linear");
    assert.equal(value.access_token, "rotated-linear-access");
    assert.equal(value.refresh_token, "rotated-linear-refresh");
    assert.ok(value.expires_at > Math.floor(Date.now() / 1000) + 3600);
    await connect(owner, fixture, "github");
    assert.equal(fixture.refreshCount, 2);
    row = (await storage.exec("SELECT * FROM account_integrations WHERE provider = 'github'"))[0];
    assert.equal((await unseal(row.active, user.id, "github")).refresh_token, "rotated-github-refresh");
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    assert.equal((await daemon.api(`/api/integrations/${device}/issues`, undefined, hostHeaders)).status, 200);
    assert.equal(fixture.refreshCount, 2);
    fixture.expiresIn = 130;
    fixture.linearToken = "private-linear-access";
    await connect(owner, fixture, "linear");
    row = (await storage.exec("SELECT * FROM account_integrations WHERE provider = 'linear'"))[0];
    value = await unseal(row.active, user.id, "linear");
    value.expires_at = Math.floor(Date.now() / 1000) - 1;
    const key = await crypto.subtle.importKey("raw", Buffer.from("CD".repeat(32), "hex"), "AES-GCM", false, ["encrypt"]);
    const iv = randomBytes(12);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: Buffer.from(JSON.stringify([user.id, "linear", "credentials"])) }, key, Buffer.from(JSON.stringify(value)));
    await storage.exec("UPDATE account_integrations SET active = ? WHERE provider = 'linear'", JSON.stringify({ iv: iv.toString("base64"), data: Buffer.from(encrypted).toString("base64") }));
    let entered;
    const fetching = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    fixture.refresh = async () => { entered(); await gate; };
    const pending = daemon.api(`/api/integrations/${device}/issues`, undefined, hostHeaders);
    await fetching;
    assert.deepEqual((await owner.api("/api/integrations/linear/disconnect", {})).data, { ok: true, revoked: true });
    release();
    assert.equal((await pending).status, 409);
    assert.equal((await owner.api("/api/integrations")).data.linear, null);
    assert.deepEqual(await storage.exec("SELECT * FROM account_integrations WHERE provider = 'linear'"), []);
    fixture.revokeFailed = true;
    assert.deepEqual((await owner.api("/api/integrations/github/disconnect", {})).data, { ok: true, revoked: false });
    assert.equal((await daemon.api(`/api/integrations/${device}/github/token`, {}, hostHeaders)).status, 409);
    assert.deepEqual((await daemon.api(`/api/integrations/${device}/issues`, undefined, hostHeaders)).data, { github: null, linear: null });
  } finally { release?.(); await worker.dispose(); }
});

test("Interrupted exchanges require explicit retry, disconnect invalidates callbacks, and errors are sanitized", { timeout: 30000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  let release;
  try {
    const { owner } = await pair(worker);
    const state = await authorize(owner, fixture, "github");
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    await storage.exec("UPDATE account_oauth SET phase = 'processing' WHERE state = ?", state);
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    const interrupted = await owner.callback("github", state);
    assert.equal(interrupted.status, 409);
    assert.match((await interrupted.json()).error, /retry authorization in Web/);
    const retry = await authorize(owner, fixture, "github");
    let entered;
    const fetching = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    fixture.exchange = async () => { entered(); await gate; };
    const pending = owner.callback("github", retry);
    await fetching;
    assert.equal((await owner.api("/api/integrations/github/disconnect", {})).status, 200);
    release();
    assert.equal((await pending).headers.get("Location"), `${origin}/#connection-error=authorization-failed`);
    assert.equal((await owner.callback("github", retry)).status, 409);
    fixture.exchange = undefined;
    await connect(owner, fixture, "linear");
    fixture.apiFailed = true;
    const failed = await owner.api("/api/integrations/issues");
    assert.equal(failed.status, 502);
    assert.equal(JSON.stringify(failed.data).includes("secret-provider"), false);
  } finally { release?.(); await worker.dispose(); }
});

test("Missing provider encryption configuration leaves pairing and empty connections usable", { timeout: 30000 }, async () => {
  const worker = await runtime();
  try {
    const { owner, daemon } = await pair(worker);
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", { name: "accounts" });
    await storage.exec("CREATE TABLE github_bindings (device_id TEXT PRIMARY KEY, installation_id INTEGER, repository_id INTEGER, owner TEXT, name TEXT)");
    await storage.exec("INSERT INTO github_bindings VALUES (?, 101, 501, 'octocat', 'obsolete')", device);
    await storage.exec("CREATE TABLE linear_bindings (device_id TEXT PRIMARY KEY, team_id TEXT, team_name TEXT, workspace_id TEXT)");
    await storage.exec("INSERT INTO linear_bindings VALUES (?, 'old-team', 'Old local selection', 'old-workspace')", device);
    await storage.exec("CREATE TABLE integration_flows (state TEXT PRIMARY KEY)");
    await storage.exec("INSERT INTO integration_flows VALUES (?)", "f".repeat(64));
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    for (const provider of ["github", "linear"]) {
      const result = await owner.api(`/api/integrations/${provider}/start`, {});
      assert.equal(result.status, 503);
      assert.match(result.data.error, /INTEGRATION_ENCRYPTION_KEY/);
    }
    assert.deepEqual((await owner.api("/api/integrations")).data, {
      github: null, linear: null, choices: { github: [], linear: [] },
      authorization: { github: null, linear: null },
    });
    assert.deepEqual((await daemon.api(`/api/integrations/${device}`, undefined, hostHeaders)).data, { github: null, linear: null });
    assert.deepEqual((await daemon.api(`/api/pair/${device}/status`, undefined, hostHeaders)).data, { status: "paired" });
  } finally { await worker.dispose(); }
});

test("Disconnecting a provider invalidates an issue snapshot waiting on the other provider", { timeout: 30000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  let release;
  try {
    const { owner, daemon } = await pair(worker);
    await connect(owner, fixture, "github");
    await connect(owner, fixture, "linear");
    let entered;
    const fetching = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    fixture.issues = async () => { entered(); await gate; };
    const pending = daemon.api(`/api/integrations/${device}/issues`, undefined, hostHeaders);
    await fetching;
    assert.deepEqual((await owner.api("/api/integrations/github/disconnect", {})).data, { ok: true, revoked: true });
    release();
    assert.equal((await pending).status, 409);
  } finally { release?.(); await worker.dispose(); }
});

test("Revoked GitHub user authorization blocks new installation tokens", { timeout: 30000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  try {
    const { owner, daemon } = await pair(worker);
    await connect(owner, fixture, "github");
    fixture.githubAuthorizationRevoked = true;
    const denied = await daemon.api(`/api/integrations/${device}/github/token`, {}, hostHeaders);
    assert.equal(denied.status, 502);
    assert.equal(denied.data.token, undefined);
  } finally { await worker.dispose(); }
});

test("Authorization outcomes distinguish rejected credentials, failed target access and empty repository choices", { timeout: 30000 }, async () => {
  const fixture = githubFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  try {
    const owner = client(worker);
    await owner.enroll(authenticator());
    const snapshot = async () => (await owner.api("/api/integrations")).data;
    fixture.oauthError = "incorrect_client_credentials";
    await owner.callback("github", await authorize(owner, fixture, "github"));
    assert.deepEqual((await snapshot()).authorization.github, { status: "failed", step: "exchange", error: "incorrect_client_credentials" });
    await worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    assert.equal((await snapshot()).authorization.github.error, "incorrect_client_credentials");
    fixture.oauthError = "secret-untrusted-provider-error";
    await owner.callback("github", await authorize(owner, fixture, "github"));
    assert.deepEqual((await snapshot()).authorization.github, { status: "failed", step: "exchange", error: "invalid_token_response" });
    assert.doesNotMatch(JSON.stringify(await snapshot()), /private-provider|must-not-leak|secret-untrusted/);
    fixture.oauthError = undefined;
    fixture.githubAuthorizationRevoked = true;
    await owner.callback("github", await authorize(owner, fixture, "github"));
    assert.deepEqual((await snapshot()).authorization.github, { status: "failed", step: "targets", error: "http_401" });
    fixture.githubAuthorizationRevoked = false;
    fixture.noInstallations = true;
    await owner.callback("github", await authorize(owner, fixture, "github"));
    const empty = await snapshot();
    assert.deepEqual(empty.authorization.github, { status: "ready" });
    assert.deepEqual(empty.choices.github, []);
    assert.equal(empty.github, null);
    fixture.noInstallations = false;
    await connect(owner, fixture, "github");
    const connected = await snapshot();
    assert.equal(connected.authorization.github, null);
    assert.equal(connected.github.repository_id, fixture.repository.repository_id);
    const stranger = client(worker);
    await stranger.enroll(authenticator());
    assert.equal((await stranger.api("/api/integrations")).data.authorization.github, null);
  } finally { await worker.dispose(); }
});
