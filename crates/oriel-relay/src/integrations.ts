export interface IntegrationEnv {
  PUBLIC_ORIGIN: string;
  INTEGRATION_ENCRYPTION_KEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  LINEAR_CLIENT_ID?: string;
}

type Device = { device_id: string; name: string; user_id: string; host_hash: string };
type Session = { hash: string; user: { id: string; display_name: string } };
type Provider = "github" | "linear";
type Repository = { installation_id: number; repository_id: number; owner: string; name: string };
type Team = { team_id: string; team_name: string; workspace_id: string };
type Installation = { id: number; app_id: number; account: { id: number; login: string; type: string } | null };
type Credential = { access_token: string; refresh_token?: string; expires_at?: number; refresh_expires_at?: number };
type Connection = {
  user_id: string; provider: Provider; generation: string; active: string | null; target: string | null;
  pending: string | null; choices: string | null; active_status: string; pending_status: string;
};
type Flow = { state: string; user_id: string; provider: Provider; session_hash: string; expires_at: number; phase: string; verifier: string | null };
type Auth = {
  host(request: Request, id: string): Promise<Device>;
  session(request: Request): Promise<Session>;
  liveSession(session: Session): void;
  body(request: Request): Promise<Record<string, unknown>>;
  fail(status: number, message: string): never;
  json(data: unknown, status?: number): Response;
};
const SECRET = /^[a-f0-9]{64}$/;
const PERMISSIONS = { contents: "write", issues: "write", pull_requests: "write", metadata: "read" };
const TOKEN_ERRORS = ["incorrect_client_credentials", "bad_verification_code", "redirect_uri_mismatch", "access_denied", "invalid_grant", "invalid_client"];
const now = () => Math.floor(Date.now() / 1000);
const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");

/** Only authenticated target metadata is plaintext; credentials and PKCE are AES-GCM ciphertext. */
export class Integrations {
  private readonly refreshes = new Map<string, Promise<{ credential: Credential; ciphertext: string }>>();

  constructor(private readonly sql: SqlStorage, private readonly env: IntegrationEnv, private readonly auth: Auth) {
    // Device-local credentials cannot be attributed unambiguously to an account. Reconnect in Web.
    sql.exec(`
      DROP TABLE IF EXISTS integration_flows;
      DROP TABLE IF EXISTS github_bindings;
      DROP TABLE IF EXISTS linear_bindings;
      CREATE TABLE IF NOT EXISTS account_integrations (
        user_id TEXT NOT NULL, provider TEXT NOT NULL, generation TEXT NOT NULL,
        active TEXT, target TEXT, pending TEXT, choices TEXT,
        active_status TEXT NOT NULL DEFAULT 'ready', pending_status TEXT NOT NULL DEFAULT 'ready',
        PRIMARY KEY(user_id, provider)
      );
      CREATE TABLE IF NOT EXISTS account_oauth (
        state TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL,
        session_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, phase TEXT NOT NULL, verifier TEXT,
        UNIQUE(user_id, provider)
      );
      UPDATE account_oauth SET phase = 'interrupted', verifier = NULL WHERE phase IN ('preparing', 'processing');
      UPDATE account_integrations SET active_status = 'uncertain' WHERE active_status = 'refreshing';
      UPDATE account_integrations SET pending_status = 'uncertain' WHERE pending_status = 'refreshing';
    `);
  }

  static daemonRoute(request: Request): boolean {
    const path = new URL(request.url).pathname;
    return request.method === "GET" && /^\/api\/integrations\/[a-f0-9]{32}(?:\/issues)?$/.test(path) ||
      request.method === "POST" && /^\/api\/integrations\/[a-f0-9]{32}\/github\/token$/.test(path);
  }

