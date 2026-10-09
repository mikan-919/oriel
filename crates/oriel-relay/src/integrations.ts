import { digest, githubIssueLink, OID, parseConfiguration, UUID, validBranch, type Feedback, type GithubWhat, type LinearHow, type LinearState, type PullRequest, type WorkflowAdmission, type WorkflowAuthority, type WorkflowBinding, type WorkflowClaim, type WorkflowGrant, type WorkflowRow, type WorkflowSnapshot } from "./workflow";

export interface IntegrationEnv {
  PUBLIC_ORIGIN: string;
  INTEGRATION_ENCRYPTION_KEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  LINEAR_CLIENT_ID?: string;
}

export type Device = { device_id: string; name: string; user_id: string; host_hash: string; repository: string | null; repository_generation: string };
type WorkingRepository = { owner: string; name: string };
type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
type LinkedIssue = {
  id: string; identifier: string; title: string; url: string; description: string | null;
  state: { name: string; type: string }; team: { id: string }; attachments: Page<{ url: string }>;
};
type Session = { hash: string; user: { id: string; display_name: string } };
type Provider = "github" | "linear";
type Repository = { installation_id: number; repository_id: number; owner: string; name: string };
type LinearAgent = { id: string; name: string; url: string };
type Team = { team_id: string; team_name: string; workspace_id: string; agent?: LinearAgent };
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
  changed(): void;
  body(request: Request): Promise<Record<string, unknown>>;
  fail(status: number, message: string): never;
  json(data: unknown, status?: number): Response;
};
const SECRET = /^[a-f0-9]{64}$/;
const GITHUB_COMMAND = "/oriel";
const githubCommand = (body: string) => /^[\/／]oriel(?:\s|$)/i.test(body.trimStart())
  ? { planning: /^[\/／]oriel\s+how(?:\s|$)/i.test(body.trimStart()) } : null;
const PERMISSIONS = { contents: "write", issues: "write", pull_requests: "write", metadata: "read" };
const TOKEN_ERRORS = ["incorrect_client_credentials", "bad_verification_code", "redirect_uri_mismatch", "access_denied", "invalid_grant", "invalid_client"];
const now = () => Math.floor(Date.now() / 1000);
const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");

type WorkflowContext = { binding: WorkflowBinding; github: string; linear: string; repository: Repository; team: Team; path: string; check: () => void };
type WorkflowHow = LinearHow & { team: { id: string }; attachments: { url: string }[] };
type GithubPull = {
  number: number; html_url: string; body: string | null; state: "open" | "closed"; merged_at: string | null; draft: boolean;
  head: { ref: string; sha: string; repo: { id: number } | null }; base: { ref: string; repo: { id: number } };
};
type GithubComment = { id: number; body: string; user: { type: string; login: string }; created_at: string };
type LinearComment = { id: string; body: string; createdAt: string; user: { id: string; name: string; app: boolean } | null };
type WorkflowFacts = { snapshot: WorkflowSnapshot; states: LinearState[]; hows: WorkflowHow[]; pulls: GithubPull[]; refs: Map<string, string>; recoveries: Map<number, string> };

