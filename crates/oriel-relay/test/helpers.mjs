import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { Miniflare } from "miniflare";

const origin = "https://oriel.example";
const device = "a".repeat(32);
const hostToken = "b".repeat(64);

// A software authenticator signs real P-256 WebAuthn responses. No auth API mocks.
function authenticator(publicOrigin = origin) {
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
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: publicOrigin }));
      const size = Buffer.alloc(2);
      size.writeUInt16BE(id.length);
      const authData = Buffer.concat([
        createHash("sha256").update(new URL(publicOrigin).hostname).digest(),
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
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: publicOrigin }));
      const count = Buffer.alloc(4);
      count.writeUInt32BE(++counter);
      const authData = Buffer.concat([
        createHash("sha256").update(new URL(publicOrigin).hostname).digest(), Buffer.from([0x05]), count,
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

function client(worker, publicOrigin = origin) {
  const cookies = new Map();
  return {
    origin: publicOrigin,
    cookies,
    async api(path, body, headers = {}) {
      const response = await worker.dispatchFetch(`${publicOrigin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: publicOrigin, Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
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
      return worker.dispatchFetch(`${publicOrigin}/api/integrations/callback/${provider}?${new URLSearchParams({ state, code })}`, {
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
      return worker.dispatchFetch(`${publicOrigin}/device/${device}/${role}`, {
        headers: {
          Upgrade: "websocket", Origin: publicOrigin,
          ...(role === "client" ? { "Sec-WebSocket-Protocol": "oriel-client" } : {}),
          Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "), ...extra,
        },
      });
    },
  };
}

const hostHeaders = { Authorization: `Bearer ${hostToken}` };

async function pair(worker, publicOrigin = origin) {
  const owner = client(worker, publicOrigin);
  const daemon = client(worker, publicOrigin);
  const key = authenticator(publicOrigin);
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
    publicOrigin: origin,
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
    tokenStatus: undefined,
    githubToken: "private-github-access",
    linearToken: "private-linear-access",
    refreshCount: 0,
    pkce: undefined,
    team: { team_id: "team", team_name: "Engineering", workspace_id: "workspace" },
    linkedIssues: [{
      id: "linked-42", identifier: "ENG-42", title: "Implement the GitHub request", url: "https://linear.app/example/issue/ENG-42",
      description: "HOW: implement the requested change; human approval remains separate.",
      state: { name: "Todo", type: "unstarted" }, team: { id: "team" },
      attachments: [{ url: "https://github.com/octocat/connected/issues/42" }],
    }],
    issuePageSize: 100,
    attachmentPageSize: 100,
    linkedFetch: undefined,
    linkedRequests: [],
    githubRequests: 0,
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
          assert.equal(fields.get("redirect_uri"), `${fixture.publicOrigin}/api/integrations/callback/linear`);
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
        if (query.includes("attachments(")) {
          fixture.linkedRequests.push({ query, variables });
          if (fixture.linkedFetch) await fixture.linkedFetch({ query, variables });
          assert.equal(variables.prefix.startsWith("https://github.com/"), true);
          const relevant = issue => issue.attachments.filter(attachment =>
            attachment.url.toLowerCase().startsWith(variables.prefix.toLowerCase()));
          const page = (nodes, after, size) => {
            const start = after ? Number(after) : 0;
            const end = Math.min(nodes.length, start + size);
            return { nodes: nodes.slice(start, end), pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? String(end) : null } };
          };
          if (query.includes("issue(id:")) {
            const issue = fixture.linkedIssues.find(issue => issue.id === variables.id);
            return Response.json({ data: { issue: issue ? {
              team: issue.team, attachments: page(relevant(issue), variables.after, fixture.attachmentPageSize),
            } : null } });
          }
          assert.equal(variables.team, fixture.team.team_id);
          const candidates = fixture.linkedIssues.filter(issue => issue.team.id === variables.team && relevant(issue).length);
          const issues = page(candidates, variables.after, fixture.issuePageSize);
          issues.nodes = issues.nodes.map(issue => ({ ...issue, attachments: page(relevant(issue), null, fixture.attachmentPageSize) }));
          return Response.json({ data: { issues } });
        }
        assert.equal(variables.id, "team");
        if (fixture.issues) await fixture.issues();
        return Response.json({ data: { team: { issues: { nodes: [{ identifier: "ENG-42", title: "Linear issue" }] } } } });
      }
      assert.equal(url.origin, "https://api.github.com");
      fixture.githubRequests++;
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
        if (fixture.tokenStatus) return Response.json({ message: "private-provider-diagnostic", token: "must-not-leak-token" }, { status: fixture.tokenStatus });
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
  assert.equal(url.searchParams.get("redirect_uri"), `${owner.origin}/api/integrations/callback/${provider}`);
  if (provider === "linear") {
    fixture.pkce = url.searchParams.get("code_challenge");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  }
  return url.searchParams.get("state");
}

async function connect(owner, fixture, provider) {
  const state = await authorize(owner, fixture, provider);
  assert.equal((await owner.callback(provider, state)).headers.get("Location"), `${owner.origin}/#connected=${provider}`);
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

export { origin, device, hostToken, hostHeaders, authenticator, runtime, client, pair, githubFixture, authorize, connect, unseal };