  private config(provider: Provider): void {
    if (!/^[a-fA-F0-9]{64}$/.test(this.env.INTEGRATION_ENCRYPTION_KEY ?? "")) this.auth.fail(503, "INTEGRATION_ENCRYPTION_KEY is not configured as a 32-byte hex key");
    const required = provider === "github"
      ? ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"] as const
      : ["LINEAR_CLIENT_ID"] as const;
    for (const key of required) if (!this.env[key]?.trim()) this.auth.fail(503, `${key} is not configured`);
  }

  private async cryptKey(): Promise<CryptoKey> {
    const bytes = Uint8Array.from(this.env.INTEGRATION_ENCRYPTION_KEY!.match(/../g)!, byte => parseInt(byte, 16));
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  private async encrypt(user: string, provider: Provider, purpose: string, value: unknown): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(JSON.stringify([user, provider, purpose])) }, await this.cryptKey(), encoder.encode(JSON.stringify(value)));
    return JSON.stringify({ iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...new Uint8Array(data))) });
  }

  private async decrypt<T>(user: string, provider: Provider, purpose: string, ciphertext: string): Promise<T> {
    const sealed = JSON.parse(ciphertext) as { iv: string; data: string };
    const bytes = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(sealed.iv), additionalData: encoder.encode(JSON.stringify([user, provider, purpose])) }, await this.cryptKey(), bytes(sealed.data));
    return JSON.parse(new TextDecoder().decode(data)) as T;
  }

  private row(user: string, provider: Provider): Connection | undefined {
    return this.sql.exec<Connection>("SELECT * FROM account_integrations WHERE user_id = ? AND provider = ?", user, provider).toArray()[0];
  }

  private connections(user: string): { github: Repository | null; linear: Team | null } {
    return { github: JSON.parse(this.row(user, "github")?.target ?? "null"), linear: JSON.parse(this.row(user, "linear")?.target ?? "null") };
  }

  private authorization(user: string, provider: Provider): { status: string; step?: string; error?: string } | null {
    const flow = this.sql.exec<{ phase: string }>("SELECT phase FROM account_oauth WHERE user_id = ? AND provider = ?", user, provider).toArray()[0];
    if (!flow) return null;
    const [status, step, error] = flow.phase.split(":");
    return { status, ...(step ? { step } : {}), ...(error ? { error } : {}) };
  }

  private liveDevice(device: Device): void {
    const current = this.sql.exec<Device>("SELECT * FROM devices WHERE device_id = ?", device.device_id).toArray()[0];
    if (!current || current.user_id !== device.user_id || current.host_hash !== device.host_hash) this.auth.fail(403, "Device ownership changed");
  }

  private current(connection: Connection, slot: "active" | "pending", check: () => void): Connection {
    check();
    const current = this.row(connection.user_id, connection.provider);
    if (!current || current.generation !== connection.generation || current[slot] !== connection[slot]) this.auth.fail(409, "Provider connection changed");
    return current;
  }

  private flow(state: string | null, provider: Provider, session: Session, phase: string): Flow {
    this.auth.liveSession(session);
    if (!state || !SECRET.test(state)) this.auth.fail(400, "Invalid connection state");
    const row = this.sql.exec<Flow>("SELECT * FROM account_oauth WHERE state = ? AND provider = ?", state, provider).toArray()[0];
    if (!row) this.auth.fail(409, "Connection state is invalid or superseded");
    if (row.user_id !== session.user.id || row.session_hash !== session.hash) this.auth.fail(403, "Connection belongs to another session");
    if (row.expires_at <= now()) this.auth.fail(410, "Connection expired; restart authorization in Web");
    if (row.phase !== phase) this.auth.fail(409, row.phase === "interrupted" ? "Authorization exchange interrupted; retry authorization in Web" : "Connection state was already used");
    return row;
  }

  private redirectUri(provider: Provider): string { return `${this.env.PUBLIC_ORIGIN}/api/integrations/callback/${provider}`; }
  private redirect(fragment: string): Response {
    return new Response(null, { status: 303, headers: { Location: `${this.env.PUBLIC_ORIGIN}/${fragment}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const callback = /^\/api\/integrations\/callback\/(github|linear)$/.exec(url.pathname);
    if (callback && request.method === "GET") return this.callback(request, callback[1] as Provider, url);
    if (Integrations.daemonRoute(request)) {
      const [, id, action] = /^\/api\/integrations\/([a-f0-9]{32})(?:\/(issues|github\/token))?$/.exec(url.pathname)!;
      const device = await this.auth.host(request, id);
      const check = () => this.liveDevice(device);
      check();
      if (!action) return this.auth.json(this.connections(device.user_id));
      if (action === "issues") return this.auth.json(await this.issues(device.user_id, check));
      await this.auth.body(request);
      check();
      return this.auth.json(await this.installationToken(device.user_id, check));
    }
    const browser = /^(?:\/api\/integrations(?:\/issues)?|\/api\/integrations\/(github|linear)\/(start|select|disconnect))$/.exec(url.pathname);
    if (!browser || (browser[2] ? request.method !== "POST" : request.method !== "GET")) this.auth.fail(404, "Not found");
    const session = await this.auth.session(request);
    const check = () => this.auth.liveSession(session);
    check();
    if (!browser[2]) {
      if (url.pathname.endsWith("/issues")) return this.auth.json(await this.issues(session.user.id, check));
      return this.auth.json({ ...this.connections(session.user.id), choices: {
        github: JSON.parse(this.row(session.user.id, "github")?.choices ?? "[]"),
        linear: JSON.parse(this.row(session.user.id, "linear")?.choices ?? "[]"),
      }, authorization: {
        github: this.authorization(session.user.id, "github"),
        linear: this.authorization(session.user.id, "linear"),
      } });
    }
    const body = await this.auth.body(request);
    check();
    const provider = browser[1] as Provider;
    this.config(provider);
    if (browser[2] === "start") return this.start(session, provider);
    if (browser[2] === "disconnect") return this.disconnect(session.user.id, provider, check);
    return this.select(session.user.id, provider, body, check);
  }

  private async start(session: Session, provider: Provider): Promise<Response> {
    const state = random();
    this.sql.exec("INSERT INTO account_integrations (user_id, provider, generation) VALUES (?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET pending = NULL, choices = NULL, pending_status = 'ready'", session.user.id, provider, random());
    this.sql.exec("INSERT INTO account_oauth (state, user_id, provider, session_hash, expires_at, phase) VALUES (?, ?, ?, ?, ?, 'preparing') ON CONFLICT(user_id, provider) DO UPDATE SET state = excluded.state, session_hash = excluded.session_hash, expires_at = excluded.expires_at, phase = 'preparing', verifier = NULL", state, session.user.id, provider, session.hash, now() + 600);
    const verifier = provider === "linear" ? base64url(crypto.getRandomValues(new Uint8Array(32))) : null;
    const encrypted = verifier ? await this.encrypt(session.user.id, provider, "pkce", verifier) : null;
    const challenge = verifier ? base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)))) : null;
    this.flow(state, provider, session, "preparing");
    this.sql.exec("UPDATE account_oauth SET phase = 'approved', verifier = ? WHERE state = ?", encrypted, state);
    const authorization = new URL(provider === "github" ? "https://github.com/login/oauth/authorize" : "https://linear.app/oauth/authorize");
    authorization.searchParams.set("client_id", provider === "github" ? this.env.GITHUB_CLIENT_ID! : this.env.LINEAR_CLIENT_ID!);
    authorization.searchParams.set("redirect_uri", this.redirectUri(provider));
    authorization.searchParams.set("state", state);
    if (provider === "linear") {
      authorization.searchParams.set("response_type", "code");
      authorization.searchParams.set("scope", "read,write");
      authorization.searchParams.set("code_challenge_method", "S256");
      authorization.searchParams.set("code_challenge", challenge!);
    }
    return this.auth.json({ url: authorization.toString() });
  }

  private async callback(request: Request, provider: Provider, url: URL): Promise<Response> {
    const session = await this.auth.session(request);
    const flow = this.flow(url.searchParams.get("state"), provider, session, "approved");
    this.config(provider);
    this.sql.exec("UPDATE account_oauth SET phase = 'processing' WHERE state = ?", flow.state);
    const check = () => { this.flow(flow.state, provider, session, "processing"); };
    let step = "authorization";
    try {
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || !code || code.length > 4096 || /[\x00-\x1f\x7f]/.test(code)) throw new Error("Authorization declined");
      step = "exchange";
      let credential: Credential;
      if (provider === "linear") {
        const verifier = await this.decrypt<string>(flow.user_id, provider, "pkce", flow.verifier!);
        check();
        credential = await this.exchange(provider, { client_id: this.env.LINEAR_CLIENT_ID!, grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: this.redirectUri(provider) });
      } else credential = await this.exchange(provider, { client_id: this.env.GITHUB_CLIENT_ID!, client_secret: this.env.GITHUB_CLIENT_SECRET!, code, redirect_uri: this.redirectUri(provider) });
      check();
      step = "storage";
      // Persist the exchanged credential before enumeration, so an eviction never loses a rotated token.
      const ciphertext = await this.encrypt(flow.user_id, provider, "credentials", credential);
      check();
      this.sql.exec("UPDATE account_integrations SET pending = ?, choices = NULL, pending_status = 'ready' WHERE user_id = ? AND provider = ?", ciphertext, flow.user_id, provider);
      step = "targets";
      const choices = provider === "github" ? await this.repositories(credential.access_token, check) : await this.teams(credential.access_token, check);
      step = "completion";
      check();
      this.sql.exec("UPDATE account_integrations SET choices = ? WHERE user_id = ? AND provider = ?", JSON.stringify(choices), flow.user_id, provider);
      this.sql.exec("UPDATE account_oauth SET phase = 'ready', verifier = NULL WHERE state = ?", flow.state);
      return this.redirect(`#connected=${provider}`);
    } catch (error) {
      // Persist only our stage and allowlisted provider codes, never response text or credentials.
      const code = error instanceof Error && "providerCode" in error ? String(error.providerCode) : "request_failed";
      this.sql.exec("UPDATE account_oauth SET phase = ?, verifier = NULL WHERE state = ? AND phase = 'processing'", `failed:${step}:${code}`, flow.state);
      return this.redirect("#connection-error=authorization-failed");
    }
  }

  private async exchange(provider: Provider, fields: Record<string, string>): Promise<Credential> {
    const response = await fetch(provider === "github" ? "https://github.com/login/oauth/access_token" : "https://api.linear.app/oauth/token", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Oriel" }, body: new URLSearchParams(fields), redirect: "manual",
    });
    const result = await response.json().catch(() => null) as { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; error?: string } | null;
    if (!response.ok || !result || result.error || typeof result.access_token !== "string" || !result.access_token ||
        result.refresh_token !== undefined && (typeof result.refresh_token !== "string" || !result.refresh_token)) {
      const code = result?.error && TOKEN_ERRORS.includes(result.error) ? result.error : !response.ok ? `http_${response.status}` : "invalid_token_response";
      throw Object.assign(new Error("Provider exchange failed"), { providerCode: code });
    }
    return { access_token: result.access_token, refresh_token: result.refresh_token,
      expires_at: typeof result.expires_in === "number" && result.expires_in > 0 ? now() + result.expires_in : provider === "linear" ? now() + 86400 : undefined,
      refresh_expires_at: typeof result.refresh_token_expires_in === "number" && result.refresh_token_expires_in > 0 ? now() + result.refresh_token_expires_in : undefined };
  }

  private async credential(connection: Connection, slot: "active" | "pending", check: () => void): Promise<Credential> {
    this.config(connection.provider);
    if (!connection[slot]) this.auth.fail(409, "No provider credential is connected");
    const value = await this.decrypt<Credential>(connection.user_id, connection.provider, "credentials", connection[slot]!);
    const current = this.current(connection, slot, check);
    if (current[`${slot}_status`] === "uncertain") this.auth.fail(409, "Refresh interrupted; reconnect provider in Web");
    if (!value.expires_at || value.expires_at > now() + 120) return value;
    const key = `${connection.user_id}:${connection.provider}:${slot}:${connection[slot]}`;
    let pending = this.refreshes.get(key);
    if (!pending) {
      if (current[`${slot}_status`] === "refreshing") this.auth.fail(409, "Provider refresh in progress; retry");
      if (!value.refresh_token || (value.refresh_expires_at && value.refresh_expires_at <= now())) this.auth.fail(409, "Provider authorization expired; reconnect in Web");
      this.sql.exec(`UPDATE account_integrations SET ${slot}_status = 'refreshing' WHERE user_id = ? AND provider = ?`, connection.user_id, connection.provider);
      pending = this.refresh(connection, slot, value);
      this.refreshes.set(key, pending);
    }
    let refreshed: { credential: Credential; ciphertext: string };
    try { refreshed = await pending; } finally { if (this.refreshes.get(key) === pending) this.refreshes.delete(key); }
    check();
    const latest = this.row(connection.user_id, connection.provider);
    if (!latest || latest.generation !== connection.generation || latest[slot] !== refreshed.ciphertext || latest[`${slot}_status`] !== "ready") this.auth.fail(409, "Provider connection changed");
    // Refresh changed the ciphertext; callers must guard the new version for subsequent provider awaits.
    connection[slot] = latest[slot];
    return refreshed.credential;
  }

  private async refresh(connection: Connection, slot: "active" | "pending", value: Credential): Promise<{ credential: Credential; ciphertext: string }> {
    try {
      const fields: Record<string, string> = { grant_type: "refresh_token", refresh_token: value.refresh_token!, client_id: connection.provider === "github" ? this.env.GITHUB_CLIENT_ID! : this.env.LINEAR_CLIENT_ID! };
      if (connection.provider === "github") fields.client_secret = this.env.GITHUB_CLIENT_SECRET!;
      const refreshed = await this.exchange(connection.provider, fields);
      refreshed.refresh_token ??= value.refresh_token;
      refreshed.refresh_expires_at ??= value.refresh_expires_at;
      const ciphertext = await this.encrypt(connection.user_id, connection.provider, "credentials", refreshed);
      this.current(connection, slot, () => {});
      this.sql.exec(`UPDATE account_integrations SET ${slot} = ?, ${slot}_status = 'ready' WHERE user_id = ? AND provider = ? AND generation = ? AND ${slot} = ?`, ciphertext, connection.user_id, connection.provider, connection.generation, connection[slot]);
      return { credential: refreshed, ciphertext };
    } catch (error) {
      this.sql.exec(`UPDATE account_integrations SET ${slot}_status = 'uncertain' WHERE user_id = ? AND provider = ? AND generation = ? AND ${slot} = ?`, connection.user_id, connection.provider, connection.generation, connection[slot]);
      if (error instanceof Error && "status" in error) throw error;
      this.auth.fail(502, "Provider refresh failed; reconnect in Web");
    }
  }

  private async api<T>(token: string, path: string): Promise<T> {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "Oriel", "X-GitHub-Api-Version": "2022-11-28" }, redirect: "manual",
    });
    if (!response.ok) throw Object.assign(new Error("GitHub authorization unavailable"), { providerCode: `http_${response.status}` });
    return await response.json() as T;
  }

  private async installations(token: string, check: () => void): Promise<Installation[]> {
    const installations: Installation[] = [];
    for (let page = 1; ; page++) {
      const result = await this.api<{ installations: Installation[] }>(token, `/user/installations?per_page=100&page=${page}`);
      check();
      installations.push(...result.installations.filter(installation => String(installation.app_id) === this.env.GITHUB_APP_ID));
      if (result.installations.length < 100) return installations;
    }
  }

  private async installationRepositories(token: string, installationId: number, check: () => void): Promise<Repository[]> {
    const repositories: Repository[] = [];
    for (let page = 1; ; page++) {
      const result = await this.api<{ repositories: { id: number; name: string; owner: { login: string } }[] }>(token, `/user/installations/${installationId}/repositories?per_page=100&page=${page}`);
      check();
      repositories.push(...result.repositories.map(repository => ({ installation_id: installationId, repository_id: repository.id, owner: repository.owner.login, name: repository.name })));
      if (result.repositories.length < 100) return repositories;
    }
  }

  private async repositories(token: string, check: () => void): Promise<Repository[]> {
    const repositories: Repository[] = [];
    for (const installation of await this.installations(token, check)) repositories.push(...await this.installationRepositories(token, installation.id, check));
    return repositories;
  }

  private async linear<T>(token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch("https://api.linear.app/graphql", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }), redirect: "manual" });
    if (!response.ok) throw Object.assign(new Error("Linear authorization unavailable"), { providerCode: `http_${response.status}` });
    const result = await response.json() as { data?: T; errors?: unknown[] };
    if (!result.data || result.errors?.length) throw Object.assign(new Error("Linear request failed"), { providerCode: "graphql_error" });
    return result.data;
  }

  private async teams(token: string, check: () => void): Promise<Team[]> {
    const teams: Team[] = [];
    let after: string | null = null;
    do {
      const result: { organization: { id: string }; teams: { nodes: { id: string; name: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await this.linear(token, "query($after:String){organization{id} teams(first:100,after:$after){nodes{id name} pageInfo{hasNextPage endCursor}}}", { after });
      check();
      teams.push(...result.teams.nodes.map(team => ({ team_id: team.id, team_name: team.name, workspace_id: result.organization.id })));
      after = result.teams.pageInfo.hasNextPage ? result.teams.pageInfo.endCursor : null;
      if (result.teams.pageInfo.hasNextPage && !after) throw new Error("Linear pagination failed");
    } while (after);
    return teams;
  }

  private async select(user: string, provider: Provider, body: Record<string, unknown>, check: () => void): Promise<Response> {
    const connection = this.row(user, provider);
    if (!connection?.pending || !connection.choices) this.auth.fail(409, "Authorize provider in Web before selecting a target");
    const guard = () => { this.current(connection, "pending", check); };
    try {
      const credential = await this.credential(connection, "pending", check);
      let target: Repository | Team | undefined;
      if (provider === "github") {
        if (!Number.isSafeInteger(body.installation_id) || Number(body.installation_id) <= 0 || !Number.isSafeInteger(body.repository_id) || Number(body.repository_id) <= 0) this.auth.fail(400, "Invalid GitHub target IDs");
        const choices = JSON.parse(connection.choices) as Repository[];
        if (!choices.some(repo => repo.installation_id === body.installation_id && repo.repository_id === body.repository_id)) this.auth.fail(403, "GitHub repository is not an authorized choice");
        const installation = (await this.installations(credential.access_token, guard)).find(candidate => candidate.id === body.installation_id);
        if (!installation?.account) this.auth.fail(403, "GitHub installation is not authorized");
        if (installation.account.type === "Organization") {
          const membership = await this.api<{ role: string; state: string }>(credential.access_token, `/user/memberships/orgs/${encodeURIComponent(installation.account.login)}`);
          guard();
          if (membership.role !== "admin" || membership.state !== "active") this.auth.fail(403, "GitHub installation management permission is required");
        } else {
          const viewer = await this.api<{ id: number }>(credential.access_token, "/user");
          guard();
          if (viewer.id !== installation.account.id) this.auth.fail(403, "GitHub installation management permission is required");
        }
        target = (await this.installationRepositories(credential.access_token, installation.id, guard)).find(repo => repo.repository_id === body.repository_id);
      } else {
        if (typeof body.team_id !== "string" || !body.team_id || body.team_id.length > 255) this.auth.fail(400, "Invalid Linear team ID");
        if (!(JSON.parse(connection.choices) as Team[]).some(team => team.team_id === body.team_id)) this.auth.fail(403, "Linear team is not an authorized choice");
        target = (await this.teams(credential.access_token, guard)).find(team => team.team_id === body.team_id);
      }
      if (!target) this.auth.fail(403, "Provider target is no longer accessible");
      guard();
      this.sql.exec("UPDATE account_integrations SET active = pending, target = ?, active_status = 'ready', pending = NULL, choices = NULL, generation = ? WHERE user_id = ? AND provider = ?", JSON.stringify(target), random(), user, provider);
      this.sql.exec("DELETE FROM account_oauth WHERE user_id = ? AND provider = ?", user, provider);
      return this.auth.json({ ok: true });
    } catch (error) {
      if (error instanceof Error && "status" in error) throw error;
      this.auth.fail(502, "Provider target authorization could not be verified");
    }
  }

  private async disconnect(user: string, provider: Provider, check: () => void): Promise<Response> {
    check();
    const connection = this.row(user, provider);
    this.sql.exec("DELETE FROM account_integrations WHERE user_id = ? AND provider = ?", user, provider);
    this.sql.exec("DELETE FROM account_oauth WHERE user_id = ? AND provider = ?", user, provider);
    let revoked = true;
    for (const ciphertext of new Set([connection?.active, connection?.pending].filter((value): value is string => !!value))) {
      try {
        const credential = await this.decrypt<Credential>(user, provider, "credentials", ciphertext);
        const response = provider === "github" ? await fetch(`https://api.github.com/applications/${encodeURIComponent(this.env.GITHUB_CLIENT_ID!)}/grant`, {
          method: "DELETE", headers: { Authorization: `Basic ${btoa(`${this.env.GITHUB_CLIENT_ID}:${this.env.GITHUB_CLIENT_SECRET}`)}`, "Content-Type": "application/json", "User-Agent": "Oriel" }, body: JSON.stringify({ access_token: credential.access_token }), redirect: "manual",
        }) : await fetch("https://api.linear.app/oauth/revoke", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: credential.access_token }), redirect: "manual",
        });
        if (!response.ok) revoked = false;
      } catch { revoked = false; }
    }
    check();
    return this.auth.json({ ok: true, revoked });
  }

  private async installationToken(user: string, check: () => void): Promise<{ token: string; expires_at: string; repository: Repository }> {
    this.config("github");
    const connection = this.row(user, "github");
    if (!connection?.active || !connection.target) this.auth.fail(409, "No GitHub repository is connected");
    const repository = JSON.parse(connection.target) as Repository;
    const guard = () => { this.current(connection, "active", check); };
    let step = "access";
    try {
      // App JWT alone must not bypass a revoked user grant or lost repository access.
      const credential = await this.credential(connection, "active", check);
      const accessible = await this.installationRepositories(credential.access_token, repository.installation_id, guard);
      if (!accessible.some(candidate => candidate.repository_id === repository.repository_id)) this.auth.fail(403, "GitHub repository is no longer accessible");
      guard();
      step = "private_key";
      const pem = this.env.GITHUB_APP_PRIVATE_KEY!.replaceAll("\\n", "\n");
      let der = Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "")), character => character.charCodeAt(0));
      if (pem.includes("BEGIN RSA PRIVATE KEY")) {
        const length = (size: number) => size < 128 ? [size] : size < 256 ? [0x81, size] : [0x82, size >> 8, size & 255];
        const prefix = [2, 1, 0, 0x30, 0x0d, 6, 9, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 1, 5, 0, 4, ...length(der.length)];
        der = new Uint8Array([0x30, ...length(prefix.length + der.length), ...prefix, ...der]);
      }
      const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
      const signingInput = `${base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.${base64url(encoder.encode(JSON.stringify({ iat: now() - 60, exp: now() + 540, iss: this.env.GITHUB_APP_ID })))}`;
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput));
      guard();
      step = "request";
      const response = await fetch(`https://api.github.com/app/installations/${repository.installation_id}/access_tokens`, {
        method: "POST", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${signingInput}.${base64url(new Uint8Array(signature))}`, "Content-Type": "application/json", "User-Agent": "Oriel", "X-GitHub-Api-Version": "2022-11-28" },
        body: JSON.stringify({ repository_ids: [repository.repository_id], permissions: PERMISSIONS }), redirect: "manual",
      });
      if (!response.ok) {
        const hint = response.status === 401
          ? "Check GITHUB_APP_ID and the matching GitHub App private key."
          : response.status === 422
            ? "Check Contents, Issues and Pull requests write permissions and approval of those permissions on the installation."
            : "Check the GitHub App installation status and granted permissions.";
        this.auth.fail(502, `GitHub installation token request rejected (HTTP ${response.status}). ${hint}`);
      }
      step = "response";
      const token = await response.json() as { token?: string; expires_at?: string };
      if (typeof token.token !== "string" || !token.token || typeof token.expires_at !== "string" || !Number.isFinite(Date.parse(token.expires_at))) throw new Error("GitHub token failed");
      guard();
      return { token: token.token, expires_at: token.expires_at, repository };
    } catch (error) {
      if (error instanceof Error && "status" in error) throw error;
      if (step === "private_key") this.auth.fail(502, "GITHUB_APP_PRIVATE_KEY could not be imported or used. Supply the complete RSA PEM private key for this GitHub App, including BEGIN/END lines.");
      if (step === "access") {
        const code = error instanceof Error && "providerCode" in error ? ` (${error.providerCode})` : "";
        this.auth.fail(502, `GitHub repository access verification failed${code}. Reconnect GitHub if its user authorization was revoked.`);
      }
      this.auth.fail(502, step === "request" ? "GitHub installation token request could not reach GitHub." : "GitHub returned an invalid installation token response.");
    }
  }

  private async issues(user: string, check: () => void): Promise<unknown> {
    const result: { github: unknown; linear: unknown } = { github: null, linear: null };
    // Snapshot both connections; don't mix account versions across provider awaits.
    const github = this.row(user, "github");
    const linear = this.row(user, "linear");
    try {
      if (github?.active && github.target) {
        await this.credential(github, "active", check);
        const token = await this.installationToken(user, check);
        this.current(github, "active", check);
        const issues: { number: number; title: string }[] = [];
        for (let page = 1; issues.length < 20; page++) {
          const rows = await this.api<{ number: number; title: string; pull_request?: unknown }[]>(token.token, `/repos/${encodeURIComponent(token.repository.owner)}/${encodeURIComponent(token.repository.name)}/issues?state=all&sort=updated&direction=desc&per_page=100&page=${page}`);
          this.current(github, "active", check);
          issues.push(...rows.filter(issue => !issue.pull_request).map(({ number, title }) => ({ number, title })));
          if (rows.length < 100) break;
        }
        result.github = { repository: token.repository, issues: issues.slice(0, 20) };
      }
      if (linear?.active && linear.target) {
        const credential = await this.credential(linear, "active", check);
        const team = JSON.parse(linear.target) as Team;
        const data = await this.linear<{ team: { issues: { nodes: { identifier: string; title: string }[] } } | null }>(credential.access_token, "query($id:String!){team(id:$id){issues(first:20,orderBy:updatedAt){nodes{identifier title}}}}", { id: team.team_id });
        this.current(linear, "active", check);
        if (!data.team) throw new Error("Linear team unavailable");
        result.linear = { team, issues: data.team.issues.nodes.map(({ identifier, title }) => ({ identifier, title })) };
      }
      if (github?.active && github.target) this.current(github, "active", check);
      if (linear?.active && linear.target) this.current(linear, "active", check);
      check();
      return result;
    } catch (error) {
      if (error instanceof Error && "status" in error) throw error;
      this.auth.fail(502, "Connected provider issues could not be retrieved");
    }
  }
}