/** Only authenticated target metadata is plaintext; credentials and PKCE are AES-GCM ciphertext. */
export class Integrations {
  private readonly refreshes = new Map<string, Promise<{ credential: Credential; ciphertext: string }>>();
  private readonly whatCreations = new Map<string, Promise<GithubWhat>>();

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
    return request.headers.has("Authorization") && (
      request.method === "GET" && /^\/api\/workflows\/[a-f0-9]{32}(?:\/connect)?$/.test(path) ||
      request.method === "POST" && /^\/api\/workflows\/[a-f0-9]{32}\/(?:actions|git-token)$/.test(path)) ||
      request.method === "GET" && (/^\/api\/integrations\/[a-f0-9]{32}(?:\/issues)?$/.test(path) ||
      request.headers.has("Authorization") && /^\/api\/integrations\/[a-f0-9]{32}\/linear\/issues$/.test(path)) ||
      request.method === "POST" && /^\/api\/integrations\/[a-f0-9]{32}\/repository$/.test(path);
  }

  workflowBinding(device: Device): WorkflowBinding {
    this.liveDevice(device);
    const current = this.sql.exec<Device>("SELECT * FROM devices WHERE device_id = ?", device.device_id).toArray()[0];
    const github = this.row(device.user_id, "github");
    const linear = this.row(device.user_id, "linear");
    if (!github?.active || !github.target || !linear?.active || !linear.target) this.auth.fail(409, "Connect GitHub repository and Linear team in Web");
    if (github.active_status === "uncertain" || linear.active_status === "uncertain") this.auth.fail(409, "Provider refresh interrupted; reconnect in Web");
    const repository = JSON.parse(github.target) as Repository;
    const reported = JSON.parse(current.repository ?? "null") as WorkingRepository | null;
    const team = JSON.parse(linear.target) as Team;
    if (!reported || reported.owner !== repository.owner.toLowerCase() || reported.name !== repository.name.toLowerCase()) this.auth.fail(409, "Selected GitHub repository must match the daemon repository");
    return { user_id: device.user_id, device_id: device.device_id, host_hash: device.host_hash,
      repository_generation: current.repository_generation, github_generation: github.generation, linear_generation: linear.generation,
      repository_id: repository.repository_id, team_id: team.team_id, repository: { owner: repository.owner, name: repository.name } };
  }

  private async workflowContext(device: Device, check: () => void, write = false): Promise<WorkflowContext> {
    const binding = this.workflowBinding(device);
    const github = this.row(device.user_id, "github")!;
    const linear = this.row(device.user_id, "linear")!;
    const guard = () => {
      check();
      if (JSON.stringify(this.workflowBinding(device)) !== JSON.stringify(binding)) this.auth.fail(409, "Workflow binding changed");
    };
    const token = await this.installationToken(device.user_id, guard, write ? { ...PERMISSIONS, checks: "read", statuses: "read" } : { contents: "read", issues: "read", pull_requests: "read", metadata: "read", checks: "read", statuses: "read" });
    const credential = await this.credential(linear, "active", guard);
    const live = () => {
      guard();
      if (this.row(device.user_id, "github")?.generation !== github.generation) this.auth.fail(409, "GitHub connection changed");
      this.current(linear, "active", guard);
    };
    live();
    const repository = token.repository;
    return { binding, github: token.token, linear: credential.access_token, repository, team: JSON.parse(linear.target!), path: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`, check: live };
  }

  private async workflowGithub<T>(context: WorkflowContext, path: string, method = "GET", body?: unknown, missing = false): Promise<T | null> {
    context.check();
    const response = await fetch(`https://api.github.com${path}`, { method, headers: {
      Accept: "application/vnd.github+json", Authorization: `Bearer ${context.github}`, "User-Agent": "Oriel", "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual" });
    context.check();
    if (missing && response.status === 404) return null;
    if (!response.ok) this.auth.fail(502, `GitHub workflow ${method} failed (HTTP ${response.status}); provider state could not be confirmed`);
    const result = await response.json() as T;
    context.check();
    return result;
  }

  private async workflowList<T>(context: WorkflowContext, path: string): Promise<T[]> {
    const nodes: T[] = [];
    for (let page = 1; ; page++) {
      const rows = await this.workflowGithub<T[]>(context, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(rows)) this.auth.fail(502, "GitHub workflow collection is unavailable");
      nodes.push(...rows);
      if (rows.length < 100) return nodes;
    }
  }

  private async workflowLinear<T>(context: WorkflowContext, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    context.check();
    try {
      const result = await this.linear<T>(context.linear, query, variables);
      context.check();
      return result;
    } catch (error) {
      context.check();
      if (error instanceof Error && ("status" in error || ("missingIssue" in error && error.missingIssue === true))) throw error;
      const code = error instanceof Error && "providerCode" in error && typeof error.providerCode === "string" &&
        /^(?:http_[0-9]{3}|graphql_error)$/.test(error.providerCode) ? error.providerCode : "transport_or_response_error";
      this.auth.fail(502, `Linear workflow request failed (${code}); provider state could not be confirmed`);
    }
  }

  private async workflowHow(context: WorkflowContext, id: string): Promise<WorkflowHow | null> {
    let result: { issue: (LinearHow & { team: { id: string }; attachments: Page<{ url: string }> }) | null };
    try {
      result = await this.workflowLinear<typeof result>(context,
        "query($id:String!){issue(id:$id){id identifier title description url state{id name type} team{id} attachments(first:100,includeArchived:true){nodes{url} pageInfo{hasNextPage endCursor}}}}", { id });
    } catch (error) {
      context.check();
      if (error instanceof Error && "missingIssue" in error && error.missingIssue === true) return null;
      throw error;
    }
    if (!result.issue) return null;
    const { attachments, ...issue } = result.issue;
    const all = [...attachments.nodes];
    let page = attachments;
    const seen = new Set<string>();
    while (page.pageInfo.hasNextPage) {
      const after = page.pageInfo.endCursor;
      if (!after || seen.has(after)) this.auth.fail(502, "Linear attachment pagination is unavailable");
      seen.add(after);
      const next = await this.workflowLinear<{ issue: { attachments: Page<{ url: string }> } | null }>(context,
        "query($id:String!,$after:String!){issue(id:$id){attachments(first:100,after:$after,includeArchived:true){nodes{url} pageInfo{hasNextPage endCursor}}}}", { id, after });
      if (!next.issue) this.auth.fail(502, "Linear issue disappeared");
      page = next.issue.attachments;
      all.push(...page.nodes);
    }
    return { ...issue, attachments: all };
  }

  private async workflowStates(context: WorkflowContext): Promise<LinearState[]> {
    const nodes: LinearState[] = [];
    let after: string | null = null;
    const seen = new Set<string>();
    do {
      const data: { team: { states: Page<LinearState> } | null } = await this.workflowLinear(context,
        "query($id:String!,$after:String){team(id:$id){states(first:100,after:$after){nodes{id name type} pageInfo{hasNextPage endCursor}}}}", { id: context.team.team_id, after });
      if (!data.team) this.auth.fail(409, "Selected Linear team is unavailable");
      nodes.push(...data.team.states.nodes);
      after = data.team.states.pageInfo.hasNextPage ? data.team.states.pageInfo.endCursor : null;
      if (data.team.states.pageInfo.hasNextPage && (!after || seen.has(after))) this.auth.fail(502, "Linear state pagination is unavailable");
      if (after) seen.add(after);
    } while (after);
    return nodes;
  }

  private async workflowFacts(context: WorkflowContext): Promise<WorkflowFacts> {
    const repository = await this.workflowGithub<{ id: number; node_id: string; default_branch: string }>(context, context.path);
    if (!repository || repository.id !== context.repository.repository_id || !validBranch(repository.default_branch)) this.auth.fail(409, "Selected repository identity is unavailable");
    const base = await this.workflowGithub<{ object: { sha: string } }>(context, `${context.path}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
    if (!base || !OID.test(base.object.sha)) this.auth.fail(502, "Target commit is unavailable");
    const configuration = await this.workflowGithub<{ type: string; encoding: string; content: string; sha: string }>(context,
      `${context.path}/contents/.oriel.yaml?ref=${base.object.sha}`, "GET", undefined, true);
    let source: string | null = null;
    if (configuration) {
      if (configuration.type !== "file" || configuration.encoding !== "base64" || configuration.content.length > 131072) this.auth.fail(409, "Target .oriel.yaml must be a bounded regular file");
      try { source = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(configuration.content.replace(/\s/g, "")), char => char.charCodeAt(0))); }
      catch { this.auth.fail(409, "Target .oriel.yaml is not UTF-8"); }
    }
    const issues = await this.workflowList<GithubWhat & { html_url: string; pull_request?: unknown }>(context, `${context.path}/issues?state=all&sort=created&direction=asc`);
    const pulls = await this.workflowList<GithubPull>(context, `${context.path}/pulls?state=all`);
    // This native endpoint returns the complete matching collection and has no page argument.
    const references = await this.workflowGithub<{ ref: string; object: { sha: string } }[]>(context, `${context.path}/git/matching-refs/heads/oriel/`);
    if (!Array.isArray(references) || references.some(ref => !ref.ref.startsWith("refs/heads/oriel/") || !validBranch(ref.ref.slice("refs/heads/".length)) || !OID.test(ref.object.sha))) this.auth.fail(502, "Canonical reference facts are unavailable");
    const refs = new Map(references.map(ref => [ref.ref.replace(/^refs\/heads\//, ""), ref.object.sha]));
    const hows: WorkflowHow[] = [];
    let after: string | null = null;
    const cursors = new Set<string>();
    do {
      // Do not filter the team: a foreign-team formal link must block, not look unlinked.
      const data: { issues: Page<{ id: string }> } = await this.workflowLinear(context,
        "query($prefix:String!,$after:String){issues(first:100,after:$after,includeArchived:true,orderBy:createdAt,filter:{attachments:{some:{url:{startsWithIgnoreCase:$prefix}}}}){nodes{id} pageInfo{hasNextPage endCursor}}}",
        { prefix: `https://github.com/${context.repository.owner}/${context.repository.name}/issues/`, after });
      for (const candidate of data.issues.nodes) {
        if (hows.some(how => how.id === candidate.id)) continue;
        const how = await this.workflowHow(context, candidate.id);
        if (!how) this.auth.fail(502, "Linked HOW is unavailable");
        hows.push(how);
      }
      after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
      if (data.issues.pageInfo.hasNextPage && (!after || cursors.has(after))) this.auth.fail(502, "Linear issue pagination is unavailable");
      if (after) cursors.add(after);
    } while (after);
    const states = await this.workflowStates(context);
    const snapshot: WorkflowSnapshot = { repository: context.binding.repository, repository_id: repository.id, repository_node_id: repository.node_id,
      base_branch: repository.default_branch, target_oid: base.object.sha, team: context.team, configuration: parseConfiguration(source), workflows: [] };
    const recoveries = new Map<number, string>();
    for (const raw of issues) {
      if (raw.pull_request) continue;
      const issue: GithubWhat = { number: raw.number, node_id: raw.node_id, title: raw.title, body: raw.body ?? null, url: raw.html_url, state: raw.state };
      if (!Number.isSafeInteger(issue.number) || !issue.node_id || !["open", "closed"].includes(issue.state)) this.auth.fail(502, "GitHub WHAT identity is unavailable");
      const linked = hows.filter(how => how.attachments.some(attachment => {
        const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/0*([0-9]+)(?:[/?#].*)?$/i.exec(attachment.url);
        return !!match && match[1].toLowerCase() === context.repository.owner.toLowerCase() && match[2].toLowerCase() === context.repository.name.toLowerCase() && Number(match[3]) === issue.number;
      }));
      // Any human GitHub user may request planning, including before deployment.
      // Commands must start the comment; quotes, code and prose do not opt in.
      const initialComments = linked.length === 0 && issue.state === "open"
        ? await this.workflowList<GithubComment>(context, `${context.path}/issues/${issue.number}/comments`) : [];
      const request = await this.workflowIssueFeedback(context, initialComments, true);
      const row: WorkflowRow = { issue, linear: null, version: await digest(["oriel/what-version/v1", repository.node_id, issue.node_id, issue.title, issue.body ?? ""]),
        fingerprint: null, branch: null, canonical_oid: null, pull_request: null, phase: issue.state === "closed" ? "closed" : request ? "needs-how" : "waiting-how", blocked_reason: null, feedback: null, how_feedback: null, issue_feedback: null, recovery: null,
        what_comments: [], how_comments: [] };
      if (linked.length === 0 && issue.state === "open") {
        row.version = await digest(["oriel/initial-how-request/v1", row.version, request?.key ?? null]);
        if (!request) row.blocked_reason = `Waiting for a human GitHub user to start a comment with ${GITHUB_COMMAND} how; this requests planning only, not implementation`;
      }
      if (row.phase === "needs-how" && linked.length === 0 && states.filter(state => state.name === "Triage" && state.type === "triage").length !== 1) {
        row.phase = "blocked"; row.blocked_reason = "Selected Linear team needs one native Triage state; enable Team Settings > Triage before HOW planning";
      }
      if (linked.length > 1) { row.phase = "blocked"; row.blocked_reason = "Multiple Linear issues formally link this WHAT"; }
      if (linked.length === 1) {
        const how = linked[0];
        const allLinks = how.attachments.filter(attachment => /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\//i.test(attachment.url)).map(attachment => githubIssueLink(attachment.url));
        const distinct = new Set(allLinks.filter(link => link !== null).map(link => `${link!.owner}/${link!.name}#${link!.number}`));
        const validLink = distinct.size === 1 && !allLinks.includes(null) && distinct.has(`${context.repository.owner.toLowerCase()}/${context.repository.name.toLowerCase()}#${issue.number}`);
        const { team: _team, attachments: _attachments, ...linear } = how;
        row.linear = linear;
        row.version = await digest(["oriel/approval-fingerprint/v1", repository.node_id, issue.node_id, issue.title, issue.body ?? "", how.id, how.title, how.description ?? ""]);
        if (how.team.id !== context.team.team_id || !validLink) {
          row.phase = "blocked"; row.blocked_reason = "HOW link is foreign, aliased or not one-to-one";
        } else {
          row.fingerprint = row.version;
          row.branch = `oriel/${how.identifier}-gh-${issue.number}-${row.fingerprint}`;
          if (!validBranch(row.branch)) { row.phase = "blocked"; row.blocked_reason = "Canonical branch is not a valid Git reference"; }
          else {
            row.canonical_oid = refs.get(row.branch) ?? null;
            const matching = pulls.filter(pr => pr.head.ref === row.branch && pr.head.repo?.id === repository.id && pr.base.repo.id === repository.id && pr.base.ref === snapshot.base_branch);
            const managed = matching.filter(pr => pr.body?.trim() === `Closes #${issue.number}` && !pr.draft);
            if (matching.length !== managed.length || managed.length > 1) { row.phase = "blocked"; row.blocked_reason = "Canonical PR natural key is ambiguous or not Oriel-managed"; }
            else {
              const pr = managed[0];
              if (pr) row.pull_request = this.workflowPull(pr);
              const native = states.some(state => state.id === how.state.id && state.name === how.state.name && state.type === how.state.type);
              const exact = (name: string, type: string) => native && how.state.name === name && how.state.type === type && states.filter(state => state.name === name && state.type === type).length === 1;
              if (!native) { row.phase = "blocked"; row.blocked_reason = "Unknown Linear native state"; }
              else if (pr?.merged_at) row.phase = exact("Done", "completed") ? "done" : "merged";
              else if (exact("Done", "completed")) { row.phase = "blocked"; row.blocked_reason = "Done is not backed by an actual merged PR"; }
              else if (issue.state === "closed" || how.state.type === "canceled") row.phase = "closed";
              else if (exact("Triage", "triage")) row.phase = "triage";
              else if (exact("Todo", "unstarted") && !pr) row.phase = "approved";
              else if (row.canonical_oid && (exact("In Progress", "started") || how.state.type === "started" && /review/i.test(how.state.name) && states.filter(state => state.type === "started" && /review/i.test(state.name)).length === 1)) row.phase = pr?.state === "open" ? "review" : pr ? "blocked" : "running";
              else { row.phase = "blocked"; row.blocked_reason = pr?.state === "closed" ? "PR closed without merge" : "Human Todo or a matching sealed In Progress branch is required"; }
              const priorPrefix = `oriel/${how.identifier}-gh-${issue.number}-`;
              const prior = new Set([...refs.keys(), ...pulls.filter(candidate => candidate.head.repo?.id === repository.id && candidate.base.repo.id === repository.id &&
                candidate.base.ref === snapshot.base_branch && !candidate.draft && candidate.body?.trim() === `Closes #${issue.number}`).map(candidate => candidate.head.ref)]
                .filter(branch => branch !== row.branch && branch.startsWith(priorPrefix) && SECRET.test(branch.slice(priorPrefix.length)) && validBranch(branch)));
              const obsoleteOpen = pulls.some(candidate => prior.has(candidate.head.ref) && candidate.state === "open" && !candidate.merged_at &&
                candidate.head.repo?.id === repository.id && candidate.base.repo.id === repository.id && candidate.base.ref === snapshot.base_branch && !candidate.draft && candidate.body?.trim() === `Closes #${issue.number}`);
              if (row.phase === "approved" && obsoleteOpen) { row.phase = "blocked"; row.blocked_reason = "Obsolete managed PR must be reconciled before a new approval can execute"; }
              const activeNative = exact("Todo", "unstarted") || exact("In Progress", "started") || native && how.state.type === "started" && /review/i.test(how.state.name) && states.filter(state => state.type === "started" && /review/i.test(state.name)).length === 1;
              if (row.phase === "blocked" && !row.canonical_oid && !row.pull_request && activeNative && prior.size) {
                if (prior.size === 1) { row.recovery = "invalidate"; recoveries.set(issue.number, [...prior][0]); row.blocked_reason = "Approval content changed; prior canonical work can only be returned to Triage"; }
                else row.blocked_reason = "Prior canonical evidence is ambiguous; move this HOW to Triage manually";
              }
              if (["approved", "running", "review"].includes(row.phase) && !snapshot.configuration.autonomous) { row.phase = "blocked"; row.blocked_reason = snapshot.configuration.error; }
              if (row.phase === "review") {
                const exhausted: string[] = [];
                row.feedback = await this.workflowFeedback(context, row.pull_request!, undefined, exhausted);
                if (exhausted.length) row.blocked_reason = `Check retry limit reached (3 verified attempts): ${exhausted.join(", ")}`;
              }
            }
          }
        }
      }
      if (issue.state === "open") {
        const comments = linked.length === 0 ? initialComments : await this.workflowList<GithubComment>(context, `${context.path}/issues/${issue.number}/comments`);
        row.what_comments = comments.map(comment => ({ id: String(comment.id), body: comment.body, author: comment.user?.login ?? null, created_at: comment.created_at }))
          .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
        row.issue_feedback = await this.workflowIssueFeedback(context, comments);
        if (row.linear) {
          const comments = await this.workflowLinearComments(context, row.linear.id);
          row.how_comments = comments.map(comment => ({ id: comment.id, body: comment.body, author: comment.user?.name ?? null, created_at: comment.createdAt }))
            .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
          if (row.phase === "triage") row.how_feedback = await this.workflowHowFeedback(context, row.linear.id, comments);
        }
      }
      snapshot.workflows.push(row);
    }
    context.check();
    return { snapshot, states, hows, pulls, refs, recoveries };
  }

  private workflowPull(pr: GithubPull): PullRequest {
    return { number: pr.number, url: pr.html_url, branch: pr.head.ref, head_oid: pr.head.sha, base_branch: pr.base.ref, state: pr.state, merged: !!pr.merged_at, draft: pr.draft };
  }

  private async workflowMarker(context: WorkflowContext, kind: string, key: string): Promise<string> {
    const secret = Uint8Array.from(this.env.INTEGRATION_ENCRYPTION_KEY!.match(/../g)!, byte => parseInt(byte, 16));
    const hmac = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", hmac, encoder.encode(JSON.stringify(["oriel/workflow-cursor/v1", context.repository.repository_id, kind === "what" ? null : context.team.team_id, kind, key])));
    return `<!-- oriel:${kind}:${base64url(encoder.encode(key))}:${base64url(new Uint8Array(signature))} -->`;
  }

  private async workflowIssueFeedback(context: WorkflowContext, comments: GithubComment[], planningOnly = false): Promise<WorkflowRow["issue_feedback"]> {
    for (const comment of [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)) {
      if (comment.user?.type !== "User" || /<!-- oriel:/.test(comment.body)) continue;
      const command = githubCommand(comment.body);
      if (!command || planningOnly && !command.planning) continue;
      const key = `issue-comment:${await digest([comment.id, comment.user.login, comment.body])}`;
      const marker = await this.workflowMarker(context, "issue-response", key);
      if (!comments.some(reply => reply.user?.type === "Bot" && reply.body.includes(marker))) return { key, body: comment.body, planning: command.planning };
    }
    return null;
  }

  private async workflowLinearComments(context: WorkflowContext, id: string): Promise<LinearComment[]> {
    const comments: LinearComment[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    do {
      const result: { issue: { comments: Page<LinearComment> } | null } = await this.workflowLinear(context,
        "query($id:String!,$after:String){issue(id:$id){comments(first:100,after:$after,includeArchived:true){nodes{id body createdAt user{id name app}} pageInfo{hasNextPage endCursor}}}}", { id, after });
      if (!result.issue) this.auth.fail(502, "HOW comments are unavailable");
      comments.push(...result.issue.comments.nodes);
      after = result.issue.comments.pageInfo.hasNextPage ? result.issue.comments.pageInfo.endCursor : null;
      if (result.issue.comments.pageInfo.hasNextPage && (!after || seen.has(after))) this.auth.fail(502, "HOW comments pagination is unavailable");
      if (after) seen.add(after);
    } while (after);
    return comments;
  }

  private async workflowHowFeedback(context: WorkflowContext, id: string, comments: LinearComment[]): Promise<{ key: string; body: string } | null> {
    const agent = context.team.agent;
    if (!agent) return null; // Existing user OAuth connections need app authorization before native mentions.
    for (const comment of [...comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      if (!comment.user || comment.user.app || comment.user.id === agent.id || /<!-- oriel:/.test(comment.body)) continue;
      // Linear exports native user mentions as profile URLs in Markdown. Match
      // the authenticated app's exact profile, never its display name or @oriel.
      const urls = comment.body.match(/https:\/\/linear\.app\/[^\s<>()[\]]+/g) ?? [];
      if (!urls.some(url => url.replace(/[.,!?;:]+$/, "") === agent.url)) continue;
      const key = `how:${await digest([id, comment.id, comment.body])}`;
      const marker = await this.workflowMarker(context, "how-response", key);
      if (!comments.some(response => response.body.includes(marker))) return { key, body: comment.body };
    }
    return null;
  }

  private async workflowCursors(context: WorkflowContext, comments: GithubComment[], kind: "response" | "response-head"): Promise<Map<string, string>> {
    const cursors = new Map<string, string>();
    const pattern = new RegExp(`<!-- oriel:${kind}:([A-Za-z0-9_-]+):[A-Za-z0-9_-]+ -->`, "g");
    for (const comment of comments) for (const marker of comment.body.matchAll(pattern)) {
      try {
        const key = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(marker[1].replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0)));
        if (marker[0] === await this.workflowMarker(context, kind, key) && (!cursors.has(key) || comment.created_at < cursors.get(key)!)) cursors.set(key, comment.created_at);
      } catch { /* Unsigned public comments are never Oriel response cursors. */ }
    }
    return cursors;
  }

  private async workflowFeedback(context: WorkflowContext, pr: PullRequest, requestedKey?: string, exhausted?: string[]): Promise<Feedback | null> {
    const comments = await this.workflowList<GithubComment>(context, `${context.path}/issues/${pr.number}/comments`);
    const cursors = await this.workflowCursors(context, comments, "response");
    const reviews = await this.workflowList<{ id: number; state: string; body: string; submitted_at: string; user: { login: string } }>(context, `${context.path}/pulls/${pr.number}/reviews`);
    const inline = await this.workflowList<{ id: number; pull_request_review_id: number; path: string; line: number | null; body: string; commit_id: string }>(context, `${context.path}/pulls/${pr.number}/comments`);
    const latest = new Map<string, typeof reviews[number]>();
    for (const review of [...reviews].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))) {
      if (review.state !== "PENDING") latest.set(review.user.login, review);
    }
    for (const review of [...latest.values()].sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))) {
      if (review.state !== "CHANGES_REQUESTED") continue;
      const notes = inline.filter(comment => comment.pull_request_review_id === review.id);
      const key = `review:${await digest([pr.number, review.id, review.body, notes.map(note => [note.id, note.path, note.body])])}`;
      if ((requestedKey === undefined || requestedKey === key) && !cursors.has(key)) return { key, kind: "review", body: review.body, comments: notes.filter(note => note.line !== null || note.commit_id === pr.head_oid).map(note => ({ path: note.path, line: note.line, body: note.body })) };
    }
    for (const comment of [...comments].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
      if (comment.user.type !== "User" || !githubCommand(comment.body) || /<!-- oriel:/.test(comment.body)) continue;
      const key = `comment:${await digest([pr.number, comment.id, comment.body])}`;
      if ((requestedKey === undefined || requestedKey === key) && !cursors.has(key)) return { key, kind: "comment", body: comment.body, comments: [] };
    }
    type Check = { id: number; name: string; head_sha: string; status: string; conclusion: string | null; completed_at: string | null; output: { title: string | null; summary: string | null; text: string | null } };
    const checks: Check[] = [];
    for (let page = 1; ; page++) {
      const result = await this.workflowGithub<{ check_runs: Check[] }>(context, `${context.path}/commits/${pr.head_oid}/check-runs?filter=all&per_page=100&page=${page}`);
      if (!result) this.auth.fail(502, "PR checks are unavailable");
      checks.push(...result.check_runs);
      if (result.check_runs.length < 100) break;
    }
    const responseHeads = await this.workflowCursors(context, comments, "response-head");
    const heads = new Set([pr.head_oid]);
    for (const key of responseHeads.keys()) {
      const head = key.slice(key.lastIndexOf(":") + 1);
      if (OID.test(head)) heads.add(head);
    }
    const history = [...checks];
    const statusHistory: { id: number; context: string; state: string; description: string | null; created_at: string; head: string }[] = [];
    for (const head of heads) {
      if (head !== pr.head_oid) for (let page = 1; ; page++) {
        const result = await this.workflowGithub<{ check_runs: Check[] }>(context, `${context.path}/commits/${head}/check-runs?filter=all&per_page=100&page=${page}`);
        if (!result) this.auth.fail(502, "Check recovery facts are unavailable");
        history.push(...result.check_runs);
        if (result.check_runs.length < 100) break;
      }
      const statuses = await this.workflowList<{ id: number; context: string; state: string; description: string | null; created_at: string }>(context, `${context.path}/commits/${head}/statuses`);
      statusHistory.push(...statuses.map(status => ({ ...status, head })));
    }
    const byName = new Map<string, Check>();
    for (const check of checks.sort((a, b) => a.id - b.id)) byName.set(check.name, check);
    for (const check of byName.values()) {
      if (check.head_sha !== pr.head_oid || check.status !== "completed" || !["failure", "timed_out", "action_required", "cancelled", "startup_failure", "stale"].includes(check.conclusion ?? "")) continue;
      const name = await digest(check.name);
      const key = `check:${name}:${check.id}:${pr.head_oid}`;
      if (cursors.has(key)) continue;
      // Count unique signed response attempts since the latest actual successful run,
      // including prior response heads. No local history or repeated-comment echoes.
      const successful = history.filter(run => run.name === check.name && ["success", "neutral", "skipped"].includes(run.conclusion ?? "") && run.completed_at)
        .map(run => run.completed_at!).sort().at(-1) ?? "";
      const attempts = [...cursors].filter(([key, time]) => key.startsWith(`check:${name}:`) && time > successful).length;
      if (attempts >= 3) { exhausted?.push(check.name); continue; }
      if (requestedKey !== undefined && requestedKey !== key) continue;
      return { key, kind: "check_failure", body: `${check.name}: ${check.conclusion}\n${[check.output.title, check.output.summary, check.output.text].filter(Boolean).join("\n").slice(0, 16000)}`, comments: [] };
    }
    const latestStatus = new Map<string, typeof statusHistory[number]>();
    for (const status of statusHistory.filter(status => status.head === pr.head_oid).sort((a, b) => a.id - b.id)) latestStatus.set(status.context, status);
    for (const status of latestStatus.values()) {
      if (!["error", "failure"].includes(status.state)) continue;
      const key = `check:${await digest(status.context)}:status-${status.id}:${pr.head_oid}`;
      if (cursors.has(key)) continue;
      const prefix = `check:${await digest(status.context)}:`;
      const successful = statusHistory.filter(run => run.context === status.context && run.state === "success").map(run => run.created_at).sort().at(-1) ?? "";
      const attempts = [...cursors].filter(([key, time]) => key.startsWith(prefix) && time > successful).length;
      if (attempts >= 3) exhausted?.push(status.context);
      if (attempts < 3 && (requestedKey === undefined || requestedKey === key)) return { key, kind: "check_failure", body: `${status.context}: ${status.state}\n${status.description ?? ""}`, comments: [] };
    }
    return null;
  }

  async workflowAdmission(device: Device, claim: WorkflowClaim, check: () => void): Promise<WorkflowAdmission> {
    if (!["plan", "discuss", "implement", "respond", "reconcile"].includes(claim.kind) || !Number.isSafeInteger(claim.issue_number) || claim.issue_number <= 0 || !SECRET.test(claim.version) || claim.branch !== null && typeof claim.branch !== "string") this.auth.fail(400, "Invalid workflow claim");
    const context = await this.workflowContext(device, check);
    const { snapshot, recoveries } = await this.workflowFacts(context);
    const row = snapshot.workflows.find(row => row.issue.number === claim.issue_number);
    if (!row || row.version !== claim.version || row.branch !== claim.branch) this.auth.fail(409, "Workflow content or canonical branch changed");
    const allowed = claim.kind === "plan" ? ["needs-how", "triage"].includes(row.phase) && (!row.issue_feedback || row.issue_feedback.planning) :
      claim.kind === "discuss" ? row.issue.state === "open" && !!row.issue_feedback :
      claim.kind === "implement" ? ["approved", "running"].includes(row.phase) :
      claim.kind === "respond" ? row.phase === "review" && !!row.feedback :
      row.phase === "merged" || row.phase === "done" || row.phase === "blocked" && row.recovery === "invalidate";
    if (!allowed) this.auth.fail(409, row.blocked_reason ?? "Workflow phase does not admit this operation");
    context.check();
    return { ...claim, linear_id: row.linear?.id ?? null,
      ...(claim.kind === "plan" ? { initial_what_version: await digest(["oriel/what-version/v1", snapshot.repository_node_id, row.issue.node_id, row.issue.title, row.issue.body ?? ""]) } : {}),
      ...(["plan", "discuss"].includes(claim.kind) && row.issue_feedback ? { issue_feedback: { key: row.issue_feedback.key } } : {}),
      task: { issue_number: row.issue.number, title: row.issue.title, url: row.issue.url,
        how_identifier: row.linear?.identifier ?? null, how_url: row.linear?.url ?? null },
      ...(claim.kind === "respond" && row.feedback && row.pull_request ? { feedback: { key: row.feedback.key, head_oid: row.pull_request.head_oid, pr_number: row.pull_request.number } } : {}),
      ...(["implement", "respond"].includes(claim.kind) ? { execution: { target_oid: snapshot.target_oid, base_branch: snapshot.base_branch, verification: snapshot.configuration.verification } } : {}),
      ...(claim.kind === "reconcile" && row.recovery === "invalidate" ? { recovery: { branch: recoveries.get(row.issue.number)! } } : {}) };
  }

  async workflow(request: Request, authority: WorkflowAuthority): Promise<Response> {
    const url = new URL(request.url);
    const route = /^\/api\/workflows\/([a-f0-9]{32})(?:\/(issues|actions|git-token))?$/.exec(url.pathname);
    if (!route || url.search || request.method !== (route[2] ? "POST" : "GET")) this.auth.fail(404, "Not found");
    let session: Session | undefined;
    let device: Device;
    if (route[2] === "issues") {
      if (request.headers.has("Authorization")) this.auth.fail(403, "WHAT creation requires an owning browser session");
      if (request.headers.get("Origin") !== this.env.PUBLIC_ORIGIN) this.auth.fail(403, "Invalid browser Origin");
      session = await this.auth.session(request);
      const owned = this.sql.exec<Device>("SELECT * FROM devices WHERE device_id = ?", route[1]).toArray()[0];
      if (!owned || owned.user_id !== session.user.id) this.auth.fail(403, "Device belongs to another account");
      device = owned;
    } else if (request.headers.has("Authorization") || route[2]) device = await this.auth.host(request, route[1]);
    else {
      session = await this.auth.session(request);
      const owned = this.sql.exec<Device>("SELECT * FROM devices WHERE device_id = ?", route[1]).toArray()[0];
      if (!owned || owned.user_id !== session.user.id) this.auth.fail(403, "Device belongs to another account");
      device = owned;
    }
    const check = () => { if (session) this.auth.liveSession(session); this.liveDevice(device); };
    check();
    try {
      if (!route[2]) return this.auth.json((await this.workflowFacts(await this.workflowContext(device, check))).snapshot);
      const body = await this.auth.body(request);
      check();
      if (route[2] === "issues") return this.auth.json({ issue: await this.workflowCreateWhat(await this.workflowContext(device, check, true), body) });
      if (typeof body.lease_id !== "string" || !body.lease_id) this.auth.fail(400, "A live workflow lease is required");
      const grant = authority.verify(device, body.lease_id);
      const leased = () => { check(); authority.verify(device, grant.lease_id); };
      const context = await this.workflowContext(device, leased, route[2] === "actions");
      if (route[2] === "git-token") {
        if (!["plan", "discuss", "implement", "respond"].includes(grant.kind)) this.auth.fail(409, "Reconciliation does not need Git credentials");
        if (["plan", "discuss"].includes(grant.kind)) await this.workflowCurrent(context, grant);
        else {
          const current = await this.workflowCurrent(context, grant, grant.kind === "implement" ? ["running"] : ["review"]);
          if (!current.row.canonical_oid) this.auth.fail(409, "Code Git credentials require a current matching sealed branch");
          if (grant.kind === "respond") {
            if (!grant.feedback || current.row.pull_request?.number !== grant.feedback.pr_number ||
              !(await this.workflowFeedback(context, { ...current.row.pull_request, head_oid: grant.feedback.head_oid }, grant.feedback.key))) this.auth.fail(409, "Admitted response feedback is no longer current");
          }
        }
        leased();
        return this.auth.json(await this.installationToken(device.user_id, leased, { contents: ["plan", "discuss"].includes(grant.kind) ? "read" : "write", metadata: "read" }));
      }
      return this.auth.json(await this.workflowAction(context, grant, body));
    } catch (error) {
      if (error instanceof Error && "status" in error) throw error;
      this.auth.fail(502, "Workflow provider state could not be confirmed; no approval was inferred");
    }
  }

  private async workflowCreateWhat(context: WorkflowContext, body: Record<string, unknown>): Promise<GithubWhat> {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 256 || typeof body.body !== "string" || body.body.length > 60000 || typeof body.request_id !== "string" || !UUID.test(body.request_id)) this.auth.fail(400, "Invalid WHAT creation request");
    const identity = `${context.repository.repository_id}:${body.request_id.toLowerCase()}`;
    const pending = this.whatCreations.get(identity);
    const operation = (async () => {
      if (pending) try { await pending; } catch { /* Re-read stable external identity, never repeat an unknown payload blindly. */ }
      const marker = await this.workflowMarker(context, "what", (body.request_id as string).toLowerCase());
      const content = `${body.body}\n\n${marker}`;
      const read = async () => {
        const issues = await this.workflowList<GithubWhat & { html_url: string; pull_request?: unknown }>(context, `${context.path}/issues?state=all`);
        const matching = issues.filter(issue => !issue.pull_request && issue.body?.includes(marker));
        if (matching.length > 1) this.auth.fail(409, "WHAT creation identity is ambiguous");
        if (matching[0] && (matching[0].title !== body.title || matching[0].body !== content)) this.auth.fail(409, "WHAT creation request ID was already used or edited");
        return matching[0] ?? null;
      };
      let issue = await read();
      if (!issue) {
        context.check();
        try { await this.workflowGithub(context, `${context.path}/issues`, "POST", { title: body.title, body: content }); }
        catch (error) { if (error instanceof Error && "status" in error && error.status !== 502) throw error; }
        issue = await read();
        if (!issue) this.auth.fail(502, "WHAT creation is unconfirmed; retry the same request_id");
      }
      return { number: issue.number, node_id: issue.node_id, title: issue.title, body: issue.body, url: issue.html_url, state: issue.state };
    })();
    this.whatCreations.set(identity, operation);
    try { return await operation; }
    finally { if (this.whatCreations.get(identity) === operation) this.whatCreations.delete(identity); }
  }

  private async workflowCurrent(context: WorkflowContext, grant: WorkflowGrant, phases?: WorkflowRow["phase"][], changed = false): Promise<{ facts: WorkflowFacts; row: WorkflowRow }> {
    const facts = await this.workflowFacts(context);
    const row = facts.snapshot.workflows.find(row => row.issue.number === grant.issue_number);
    if (!row || (row.linear?.id ?? null) !== grant.linear_id && !(grant.kind === "plan" && grant.linear_id === null && row.phase === "triage")) this.auth.fail(409, "Formal workflow identity changed");
    const recoveredPlan = grant.kind === "plan" && grant.linear_id === null && row.phase === "triage" && await digest(["oriel/what-version/v1", facts.snapshot.repository_node_id, row.issue.node_id, row.issue.title, row.issue.body ?? ""]) === (grant.initial_what_version ?? grant.version);
    if (!changed && !recoveredPlan && (row.version !== grant.version || row.branch !== grant.branch)) this.auth.fail(409, "Workflow approval content changed");
    if (phases && !phases.includes(row.phase)) this.auth.fail(409, row.blocked_reason ?? "Workflow native state no longer admits this operation");
    if (grant.issue_feedback && row.issue_feedback?.key !== grant.issue_feedback.key && !recoveredPlan) this.auth.fail(409, "Admitted Issue request was edited, deleted or answered");
    if (grant.execution && phases?.some(phase => ["approved", "running", "review"].includes(phase)) &&
      (facts.snapshot.target_oid !== grant.execution.target_oid || facts.snapshot.base_branch !== grant.execution.base_branch || !facts.snapshot.configuration.autonomous ||
       JSON.stringify(facts.snapshot.configuration.verification) !== JSON.stringify(grant.execution.verification))) this.auth.fail(409, "Commit-pinned execution target or verification configuration changed");
    context.check();
    return { facts, row };
  }

  private async workflowUpdateHow(context: WorkflowContext, grant: WorkflowGrant, input: { stateId?: string; title?: string; description?: string }, phases: WorkflowRow["phase"][], changed = false, expectedHead?: string): Promise<LinearHow> {
    let current = await this.workflowCurrent(context, grant, phases, changed);
    if (!current.row.linear) this.auth.fail(409, "A unique HOW is required");
    const id = current.row.linear.id;
    const before = current.row.linear;
    let expected = input;
    const matches = (how: LinearHow) => (expected.stateId === undefined || how.state.id === expected.stateId) &&
      (expected.title === undefined || how.title === expected.title) && (expected.description === undefined || how.description === expected.description);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (input.stateId) {
        const state = current.row.linear!.state;
        const target = current.facts.states.find(candidate => candidate.id === input.stateId);
        const review = current.facts.states.filter(candidate => candidate.type === "started" && /review/i.test(candidate.name));
        const targetAllowed = target && (target.name === "Triage" && target.type === "triage" || target.name === "Todo" && target.type === "unstarted" || target.name === "In Progress" && target.type === "started" || target.name === "Done" && target.type === "completed" || review.length === 1 && target.id === review[0].id);
        if (!target || !targetAllowed || current.facts.states.filter(candidate => candidate.name === target.name && candidate.type === target.type).length !== 1 ||
          !current.row.fingerprint || !current.facts.states.some(candidate => candidate.id === state.id && candidate.name === state.name && candidate.type === state.type)) this.auth.fail(409, "Native HOW transition identity changed");
        if (matches(current.row.linear!)) return current.row.linear!;
        if (state.type === "completed" || state.type === "canceled") this.auth.fail(409, "Completed or canceled HOW is not overwritten");
        if (target.name === "Triage" && !(state.name === "Todo" && state.type === "unstarted" || state.name === "In Progress" && state.type === "started" || review.length === 1 && state.id === review[0].id)) this.auth.fail(409, "Native HOW state cannot be safely returned to Triage");
      } else if (matches(current.row.linear!)) return current.row.linear!;
      if (expectedHead && (current.row.canonical_oid !== expectedHead || current.row.pull_request?.head_oid !== expectedHead)) this.auth.fail(409, "Verified PR head changed before progress reflection");
      if (expectedHead) {
        const pr = current.row.pull_request;
        if (!pr || !current.row.branch) this.auth.fail(409, "Verified PR identity is unavailable");
        const native = await this.workflowGithub<GithubPull>(context, `${context.path}/pulls/${pr.number}`);
        const ref = await this.workflowGithub<{ object: { sha: string } }>(context, `${context.path}/git/ref/heads/${encodeURIComponent(current.row.branch)}`, "GET", undefined, true);
        if (!native || native.state !== "open" || native.merged_at || native.draft || native.head.ref !== current.row.branch ||
          native.head.sha !== expectedHead || ref?.object.sha !== expectedHead) this.auth.fail(409, "Verified PR changed before progress reflection");
      }
      // Facts scans perform more reads after collecting HOWs. Do not write from
      // that older copy: preserve human edits and terminal-state transitions.
      const baseline = current.facts.hows.find(how => how.id === id);
      const fresh = await this.workflowHow(context, id);
      if (!baseline || !fresh) this.auth.fail(409, "Human changes prevented the HOW update (missing HOW)");
      const differences = [
        ["team", fresh.team.id !== context.team.team_id],
        ["identifier", fresh.identifier !== baseline.identifier],
        ["title", fresh.title !== baseline.title],
        ["description", fresh.description !== baseline.description],
        ["state", fresh.state.id !== baseline.state.id || fresh.state.name !== baseline.state.name || fresh.state.type !== baseline.state.type],
        ["attachments", fresh.attachments.length !== baseline.attachments.length || fresh.attachments.some((attachment, index) => attachment.url !== baseline.attachments[index].url)],
      ].filter(([, differs]) => differs).map(([field]) => field);
      if (differences.length) this.auth.fail(409, `Human changes prevented the HOW update (${differences.join(", ")})`);
      context.check();
      try {
        const result = await this.workflowLinear<{ issueUpdate: { success: boolean; issue: { id: string; title: string; description: string | null } | null } }>(context,
          "mutation($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success issue{id title description}}}", { id, input });
        const saved = result.issueUpdate.issue;
        if (result.issueUpdate.success === true && saved?.id === id) {
          // Linear canonicalizes Markdown. Confirm its own mutation receipt against
          // a fresh read, not the pre-canonicalized request; unknown sends stay strict.
          const canonical = { ...input };
          if (input.title !== undefined) {
            if (typeof saved.title !== "string") this.auth.fail(502, "HOW update receipt is unavailable");
            canonical.title = saved.title;
          }
          if (input.description !== undefined) {
            if (typeof saved.description !== "string") this.auth.fail(502, "HOW update receipt is unavailable");
            canonical.description = saved.description;
          }
          expected = canonical;
        }
      }
      catch (error) { if (error instanceof Error && "status" in error && error.status !== 502) throw error; }
      const how = await this.workflowHow(context, id);
      if (!how || how.team.id !== context.team.team_id) this.auth.fail(409, "HOW update identity is unavailable");
      if (matches(how)) { const { team: _team, attachments: _attachments, ...linear } = how; return linear; }
      if (how.title !== before.title || how.description !== before.description || how.state.id !== before.state.id) this.auth.fail(409, "Human changes prevented the HOW update");
      current = await this.workflowCurrent(context, grant, phases, changed);
    }
    this.auth.fail(502, "HOW update could not be confirmed");
  }

  private workflowState(states: LinearState[], name: string, type: string): LinearState {
    const matching = states.filter(state => state.name === name && state.type === type);
    if (matching.length !== 1) this.auth.fail(409, `Selected Linear team needs one native ${name} state`);
    return matching[0];
  }

  private async workflowSourceChange(context: WorkflowContext, base: string, head: string, files: { filename: string }[]): Promise<boolean> {
    const source = (path: string) => !/(^|\/)(HANDOFF\.md|\.oriel\.yaml)$/.test(path) && !/\.md$/i.test(path);
    if (files.some(file => source(file.filename))) return true;
    if (files.length < 300) return false;
    // GitHub caps compare's changed-file summary at 300. Walk only differing native
    // trees rather than treating documentation-heavy summaries as a proof of no code.
    const before = await this.workflowGithub<{ tree: { sha: string } }>(context, `${context.path}/git/commits/${base}`);
    const after = await this.workflowGithub<{ tree: { sha: string } }>(context, `${context.path}/git/commits/${head}`);
    if (!before || !after) this.auth.fail(502, "Source-change commit facts are unavailable");
    type Tree = { tree: { path: string; type: string; sha: string }[]; truncated: boolean };
    const pending: { path: string; before: string | null; after: string | null }[] = [{ path: "", before: before.tree.sha, after: after.tree.sha }];
    while (pending.length) {
      const item = pending.pop()!;
      if (item.before === item.after) continue;
      const left = item.before ? await this.workflowGithub<Tree>(context, `${context.path}/git/trees/${item.before}`) : { tree: [], truncated: false };
      const right = item.after ? await this.workflowGithub<Tree>(context, `${context.path}/git/trees/${item.after}`) : { tree: [], truncated: false };
      if (!left || !right || left.truncated || right.truncated) this.auth.fail(409, "Source tree is incomplete; no PR may be inferred from uncertain output");
      const old = new Map(left.tree.map(entry => [entry.path, entry]));
      const next = new Map(right.tree.map(entry => [entry.path, entry]));
      for (const name of new Set([...old.keys(), ...next.keys()])) {
        const a = old.get(name); const b = next.get(name);
        if (a?.sha === b?.sha && a?.type === b?.type) continue;
        const path = `${item.path}${name}`;
        if ((a && a.type !== "tree" || b && b.type !== "tree") && source(path)) return true;
        if (a?.type === "tree" || b?.type === "tree") pending.push({ path: `${path}/`, before: a?.type === "tree" ? a.sha : null, after: b?.type === "tree" ? b.sha : null });
      }
    }
    return false;
  }

  private async workflowComment(context: WorkflowContext, grant: WorkflowGrant, kind: string, key: string, text: string, githubPr: number | null = null, changed = false, expectedHead?: string): Promise<void> {
    const issueComment = kind.startsWith("issue-");
    if (issueComment && (githubPr !== grant.issue_number || grant.issue_feedback?.key !== key)) this.auth.fail(403, "Issue replies require the admitted comment identity");
    const marker = await this.workflowMarker(context, kind, key);
    const content = `${text}\n\n${marker}`;
    const read = async () => githubPr === null ? (await this.workflowLinearComments(context, grant.linear_id!)).map(comment => comment.body) :
      (await this.workflowList<GithubComment>(context, `${context.path}/issues/${githubPr}/comments`))
        .filter(comment => !issueComment || comment.user?.type === "Bot").map(comment => comment.body);
    if ((await read()).some(body => body.includes(marker))) return;
    const current = await this.workflowCurrent(context, grant, githubPr === null || issueComment ? undefined : ["review"], changed);
    if (issueComment && current.row.issue_feedback?.key !== key) this.auth.fail(409, "Admitted Issue request was edited, deleted or answered");
    if (githubPr !== null && !issueComment && current.row.pull_request?.number !== githubPr) this.auth.fail(409, "Response PR identity changed");
    if (expectedHead && (current.row.canonical_oid !== expectedHead || current.row.pull_request?.head_oid !== expectedHead)) this.auth.fail(409, "Verified response head changed before publication");
    context.check();
    try {
      if (githubPr === null) {
        const hash = await digest(["oriel/comment/v1", context.repository.repository_id, grant.linear_id, kind, key]);
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        await this.workflowCurrent(context, grant, undefined, changed);
        await this.workflowLinear(context, "mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}", { input: { id, issueId: grant.linear_id, body: content } });
      } else await this.workflowGithub(context, `${context.path}/issues/${githubPr}/comments`, "POST", { body: content });
    } catch (error) { if (error instanceof Error && "status" in error && error.status !== 502) throw error; }
    if (!(await read()).some(body => body.includes(marker))) this.auth.fail(502, "Workflow response is unconfirmed; retry with the same content identity");
  }

  private async workflowIssuePlanReply(context: WorkflowContext, grant: WorkflowGrant, linear: LinearHow, summary: unknown): Promise<void> {
    if (!grant.issue_feedback) return;
    if (typeof summary !== "string" || !summary.trim() || summary.length > 12000) this.auth.fail(400, "A bounded model reply is required for Issue planning");
    const { snapshot } = await this.workflowFacts(context);
    const row = snapshot.workflows.find(row => row.issue.number === grant.issue_number);
    if (!row || row.phase !== "triage" || row.linear?.id !== linear.id || row.linear.title !== linear.title || row.linear.description !== linear.description) this.auth.fail(409, "HOW changed before the Issue reply");
    if (await digest(["oriel/what-version/v1", snapshot.repository_node_id, row.issue.node_id, row.issue.title, row.issue.body ?? ""]) !== grant.initial_what_version) this.auth.fail(409, "WHAT changed before the Issue reply");
    // A completed initial HOW remains recoverable after its request is removed.
    // Reply only while the admitted comment is still pending.
    if (grant.linear_id === null && row.issue_feedback?.key !== grant.issue_feedback.key) return;
    await this.workflowComment(context, { ...grant, linear_id: linear.id, version: row.version, branch: row.branch }, "issue-response", grant.issue_feedback.key,
      `${summary}\n\nHOW: ${linear.url}`, grant.issue_number);
  }

  private async workflowAction(context: WorkflowContext, grant: WorkflowGrant, body: Record<string, unknown>): Promise<unknown> {
    const action = body.action;
    const kind = action === "proposal" || action === "started" ? "plan" : action === "answered" ? "discuss" : action === "begin" || action === "publish" ? "implement" :
      action === "responded" ? "respond" : action === "done" ? "reconcile" : action === "invalidate" || action === "fail" ? grant.kind : null;
    if (!kind || kind !== grant.kind) this.auth.fail(403, "Workflow action is not allowed by this lease");
    if (action === "started") {
      const { row } = await this.workflowCurrent(context, grant, ["needs-how", "triage"]);
      if (!grant.issue_feedback || !row.issue_feedback?.planning) this.auth.fail(409, "A current Issue HOW request is required");
      await this.workflowComment(context, grant, "issue-started", grant.issue_feedback.key,
        "HOWの計画を開始しました。結果はLinearのTriageに作成・更新し、このIssueにも返信します。", grant.issue_number);
      return { started: true };
    }
    if (action === "answered") {
      if (!grant.issue_feedback || typeof body.summary !== "string" || !body.summary.trim() || body.summary.length > 12000) this.auth.fail(400, "An admitted Issue request and bounded reply are required");
      await this.workflowComment(context, grant, "issue-response", grant.issue_feedback.key, body.summary, grant.issue_number);
      return { answered: true };
    }
    if (action === "fail" && ["plan", "discuss"].includes(grant.kind)) {
      const { row } = await this.workflowCurrent(context, grant);
      if (grant.issue_feedback && row.issue_feedback?.key === grant.issue_feedback.key) await this.workflowComment(context, grant, "issue-response", grant.issue_feedback.key,
        "依頼の処理中にエラーが発生したため停止しました。依頼コメントを編集するか、新しいコメントで再依頼してください。詳細はworkflowを起動した端末のログを確認してください。", grant.issue_number);
      return { stopped: true };
    }
    if (action === "proposal") {
      if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 256 || typeof body.description !== "string" || !body.description.trim() || body.description.length > 60000) this.auth.fail(400, "A bounded HOW title and description are required");
      if (body.summary !== undefined && (typeof body.summary !== "string" || !body.summary.trim() || body.summary.length > 12000)) this.auth.fail(400, "A bounded model reply is required");
      if (grant.issue_feedback) {
        if (typeof body.summary !== "string") this.auth.fail(400, "A model reply is required for Issue planning");
        const marker = await this.workflowMarker(context, "issue-response", grant.issue_feedback.key);
        const comments = await this.workflowList<GithubComment>(context, `${context.path}/issues/${grant.issue_number}/comments`);
        if (comments.some(comment => comment.user?.type === "Bot" && comment.body.includes(marker))) {
          const { snapshot } = await this.workflowFacts(context);
          return { linear: snapshot.workflows.find(row => row.issue.number === grant.issue_number)?.linear ?? null };
        }
      }
      let initial: { facts: WorkflowFacts; row: WorkflowRow };
      try { initial = await this.workflowCurrent(context, grant, ["needs-how", "triage"]); }
      catch (error) {
        if (!(error instanceof Error) || !("status" in error) || error.status !== 409 || grant.linear_id === null) throw error;
        const facts = await this.workflowFacts(context);
        const row = facts.snapshot.workflows.find(row => row.issue.number === grant.issue_number);
        if (row?.phase !== "triage" || row.linear?.id !== grant.linear_id || row.linear.title !== body.title || row.linear.description !== body.description) throw error;
        if (row.how_feedback && !grant.issue_feedback) {
          if (typeof body.summary !== "string") this.auth.fail(400, "A model reply is required for HOW feedback");
          await this.workflowComment(context, { ...grant, version: row.version, branch: row.branch }, "how-response", row.how_feedback.key, body.summary);
        }
        await this.workflowIssuePlanReply(context, grant, row.linear, body.summary);
        return { linear: row.linear };
      }
      if (initial.row.linear) {
        if (grant.linear_id === null) {
          await this.workflowIssuePlanReply(context, grant, initial.row.linear, body.summary);
          return { linear: initial.row.linear };
        }
        const feedback = grant.issue_feedback ? null : initial.row.how_feedback;
        const reply = typeof body.summary === "string" ? body.summary : null;
        if (feedback && reply === null) this.auth.fail(400, "A model reply is required for HOW feedback");
        const linear = await this.workflowUpdateHow(context, grant, { title: body.title, description: body.description }, ["triage"]);
        if (feedback && reply !== null) {
          const version = await digest(["oriel/approval-fingerprint/v1", initial.facts.snapshot.repository_node_id, initial.row.issue.node_id, initial.row.issue.title, initial.row.issue.body ?? "", linear.id, linear.title, linear.description ?? ""]);
          await this.workflowComment(context, { ...grant, linear_id: linear.id, version, branch: `oriel/${linear.identifier}-gh-${grant.issue_number}-${version}` }, "how-response", feedback.key, reply);
        }
        await this.workflowIssuePlanReply(context, grant, linear, body.summary);
        return { linear };
      }
      const hash = await digest(["oriel/how/v1", initial.facts.snapshot.repository_node_id, initial.row.issue.node_id, context.team.team_id]);
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const triage = this.workflowState(initial.facts.states, "Triage", "triage");
      let how = await this.workflowHow(context, id);
      if (!how) {
        await this.workflowCurrent(context, grant, ["needs-how"]);
        try { await this.workflowLinear(context, "mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{id}}}", { input: { id, teamId: context.team.team_id, stateId: triage.id, title: body.title, description: body.description } }); }
        catch (error) { if (error instanceof Error && "status" in error && error.status !== 502) throw error; }
        how = await this.workflowHow(context, id);
        if (!how) this.auth.fail(502, "HOW creation is unconfirmed; retry the same workflow");
      }
      if (how.team.id !== context.team.team_id || how.state.id !== triage.id) this.auth.fail(409, "Recovered HOW was changed by a human; no overwrite or approval is inferred");
      const url = initial.row.issue.url;
      if (how.attachments.some(attachment => attachment.url !== url && /github\.com\/.*\/issues\//i.test(attachment.url))) this.auth.fail(409, "Recovered HOW has a foreign formal link");
      if (!how.attachments.some(attachment => attachment.url === url)) {
        await this.workflowCurrent(context, grant, ["needs-how"]);
        const attachmentHash = await digest(["oriel/how-attachment/v1", id, url]);
        const attachmentId = `${attachmentHash.slice(0, 8)}-${attachmentHash.slice(8, 12)}-4${attachmentHash.slice(13, 16)}-a${attachmentHash.slice(17, 20)}-${attachmentHash.slice(20, 32)}`;
        try { await this.workflowLinear(context, "mutation($input:AttachmentCreateInput!){attachmentCreate(input:$input){success}}", { input: { id: attachmentId, issueId: id, url, title: initial.row.issue.title } }); }
        catch (error) { if (error instanceof Error && "status" in error && error.status !== 502) throw error; }
        how = await this.workflowHow(context, id);
        if (!how?.attachments.some(attachment => attachment.url === url)) this.auth.fail(502, "HOW formal link is unconfirmed; retry the same workflow");
      }
      const current = await this.workflowFacts(context);
      const row = current.snapshot.workflows.find(row => row.issue.number === grant.issue_number);
      if (row?.phase !== "triage" || row.linear?.id !== id || row.issue.title !== initial.row.issue.title || row.issue.body !== initial.row.issue.body) this.auth.fail(409, "HOW formal identity changed during proposal");
      await this.workflowIssuePlanReply(context, grant, row.linear, body.summary);
      return { linear: row.linear };
    }
    if (action === "begin") {
      let { facts, row } = await this.workflowCurrent(context, grant, ["approved", "running"]);
      if (!row.branch || !row.linear || !facts.snapshot.configuration.autonomous) this.auth.fail(409, "Current approval and target opt-in are required");
      if (!row.canonical_oid) {
        // Both comparisons are one provider transaction; never degrade to sequential ref creation.
        await this.workflowCurrent(context, grant, ["approved"]);
        context.check();
        try {
          await fetch("https://api.github.com/graphql", { method: "POST", headers: { Authorization: `Bearer ${context.github}`, "Content-Type": "application/json", "User-Agent": "Oriel" },
            body: JSON.stringify({ query: "mutation($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}", variables: { input: {
              repositoryId: facts.snapshot.repository_node_id, refUpdates: [
                { name: `refs/heads/${facts.snapshot.base_branch}`, beforeOid: facts.snapshot.target_oid, afterOid: facts.snapshot.target_oid, force: false },
                { name: `refs/heads/${row.branch}`, beforeOid: "0".repeat(40), afterOid: facts.snapshot.target_oid, force: false },
              ],
            } } }), redirect: "manual" });
        } catch { /* Read the exact ref after an uncertain atomic send. */ }
        context.check();
        const after = await this.workflowCurrent(context, grant, ["approved", "running"]);
        if (!after.row.canonical_oid) this.auth.fail(409, "Atomic updateRefs sealing was rejected or unavailable; no weaker fallback is permitted");
        if (after.row.canonical_oid !== facts.snapshot.target_oid) this.auth.fail(409, "Canonical ref changed during sealing");
        facts = after.facts; row = after.row;
      }
      // Existing same-fingerprint refs are adopted without reset.
      if (row.linear!.state.name === "Todo") await this.workflowUpdateHow(context, grant, { stateId: this.workflowState(facts.states, "In Progress", "started").id }, ["approved"]);
      const current = await this.workflowCurrent(context, grant, ["running"]);
      return { branch: current.row.branch, canonical_oid: current.row.canonical_oid, target_oid: current.facts.snapshot.target_oid,
        base_branch: current.facts.snapshot.base_branch, verification: current.facts.snapshot.configuration.verification };
    }
    if (action === "publish") {
      if (body.verified !== true || typeof body.head_oid !== "string" || !OID.test(body.head_oid) || typeof body.summary !== "string" || body.summary.length > 12000) this.auth.fail(400, "Publication requires a verified commit and bounded summary");
      let { facts, row } = await this.workflowCurrent(context, grant, ["running", "review"]);
      if (!row.branch || row.canonical_oid !== body.head_oid) this.auth.fail(409, "Verified commit does not match the current canonical remote head");
      const compare = await this.workflowGithub<{ status: string; total_commits: number; files: { filename: string; status: string }[] }>(context, `${context.path}/compare/${facts.snapshot.target_oid}...${body.head_oid}`);
      if (!compare || compare.status !== "ahead" || compare.total_commits < 1 || !await this.workflowSourceChange(context, facts.snapshot.target_oid, body.head_oid, compare.files)) this.auth.fail(409, "PR requires actual source changes on a verified non-diverged head");
      if (!row.pull_request) {
        const before = await this.workflowCurrent(context, grant, ["running"]);
        if (before.row.canonical_oid !== body.head_oid) this.auth.fail(409, "Verified canonical head changed before PR creation");
        const ref = await this.workflowGithub<{ object: { sha: string } }>(context, `${context.path}/git/ref/heads/${encodeURIComponent(row.branch)}`, "GET", undefined, true);
        if (ref?.object.sha !== body.head_oid) this.auth.fail(409, "Verified canonical head changed before PR creation");
        try { await this.workflowGithub(context, `${context.path}/pulls`, "POST", { head: row.branch, base: facts.snapshot.base_branch, title: row.issue.title, body: `Closes #${row.issue.number}`, draft: false }); }
        catch (error) { if (error instanceof Error && "status" in error && error.status !== 502) throw error; }
        ({ facts, row } = await this.workflowCurrent(context, grant, ["review"]));
      }
      if (!row.pull_request || row.pull_request.state !== "open" || row.pull_request.merged || row.pull_request.draft || row.pull_request.head_oid !== body.head_oid) this.auth.fail(409, "Ready PR creation could not be confirmed by its natural key");
      const reviews = facts.states.filter(state => state.type === "started" && /review/i.test(state.name));
      if (row.linear?.state.name === "In Progress" && reviews.length === 1) await this.workflowUpdateHow(context, grant, { stateId: reviews[0].id }, ["review"], false, body.head_oid);
      const confirmed = await this.workflowCurrent(context, grant, ["review"]);
      if (confirmed.row.pull_request?.head_oid !== body.head_oid || confirmed.row.canonical_oid !== body.head_oid) this.auth.fail(409, "Verified PR head changed before publication confirmation");
      return { pull_request: confirmed.row.pull_request };
    }
    if (action === "responded") {
      if (body.verified !== true || typeof body.head_oid !== "string" || !OID.test(body.head_oid) || typeof body.feedback_key !== "string" || typeof body.summary !== "string" || !body.summary.trim() || body.summary.length > 12000) this.auth.fail(400, "Response requires verified head, current feedback identity and bounded summary");
      const current = await this.workflowCurrent(context, grant, ["review"]);
      const pr = current.row.pull_request!;
      if (pr.head_oid !== body.head_oid || current.row.canonical_oid !== body.head_oid) this.auth.fail(409, "Response commit does not match the current PR and canonical heads");
      if (!grant.feedback || grant.feedback.key !== body.feedback_key || grant.feedback.pr_number !== pr.number) this.auth.fail(409, "Response does not match the lease's admitted feedback");
      const original = await this.workflowFeedback(context, { ...pr, head_oid: grant.feedback.head_oid }, body.feedback_key);
      const valid = original?.key === body.feedback_key;
      const marker = await this.workflowMarker(context, "response", body.feedback_key);
      const comments = await this.workflowList<GithubComment>(context, `${context.path}/issues/${pr.number}/comments`);
      if (!valid && !comments.some(comment => comment.body.includes(marker))) this.auth.fail(409, "Feedback identity is no longer actionable");
      const headMarker = body.feedback_key.startsWith("check:") ? `\n\n${await this.workflowMarker(context, "response-head", `${body.feedback_key}:${body.head_oid}`)}` : "";
      await this.workflowComment(context, grant, "response", body.feedback_key, `Oriel verified review fixes at ${body.head_oid}.\n\n${body.summary}${headMarker}`, pr.number, false, body.head_oid);
      return { pull_request: (await this.workflowCurrent(context, grant, ["review"])).row.pull_request };
    }
    if (action === "done") {
      const current = await this.workflowCurrent(context, grant, ["merged", "done"]);
      if (!current.row.pull_request?.merged) this.auth.fail(409, "Only an actual merged managed PR can complete the HOW");
      if (current.row.linear?.state.type === "canceled") this.auth.fail(409, "Canceled HOW is not overwritten");
      const linear = await this.workflowUpdateHow(context, grant, { stateId: this.workflowState(current.facts.states, "Done", "completed").id }, ["merged", "done"]);
      return { linear };
    }
    if (action === "invalidate" || action === "fail") {
      if (["plan", "discuss"].includes(grant.kind) || grant.kind === "reconcile" && (action !== "invalidate" || !grant.recovery)) this.auth.fail(403, "Only owned code work or admitted stale-approval reconciliation can be changed");
      const current = await this.workflowCurrent(context, grant, undefined, action === "invalidate");
      if (!current.row.linear || current.row.phase === "blocked" && current.row.fingerprint === null) this.auth.fail(409, "Unknown or ambiguous approval is not overwritten");
      if (grant.recovery && current.row.phase !== "triage" && (current.row.recovery !== "invalidate" || current.facts.recoveries.get(grant.issue_number) !== grant.recovery.branch)) this.auth.fail(409, "Prior canonical recovery evidence changed");
      if (action === "invalidate" && !grant.recovery && current.row.version === grant.version) this.auth.fail(409, "Approval content has not changed");
      const state = current.row.linear.state;
      if (state.type === "completed" || state.type === "canceled") return { linear: current.row.linear };
      if (current.row.phase === "triage") return { linear: current.row.linear };
      const known = current.facts.states.some(candidate => candidate.id === state.id && candidate.name === state.name && candidate.type === state.type);
      if (!known || !(state.name === "Todo" && state.type === "unstarted" || state.name === "In Progress" && state.type === "started" || state.type === "started" && /review/i.test(state.name))) this.auth.fail(409, "Native HOW state cannot be safely updated");
      if (action === "fail") {
        if (typeof body.reason !== "string" || !body.reason.trim()) this.auth.fail(400, "A failure reason is required");
        let reason = body.reason.slice(0, 4000);
        for (const secret of [context.github, context.linear, this.env.GITHUB_CLIENT_SECRET, this.env.INTEGRATION_ENCRYPTION_KEY, grant.binding.host_hash].filter((value): value is string => !!value)) reason = reason.replaceAll(secret, "[redacted]");
        reason = reason.replace(/Bearer\s+\S+|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/gi, "[redacted]");
        await this.workflowComment(context, grant, "failure", `${grant.version}:${await digest(reason)}`, `Oriel stopped without publishing: ${reason}`);
      }
      const obsoleteBranch = grant.recovery?.branch ?? grant.branch;
      if (action === "invalidate" && obsoleteBranch) {
        const obsolete = current.facts.pulls.filter(pr => pr.head.ref === obsoleteBranch && pr.head.repo?.id === context.repository.repository_id && pr.base.repo.id === context.repository.repository_id &&
          pr.state === "open" && !pr.merged_at && !pr.draft && pr.body?.trim() === `Closes #${grant.issue_number}`);
        if (obsolete.length > 1) this.auth.fail(409, "Obsolete PR identity is ambiguous");
        if (obsolete[0]) {
          await this.workflowCurrent(context, grant, undefined, true);
          try { await this.workflowGithub(context, `${context.path}/pulls/${obsolete[0].number}`, "PATCH", { state: "closed" }); }
          catch (error) { if (error instanceof Error && "status" in error && error.status !== 502) throw error; }
          const readback = await this.workflowGithub<GithubPull>(context, `${context.path}/pulls/${obsolete[0].number}`);
          if (!readback || readback.state !== "closed" || readback.merged_at) this.auth.fail(409, "Obsolete PR closure was not confirmed");
        }
      }
      if (action === "fail") {
        // An implementation lease proves this HOW was already approved. If it
        // stopped before publication, restore that approval instead of revoking
        // it by moving the HOW to Triage.
        if (grant.kind === "implement" && current.row.phase === "running" && state.name === "In Progress" && state.type === "started") {
          const linear = await this.workflowUpdateHow(context, grant, { stateId: this.workflowState(current.facts.states, "Todo", "unstarted").id }, ["running"]);
          return { linear };
        }
        return { linear: current.row.linear };
      }
      const linear = await this.workflowUpdateHow(context, grant, { stateId: this.workflowState(current.facts.states, "Triage", "triage").id }, ["approved", "running", "review", "blocked"], true);
      return { linear };
    }
    this.auth.fail(400, "Unsupported workflow action");
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
    const repositoryRoute = /^\/api\/integrations\/([a-f0-9]{32})\/(repository|linear\/issues)$/.exec(url.pathname);
    if (repositoryRoute && request.method === (repositoryRoute[2] === "repository" ? "POST" : "GET")) {
      let session: Session | undefined;
      let device: Device;
      if (repositoryRoute[2] === "repository" || request.headers.has("Authorization")) {
        device = await this.auth.host(request, repositoryRoute[1]);
      } else {
        session = await this.auth.session(request);
        const owned = this.sql.exec<Device>("SELECT * FROM devices WHERE device_id = ?", repositoryRoute[1]).toArray()[0];
        if (!owned || owned.user_id !== session.user.id) this.auth.fail(403, "Device belongs to another account");
        device = owned;
      }
      const check = () => {
        if (session) this.auth.liveSession(session);
        this.liveDevice(device);
        const current = this.sql.exec<Device>("SELECT * FROM devices WHERE device_id = ?", device.device_id).toArray()[0];
        if (current.repository !== device.repository || current.repository_generation !== device.repository_generation) this.auth.fail(409, "Device repository changed");
      };
      check();
      if (repositoryRoute[2] === "linear/issues") return this.auth.json(await this.repositoryIssues(device, check));
      const body = await this.auth.body(request);
      check();
      let repository: WorkingRepository | null = null;
      if (body.repository !== null) {
        const value = body.repository as Record<string, unknown> | undefined;
        if (!value || typeof value.owner !== "string" || typeof value.name !== "string") this.auth.fail(400, "Invalid GitHub repository");
        repository = { owner: value.owner.trim().toLowerCase(), name: value.name.trim().toLowerCase() };
        if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(repository.owner) ||
            !/^[a-z0-9._-]{1,100}$/.test(repository.name) || repository.name === "." || repository.name === "..") this.auth.fail(400, "Invalid GitHub repository");
      }
      const normalized = repository ? JSON.stringify(repository) : null;
      if (normalized !== device.repository) {
        this.sql.exec("UPDATE devices SET repository = ?, repository_generation = ? WHERE device_id = ?", normalized, random(), device.device_id);
        this.auth.changed();
      }
      return this.auth.json({ ok: true });
    }
    const callback = /^\/api\/integrations\/callback\/(github|linear)$/.exec(url.pathname);
    if (callback && request.method === "GET") return this.callback(request, callback[1] as Provider, url);
    if (Integrations.daemonRoute(request)) {
      const [, id, action] = /^\/api\/integrations\/([a-f0-9]{32})(?:\/(issues))?$/.exec(url.pathname)!;
      const device = await this.auth.host(request, id);
      const check = () => this.liveDevice(device);
      check();
      if (!action) return this.auth.json(this.connections(device.user_id));
      if (action === "issues") return this.auth.json(await this.issues(device.user_id, check));
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
      authorization.searchParams.set("scope", "read,write,app:mentionable");
      authorization.searchParams.set("actor", "app");
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
      this.auth.changed();
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
    if (!result.data || result.errors?.length) {
      const data = result.data;
      const errors = result.errors;
      const missingIssue = (data == null || typeof data === "object" && "issue" in data && data.issue === null) &&
        Array.isArray(errors) && errors.length > 0 && errors.every(error =>
          error !== null && typeof error === "object" && "message" in error && typeof error.message === "string" &&
          /^Entity not found:\s*Issue\b/i.test(error.message) && "extensions" in error &&
          error.extensions !== null && typeof error.extensions === "object" && "code" in error.extensions && error.extensions.code === "INPUT_ERROR");
      throw Object.assign(new Error("Linear request failed"), { providerCode: "graphql_error", missingIssue });
    }
    return result.data;
  }

  private async teams(token: string, check: () => void): Promise<Team[]> {
    const teams: Team[] = [];
    let after: string | null = null;
    do {
      const result: { organization: { id: string }; viewer: LinearAgent & { app: boolean }; teams: { nodes: { id: string; name: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await this.linear(token, "query($after:String){organization{id} viewer{id name url app} teams(first:100,after:$after){nodes{id name} pageInfo{hasNextPage endCursor}}}", { after });
      check();
      if (result.viewer?.app !== true) throw Object.assign(new Error("Linear app authorization is required"), { providerCode: "app_actor_required" });
      const { id, name, url } = result.viewer;
      if (!id || !name || !/^https:\/\/linear\.app\/[^/]+\/profiles\/[^/?#]+$/.test(url)) throw new Error("Linear app profile is unavailable");
      teams.push(...result.teams.nodes.map(team => ({ team_id: team.id, team_name: team.name, workspace_id: result.organization.id, agent: { id, name, url } })));
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
      this.auth.changed();
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
    this.auth.changed();
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

  private async installationToken(user: string, check: () => void, permissions: Record<string, string> = PERMISSIONS): Promise<{ token: string; expires_at: string; repository: Repository }> {
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
        body: JSON.stringify({ repository_ids: [repository.repository_id], permissions }), redirect: "manual",
      });
      if (!response.ok) {
        const hint = response.status === 401
          ? "Check GITHUB_APP_ID and the matching GitHub App private key."
          : response.status === 422
            ? `Check the GitHub App permissions requested (${Object.entries(permissions).map(([permission, access]) => `${permission}=${access}`).join(", ")}), then approve updated permissions on this installation.`
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

  private async repositoryIssues(device: Device, check: () => void): Promise<unknown> {
    const repository = JSON.parse(device.repository ?? "null") as WorkingRepository | null;
    const connection = this.row(device.user_id, "linear");
    if (!connection?.active || !connection.target) return { repository, linear: null };
    const team = JSON.parse(connection.target) as Team;
    if (!repository) return { repository, linear: { team, issues: [] } };
    const guard = () => { this.current(connection, "active", check); };
    const prefix = `https://github.com/${repository.owner}/${repository.name}/issues/`;
    const issues = new Map<string, Omit<LinkedIssue, "team" | "attachments"> & { github_issues: { number: number; url: string }[] }>();
    const next = (page: Page<unknown>, seen: Set<string>): string | null => {
      if (!page.pageInfo.hasNextPage) return null;
      const cursor = page.pageInfo.endCursor;
      if (!cursor || seen.has(cursor)) throw new Error("Linear pagination failed");
      seen.add(cursor);
      return cursor;
    };
    const link = (value: string): { number: number; url: string } | null => {
      // Inspect the actual attachment path, not URL's dot-segment-normalized path.
      const match = /^https:\/\/([^/]+)\/([^/?#]+)\/([^/?#]+)\/(issues)\/(\d+)\/?(?:[?#].*)?$/i.exec(value);
      if (!match || match[1].toLowerCase() !== "github.com" || match[2].toLowerCase() !== repository.owner ||
          match[3].toLowerCase() !== repository.name || match[4] !== "issues") return null;
      const number = Number(match[5]);
      if (!Number.isSafeInteger(number) || number <= 0) return null;
      return { number, url: `${prefix}${number}` };
    };
    try {
      const credential = await this.credential(connection, "active", check);
      let after: string | null = null;
      const issueCursors = new Set<string>();
      do {
        const data: { issues: Page<LinkedIssue> } = await this.linear(credential.access_token,
          "query($team:ID!,$prefix:String!,$after:String){issues(first:100,after:$after,includeArchived:true,filter:{team:{id:{eq:$team}},attachments:{some:{url:{startsWithIgnoreCase:$prefix}}}}){nodes{id identifier title url description state{name type} team{id} attachments(first:100,includeArchived:true,filter:{url:{startsWithIgnoreCase:$prefix}}){nodes{url} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}",
          { team: team.team_id, prefix, after });
        guard();
        for (const issue of data.issues.nodes) {
          if (issue.team.id !== team.team_id) continue;
          const { attachments, team: _team, ...metadata } = issue;
          const existing = issues.get(issue.id) ?? { ...metadata, github_issues: [] };
          const numbers = new Set(existing.github_issues.map(link => link.number));
          let page = attachments;
          const attachmentCursors = new Set<string>();
          for (;;) {
            for (const attachment of page.nodes) {
              const github = link(attachment.url);
              if (github && !numbers.has(github.number)) {
                numbers.add(github.number);
                existing.github_issues.push(github);
              }
            }
            const cursor = next(page, attachmentCursors);
            if (!cursor) break;
            const more: { issue: { team: { id: string }; attachments: Page<{ url: string }> } | null } = await this.linear(credential.access_token,
              "query($id:String!,$prefix:String!,$after:String!){issue(id:$id){team{id} attachments(first:100,after:$after,includeArchived:true,filter:{url:{startsWithIgnoreCase:$prefix}}){nodes{url} pageInfo{hasNextPage endCursor}}}}",
              { id: issue.id, prefix, after: cursor });
            guard();
            if (!more.issue || more.issue.team.id !== team.team_id) throw new Error("Linear issue unavailable");
            page = more.issue.attachments;
          }
          if (existing.github_issues.length) issues.set(issue.id, existing);
        }
        after = next(data.issues, issueCursors);
      } while (after);
      guard();
      return { repository, linear: { team, issues: [...issues.values()] } };
    } catch (error) {
      if (error instanceof Error && "status" in error) throw error;
      this.auth.fail(502, "Linked Linear issues could not be retrieved");
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
