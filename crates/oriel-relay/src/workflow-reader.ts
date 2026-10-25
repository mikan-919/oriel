import { capacityError, executionAdmission } from "./workflow-capacity";
import { digest, githubIssueLink, OID, parseConfiguration, validBranch, type Feedback, type GithubWhat, type LinearHow, type LinearState, type PullRequest, type WorkflowRow, type WorkflowSnapshot } from "./workflow";
import type { Auth, IntegrationEnv, WorkflowContext, WorkflowFacts, WorkflowHow, Page, LinkedIssue, GithubPull, GithubComment, LinearComment, SnapshotPreparation } from "./integrations";
import type { WorkflowCI } from "./workflow";
type Check = { app?: { id: number } | null; id: number; name: string; head_sha: string; status: string; conclusion: string | null; completed_at: string | null; details_url?: string | null; output: { title: string | null; summary: string | null; text: string | null } };
// A run ID identifies an attempt; App ID and name identify its stable series.
const checkSeries = (check: Check): string | null => Number.isSafeInteger(check.app?.id) && check.app!.id > 0
  ? JSON.stringify(["check-run", check.app!.id, check.name]) : null;
const latestChecks = (checks: Check[], head: string): Map<string, Check> => {
  const latest = new Map<string, Check>();
  for (const check of [...checks].filter(check => check.head_sha === head).sort((a, b) => a.id - b.id)) {
    latest.set(checkSeries(check) ?? `unknown-app:${check.id}`, check);
  }
  return latest;
};
const SECRET = /^[a-f0-9]{64}$/;
const GITHUB_COMMAND = "/oriel";
// Never forward provider messages or arbitrary extension values to the daemon.
const LINEAR_ERROR_CODES = new Set(["RATELIMITED", "INPUT_ERROR", "FORBIDDEN", "UNAUTHENTICATED", "AUTHENTICATION_ERROR", "GRAPHQL_PARSE_FAILED", "GRAPHQL_VALIDATION_FAILED", "INTERNAL_SERVER_ERROR"]);
const githubCommand = (body: string) => /^[\/／]oriel(?:\s|$)/i.test(body.trimStart()) ? { planning: /^[\/／]oriel\s+how(?:\s|$)/i.test(body.trimStart()) } : null;
const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** Provider reads can execute in a Worker without retaining a Durable Object. */
export class WorkflowReader {
  constructor(protected readonly env: IntegrationEnv, protected readonly auth: Pick<Auth, "fail">) {}
  async read(preparation: SnapshotPreparation): Promise<WorkflowSnapshot> {
    const context = { ...preparation.context, check: () => {} };
    let accessible = false;
    for (let page = 1; ; page++) {
      const response = await fetch(`https://api.github.com/user/installations/${context.repository.installation_id}/repositories?per_page=100&page=${page}`, {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${preparation.github_user}`, "User-Agent": "Oriel", "X-GitHub-Api-Version": "2022-11-28" }, redirect: "manual",
      });
      if (!response.ok) this.auth.fail(502, "GitHub repository access could not be confirmed");
      const result = await response.json() as { repositories: { id: number }[] };
      if (!Array.isArray(result.repositories)) this.auth.fail(502, "GitHub repository access could not be confirmed");
      if (result.repositories.some(repository => repository.id === context.repository.repository_id)) { accessible = true; break; }
      if (result.repositories.length < 100) break;
    }
    if (!accessible) this.auth.fail(403, "GitHub repository is no longer accessible");
    return this.snapshot(context, preparation.issue_number);
  }
  async snapshot(context: WorkflowContext, issueNumber?: number): Promise<WorkflowSnapshot> {
    return (await this.workflowFacts(context, issueNumber)).snapshot;
  }
  protected async workflowGithub<T>(context: WorkflowContext, path: string, method = "GET", body?: unknown, missing = false): Promise<T | null> {
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

  protected async workflowList<T>(context: WorkflowContext, path: string): Promise<T[]> {
    const nodes: T[] = [];
    for (let page = 1; ; page++) {
      const rows = await this.workflowGithub<T[]>(context, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(rows)) this.auth.fail(502, "GitHub workflow collection is unavailable");
      nodes.push(...rows);
      if (rows.length < 100) return nodes;
    }
  }

  // One request reads up to twenty issue comment pages. Pagination still reads
  // every comment; partial GraphQL data can never imply approval or no feedback.
  protected async workflowComments(context: WorkflowContext, issues: GithubWhat[]): Promise<Map<number, GithubComment[]>> {
    type Issue = { id: string; number: number; comments: Page<{ fullDatabaseId: string | number; body: string; createdAt: string; author: { __typename: string; login: string } | null }> };
    const comments = new Map<number, GithubComment[]>();
    for (let offset = 0; offset < issues.length; offset += 20) {
      let pending = issues.slice(offset, offset + 20).map(issue => ({ issue, after: null as string | null, seen: new Set<string>() }));
      while (pending.length) {
        const variables: Record<string, unknown> = { owner: context.repository.owner, name: context.repository.name };
        const fields = pending.map(({ issue, after }, index) => {
          variables[`number${index}`] = issue.number; variables[`after${index}`] = after;
          return `i${index}:issue(number:$number${index}){id number comments(first:100,after:$after${index}){nodes{fullDatabaseId body createdAt author{__typename login}} pageInfo{hasNextPage endCursor}}}`;
        });
        const parameters = pending.map((_, index) => `$number${index}:Int!,$after${index}:String`).join(",");
        const result = await this.workflowGithub<{ data?: { repository: Record<string, Issue> | null }; errors?: unknown[] }>(context, "/graphql", "POST", {
          query: `query OrielIssueComments($owner:String!,$name:String!,${parameters}){repository(owner:$owner,name:$name){${fields.join(" ")}}}`, variables,
        });
        if (!result?.data?.repository || result.errors?.length) this.auth.fail(502, "GitHub issue comments are unavailable");
        const next: typeof pending = [];
        for (const [index, state] of pending.entries()) {
          const row = result.data.repository[`i${index}`];
          if (!row || row.id !== state.issue.node_id || row.number !== state.issue.number || !Array.isArray(row.comments?.nodes) ||
              typeof row.comments.pageInfo?.hasNextPage !== "boolean") this.auth.fail(502, "GitHub issue comment identity is unavailable");
          const collected = comments.get(row.number) ?? [];
          for (const node of row.comments.nodes) {
            const id = Number(node.fullDatabaseId);
            if (!Number.isSafeInteger(id) || id <= 0 || typeof node.body !== "string" || typeof node.createdAt !== "string" ||
                node.author && (typeof node.author.login !== "string" || typeof node.author.__typename !== "string")) this.auth.fail(502, "GitHub comment identity is unavailable");
            collected.push({ id, body: node.body, created_at: node.createdAt, user: { login: node.author?.login ?? "", type: node.author?.__typename ?? "Unknown" } });
          }
          comments.set(row.number, collected);
          if (row.comments.pageInfo.hasNextPage) {
            const after = row.comments.pageInfo.endCursor;
            if (!after || state.seen.has(after)) this.auth.fail(502, "GitHub comment pagination is unavailable");
            state.seen.add(after); next.push({ ...state, after });
          }
        }
        pending = next;
      }
    }
    return comments;
  }

  protected async workflowLinear<T>(context: WorkflowContext, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    context.check();
    try {
      const result = await this.linear<T>(context.linear, query, variables);
      context.check();
      return result;
    } catch (error) {
      context.check();
      if (error instanceof Error && ("status" in error || ("missingIssue" in error && error.missingIssue === true))) throw error;
      const code = error instanceof Error && "providerCode" in error && typeof error.providerCode === "string" &&
        /^(?:http_[0-9]{3}|graphql_error)(?:\/[A-Z_]{1,40})?$/.test(error.providerCode) ? error.providerCode : "transport_or_response_error";
      const operation = query.match(/\{\s*([A-Za-z][_0-9A-Za-z]*)/)?.[1] ?? "unknown";
      const retryAfterSeconds = error instanceof Error && "retryAfterSeconds" in error &&
        typeof error.retryAfterSeconds === "number" ? error.retryAfterSeconds : undefined;
      this.auth.fail(retryAfterSeconds === undefined ? 502 : 429,
        `Linear workflow request failed (${code}; ${operation}); provider state could not be confirmed`, retryAfterSeconds);
    }
  }

  protected async workflowHow(context: WorkflowContext, id: string): Promise<WorkflowHow | null> {
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

  protected async workflowStates(context: WorkflowContext): Promise<LinearState[]> {
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

  protected async workflowHows(context: WorkflowContext): Promise<WorkflowHow[]> {
    const hows: WorkflowHow[] = [];
    let after: string | null = null;
    const cursors = new Set<string>();
    do {
      // Do not filter the team: a foreign-team formal link must block, not look unlinked.
      // Read HOW metadata in the collection instead of issuing one extra query
      // per HOW on every live guard. Bound both connections to keep complexity
      // below Linear's per-query limit, and retain full attachment pagination.
      const data: { issues: Page<LinearHow & { team: { id: string }; attachments: Page<{ url: string }> }> } = await this.workflowLinear(context,
        "query($prefix:String!,$after:String){issues(first:20,after:$after,includeArchived:true,orderBy:createdAt,filter:{attachments:{some:{url:{startsWithIgnoreCase:$prefix}}}}){nodes{id identifier title description url state{id name type} team{id} attachments(first:20,includeArchived:true){nodes{url} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}",
        { prefix: `https://github.com/${context.repository.owner}/${context.repository.name}/issues/`, after });
      const candidates = [...new Map(data.issues.nodes.map(candidate => [candidate.id, candidate])).values()]
        .filter(candidate => !hows.some(how => how.id === candidate.id));
      for (let offset = 0; offset < candidates.length; offset += 4) {
        const batch = await Promise.all(candidates.slice(offset, offset + 4).map(candidate =>
          candidate.attachments.pageInfo.hasNextPage ? this.workflowHow(context, candidate.id) :
            { ...candidate, attachments: candidate.attachments.nodes }));
        context.check();
        for (const how of batch) {
          if (!how) this.auth.fail(502, "Linked HOW is unavailable");
          hows.push(how);
        }
      }
      after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
      if (data.issues.pageInfo.hasNextPage && (!after || cursors.has(after))) this.auth.fail(502, "Linear issue pagination is unavailable");
      if (after) cursors.add(after);
    } while (after);
    return hows;
  }

  protected async workflowFacts(context: WorkflowContext, issueNumber?: number): Promise<WorkflowFacts> {
    const repository = await this.workflowGithub<{ id: number; node_id: string; default_branch: string }>(context, context.path);
    if (!repository || repository.id !== context.repository.repository_id || !validBranch(repository.default_branch)) this.auth.fail(409, "Selected repository identity is unavailable");
    // Read independent provider collections together; every await still checks
    // the live binding, and a failed read prevents any snapshot or approval.
    const [{ base, configuration }, issues, pulls, references, hows, states] = await Promise.all([
      (async () => {
        const base = await this.workflowGithub<{ object: { sha: string } }>(context, `${context.path}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
        if (!base || !OID.test(base.object.sha)) this.auth.fail(502, "Target commit is unavailable");
        const configuration = await this.workflowGithub<{ type: string; encoding: string; content: string; sha: string }>(context,
          `${context.path}/contents/.oriel.yaml?ref=${base.object.sha}`, "GET", undefined, true);
        return { base, configuration };
      })(),
      issueNumber === undefined
        ? this.workflowList<GithubWhat & { html_url: string; pull_request?: unknown }>(context, `${context.path}/issues?state=all&sort=created&direction=asc`)
        : this.workflowGithub<GithubWhat & { html_url: string; pull_request?: unknown }>(context, `${context.path}/issues/${issueNumber}`, "GET", undefined, true)
          .then(issue => issue ? [issue] : []),
      this.workflowList<GithubPull>(context, `${context.path}/pulls?state=all`),
      this.workflowGithub<{ ref: string; object: { sha: string } }[]>(context, `${context.path}/git/matching-refs/heads/oriel/`),
      this.workflowHows(context),
      this.workflowStates(context),
    ]);
    context.check();
    let source: string | null = null;
    if (configuration) {
      if (configuration.type !== "file" || configuration.encoding !== "base64" || configuration.content.length > 131072) this.auth.fail(409, "Target .oriel.yaml must be a bounded regular file");
      try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(configuration.content.replace(/\s/g, "")), char => char.charCodeAt(0))); }
      catch { this.auth.fail(409, "Target .oriel.yaml is not UTF-8"); }
    }
    if (!Array.isArray(references) || references.some(ref => !ref.ref.startsWith("refs/heads/oriel/") || !validBranch(ref.ref.slice("refs/heads/".length)) || !OID.test(ref.object.sha))) this.auth.fail(502, "Canonical reference facts are unavailable");
    const refs = new Map(references.map(ref => [ref.ref.replace(/^refs\/heads\//, ""), ref.object.sha]));
    const snapshot: WorkflowSnapshot = { repository: context.binding.repository, repository_id: repository.id, repository_node_id: repository.node_id,
      base_branch: repository.default_branch, target_oid: base.object.sha, team: context.team, configuration: parseConfiguration(source), workflows: [] };
    const recoveries = new Map<number, string>();
    const commentPages = issueNumber === undefined ? await this.workflowComments(context,
      issues.filter(issue => !issue.pull_request && issue.state === "open")) : null;
    for (let offset = 0; offset < issues.length; offset += 4) {
      const rows = await Promise.all(issues.slice(offset, offset + 4).map(async raw => {
        if (raw.pull_request) return null;
        const issue: GithubWhat = { number: raw.number, node_id: raw.node_id, title: raw.title, body: raw.body ?? null, url: raw.html_url, state: raw.state };
        if (!Number.isSafeInteger(issue.number) || !issue.node_id || !["open", "closed"].includes(issue.state)) this.auth.fail(502, "GitHub WHAT identity is unavailable");
        const linked = hows.filter(how => how.attachments.some(attachment => {
          const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/0*([0-9]+)(?:[/?#].*)?$/i.exec(attachment.url);
          return !!match && match[1].toLowerCase() === context.repository.owner.toLowerCase() && match[2].toLowerCase() === context.repository.name.toLowerCase() && Number(match[3]) === issue.number;
        }));
        // Any human GitHub user may request planning, including before deployment.
        // Commands must start the comment; quotes, code and prose do not opt in.
        const initialComments = linked.length === 0 && issue.state === "open"
          ? commentPages?.get(issue.number) ?? await this.workflowList<GithubComment>(context, `${context.path}/issues/${issue.number}/comments`) : [];
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
                else if (exact("Triage", "triage")) { row.phase = "triage"; if (pr?.state === "open") row.blocked_reason = "HOW is in Triage; human Todo reapproval is required before continuing the existing PR"; }
                else if (exact("Todo", "unstarted") && (!pr || pr.state === "open" && row.canonical_oid)) row.phase = pr ? "review" : "approved";
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
                  const ci: { value?: WorkflowCI } = {};
                  row.feedback = await this.workflowFeedback(context, row.pull_request!, snapshot.target_oid, undefined, exhausted, ci);
                  row.ci = ci.value;
                  if (exhausted.length && !row.feedback) row.blocked_reason = exhausted.join(", ");
                }
              }
            }
          }
        }
        if (issue.state === "open") {
          const comments = linked.length === 0 ? initialComments : commentPages?.get(issue.number) ?? await this.workflowList<GithubComment>(context, `${context.path}/issues/${issue.number}/comments`);
          row.what_comments = comments.map(comment => ({ id: String(comment.id), body: comment.body, author: comment.user?.login ?? null, created_at: comment.created_at }))
            .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
          row.issue_feedback = await this.workflowIssueFeedback(context, comments);
          if (row.linear && !(issueNumber !== undefined && row.phase === "running")) {
            const comments = await this.workflowLinearComments(context, row.linear.id);
            row.how_comments = comments.map(comment => ({ id: comment.id, body: comment.body, author: comment.user?.name ?? null, created_at: comment.createdAt }))
              .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
            if (row.phase === "triage") row.how_feedback = await this.workflowHowFeedback(context, row.linear.id, comments);
          }
        }
        return row;
      }));
      context.check();
      snapshot.workflows.push(...rows.filter((row): row is WorkflowRow => row !== null));
    }
    context.check();
    for (const row of snapshot.workflows) {
      if (!["approved", "running", "review"].includes(row.phase) || !snapshot.configuration.autonomous) continue;
      const kind = row.phase === "review" ? "respond" : "implement";
      const error = capacityError(context.binding, executionAdmission(snapshot, row, {
        kind, issue_number: row.issue.number, version: row.version, branch: row.branch,
      }));
      if (error) { row.phase = "blocked"; row.blocked_reason = error; }
    }
    return { snapshot, states, hows, pulls, refs, recoveries };
  }

  protected workflowPull(pr: GithubPull): PullRequest {
    return { number: pr.number, url: pr.html_url, branch: pr.head.ref, head_oid: pr.head.sha, base_branch: pr.base.ref, state: pr.state, merged: !!pr.merged_at, draft: pr.draft };
  }

  protected async workflowMarker(context: WorkflowContext, kind: string, key: string): Promise<string> {
    const secret = Uint8Array.from(this.env.INTEGRATION_ENCRYPTION_KEY!.match(/../g)!, byte => parseInt(byte, 16));
    const hmac = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", hmac, encoder.encode(JSON.stringify(["oriel/workflow-cursor/v1", context.repository.repository_id, kind === "what" ? null : context.team.team_id, kind, key])));
    return `<!-- oriel:${kind}:${base64url(encoder.encode(key))}:${base64url(new Uint8Array(signature))} -->`;
  }

  protected async workflowIssueFeedback(context: WorkflowContext, comments: GithubComment[], planningOnly = false): Promise<WorkflowRow["issue_feedback"]> {
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

  protected async workflowLinearComments(context: WorkflowContext, id: string): Promise<LinearComment[]> {
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

  protected async workflowHowFeedback(context: WorkflowContext, id: string, comments: LinearComment[]): Promise<{ key: string; body: string } | null> {
    const agent = context.team.agent;
    if (!agent) return null; // Existing user OAuth connections need app authorization before native mentions.
    for (const comment of [...comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      if (!comment.user || comment.user.app || comment.user.id === agent.id || /<!-- oriel:/.test(comment.body)) continue;
      // Profile links identify native mentions. Also accept the explicit
      // @oriel command in comment text while this app connection is available.
      const urls = comment.body.match(/https:\/\/linear\.app\/[^\s<>()[\]]+/g) ?? [];
      const command = /^@oriel(?:\s|[、。，,.!?！？:：]|$)/i.test(comment.body.trimStart());
      if (!command && !urls.some(url => url.replace(/[.,!?;:]+$/, "") === agent.url)) continue;
      const key = `how:${await digest([id, comment.id, comment.body])}`;
      const marker = await this.workflowMarker(context, "how-response", key);
      if (!comments.some(response => response.body.includes(marker))) return { key, body: comment.body };
    }
    return null;
  }

  protected async workflowCursors(context: WorkflowContext, comments: GithubComment[], kind: "response" | "response-head"): Promise<Map<string, string>> {
    const cursors = new Map<string, string>();
    const pattern = new RegExp(`<!-- oriel:${kind}:([A-Za-z0-9_-]+):[A-Za-z0-9_-]+ -->`, "g");
    for (const comment of comments) for (const marker of comment.body.matchAll(pattern)) {
      try {
        const key = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(marker[1].replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0)));
        if (marker[0] === await this.workflowMarker(context, kind, key) && (!cursors.has(key) || comment.created_at < cursors.get(key)!)) cursors.set(key, comment.created_at);
      } catch { /* Unsigned public comments are never Oriel response cursors. */ }
    }
    return cursors;
  }

  protected async workflowFeedback(context: WorkflowContext, pr: PullRequest, targetOid: string, requestedKey?: string, exhausted?: string[], ci?: { value?: WorkflowCI }): Promise<Feedback | null> {
    if (ci) ci.value = {head_oid:pr.head_oid, acquisition:"unavailable", fetched_at:new Date().toISOString(), status:"unknown", checks:[]};
    const currentChecks: Check[] = [];
    for (let page = 1; ; page++) {
      const result = await this.workflowGithub<{ check_runs: Check[] }>(context, `${context.path}/commits/${pr.head_oid}/check-runs?filter=all&per_page=100&page=${page}`);
      if (!result || !Array.isArray(result.check_runs)) this.auth.fail(502, "PR checks are unavailable");
      currentChecks.push(...result.check_runs);
      if (result.check_runs.length < 100) break;
    }
    const currentStatuses = await this.workflowList<{ id: number; context: string; state: string; description: string | null; created_at: string; target_url?: string | null }>(context, `${context.path}/commits/${pr.head_oid}/statuses`);
    if (ci) {
      const newest = latestChecks(currentChecks, pr.head_oid);
      const statuses = new Map<string, typeof currentStatuses[number]>();
      for (const status of [...currentStatuses].sort((a,b) => a.id-b.id)) statuses.set(status.context, status);
      const result = (value: string | null): WorkflowCI["checks"][number]["status"] => value === "success" ? "success" :
        ["neutral","skipped"].includes(value ?? "") ? "skipped" :
        ["failure","error","timed_out","action_required","cancelled","startup_failure","stale"].includes(value ?? "") ? "failure" : "unknown";
      const checks: WorkflowCI["checks"] = [
        ...[...newest.values()].map(check => ({name:check.name,status:check.status === "completed" ? result(check.conclusion) : "pending" as const,url:check.details_url ?? null})),
        ...[...statuses.values()].map(status => ({name:status.context,status:status.state === "pending" ? "pending" as const : result(status.state),url:status.target_url ?? null})),
      ];
      ci.value = { acquisition: "received", fetched_at: new Date().toISOString(), head_oid: pr.head_oid, checks, status:checks.some(check=>check.status === "failure") ? "failure" :
        checks.some(check=>check.status === "pending") ? "pending" :
        checks.length && checks.some(check=>check.status === "success") && checks.every(check=>["success","skipped"].includes(check.status)) ? "success" : "unknown" };
    }
    const [comments, reviews, inline] = await Promise.all([
      this.workflowList<GithubComment>(context, `${context.path}/issues/${pr.number}/comments`),
      this.workflowList<{ id: number; state: string; body: string | null; submitted_at: string | null; user: { login: string } }>(context, `${context.path}/pulls/${pr.number}/reviews`),
      this.workflowList<{ id: number; pull_request_review_id: number; path: string; line: number | null; original_line?: number | null; body: string; commit_id: string }>(context, `${context.path}/pulls/${pr.number}/comments`),
    ]);
    context.check();
    const cursors = await this.workflowCursors(context, comments, "response");
    if (requestedKey === undefined || requestedKey.startsWith("conflict:")) {
      // List-pulls does not compute mergeability. null means GitHub is still
      // calculating; a later scan will read it again without starting a repair.
      const native = await this.workflowGithub<GithubPull>(context, `${context.path}/pulls/${pr.number}`);
      if (!native) this.auth.fail(502, "PR mergeability is unavailable");
      if (native.number !== pr.number || native.state !== "open" || native.merged_at || native.draft ||
          native.head.ref !== pr.branch || native.head.repo?.id !== context.repository.repository_id ||
          native.base.ref !== pr.base_branch || native.base.repo.id !== context.repository.repository_id ||
          native.base.sha !== targetOid || !OID.test(native.head.sha)) this.auth.fail(409, "PR mergeability identity or target changed; retry discovery");
      const key = `conflict:${pr.number}:${pr.head_oid}:${targetOid}`;
      const admitted = requestedKey === key;
      if (native.head.sha !== pr.head_oid && !admitted) this.auth.fail(409, "PR head changed during mergeability discovery");
      // Reconstruct only the admitted cursor after our verified push changes the
      // head and resolves the conflict. The lease still pins approval and target.
      if (!cursors.has(key) && (requestedKey === undefined || admitted) &&
          (native.mergeable === false || admitted && native.head.sha !== pr.head_oid)) {
        return { key, kind: "merge_conflict", body: `PR #${pr.number} conflicts with ${pr.base_branch} at ${targetOid}. Integrate that exact target commit into the existing PR branch, resolve conflicts within the approved HOW, and rerun configured verification.`, comments: [] };
      }
    }
    const submitted = reviews.filter(review => review.state !== "PENDING" && review.submitted_at)
      .sort((a, b) => a.submitted_at!.localeCompare(b.submitted_at!) || a.id - b.id);
    const latest = new Map<string, typeof reviews[number]>();
    for (const review of submitted) latest.set(review.user.login, review);
    for (const review of [...submitted].reverse()) {
      if (!["CHANGES_REQUESTED", "COMMENTED", "APPROVED"].includes(review.state)) continue;
      if (review.state === "CHANGES_REQUESTED" && latest.get(review.user.login)?.id !== review.id) continue;
      const notes = inline.filter(comment => comment.pull_request_review_id === review.id && comment.body.trim()).sort((a, b) => a.id - b.id);
      if (review.state !== "CHANGES_REQUESTED" && !review.body?.trim() && !notes.length) continue;
      const key = `review:${await digest([pr.number, review.id, review.body, notes.map(note => [note.id, note.path, note.body])])}`;
      if ((requestedKey === undefined || requestedKey === key) && !cursors.has(key)) return { key, kind: "review", body: review.body ?? "", comments: notes.map(note => ({ path: note.path, line: note.line ?? note.original_line ?? null, body: note.body })) };
    }
    for (const comment of [...comments].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)) {
      if (!comment.body.trim() || (await this.workflowCursors(context, [comment], "response")).size) continue;
      const key = `comment:${await digest([pr.number, comment.id, comment.body])}`;
      if ((requestedKey === undefined || requestedKey === key) && !cursors.has(key)) return { key, kind: "comment", body: comment.body, comments: [] };
    }
    const checks = currentChecks;
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
      const statuses = head === pr.head_oid ? currentStatuses : await this.workflowList<{ id: number; context: string; state: string; description: string | null; created_at: string }>(context, `${context.path}/commits/${head}/statuses`);
      statusHistory.push(...statuses.map(status => ({ ...status, head })));
    }
    // Resolve even legacy name-only cursors through their signed run ID. Never
    // silently discard an attempt whose origin can no longer be established.
    const checkCursors = new Map<string, string>();
    let unresolved = false;
    for (const [key, time] of cursors) {
      const match = /^check:([^:]+):(\d+):([a-f0-9]{40})$/.exec(key);
      if (!match) continue;
      const id = Number(match[2]);
      const run = history.find(run => run.id === id) ?? await this.workflowGithub<Check>(context, `${context.path}/check-runs/${id}`, "GET", undefined, true);
      const series = run && checkSeries(run);
      if (!run || run.id !== id || run.head_sha !== match[3] || !series ||
          ![await digest(series), await digest(run.name)].includes(match[1])) { unresolved = true; continue; }
      const normalized = `check:${await digest(series)}:${id}:${match[3]}`;
      if (!checkCursors.has(normalized) || time < checkCursors.get(normalized)!) checkCursors.set(normalized, time);
    }
    if (unresolved) exhausted?.push("Check history origin unavailable; manual confirmation required");
    for (const check of latestChecks(checks, pr.head_oid).values()) {
      if (check.head_sha !== pr.head_oid || check.status !== "completed" || !["failure", "timed_out", "action_required", "cancelled", "startup_failure", "stale"].includes(check.conclusion ?? "")) continue;
      const series = checkSeries(check);
      if (!series) { exhausted?.push(`${check.name}: App ID unavailable; manual confirmation required`); continue; }
      if (unresolved) continue;
      const name = await digest(series);
      const key = `check:${name}:${check.id}:${pr.head_oid}`;
      if (checkCursors.has(key)) continue;
      // Count unique signed response attempts since the latest actual successful run,
      // including prior response heads. No local history or repeated-comment echoes.
      const successful = history.filter(run => checkSeries(run) === series && run.status === "completed" && ["success", "neutral", "skipped"].includes(run.conclusion ?? "") && run.completed_at)
        .map(run => run.completed_at!).sort().at(-1) ?? "";
      const attempts = [...checkCursors].filter(([key, time]) => key.startsWith(`check:${name}:`) && time > successful).length;
      if (attempts >= 3) { exhausted?.push(`Check retry limit reached (3 verified attempts): ${check.name}`); continue; }
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
      const attempts = [...cursors].filter(([key, time]) => key.startsWith(prefix) && /^status-\d+$/.test(key.split(":")[2]) && time > successful).length;
      if (attempts >= 3) exhausted?.push(`Check retry limit reached (3 verified attempts): ${status.context}`);
      if (attempts < 3 && (requestedKey === undefined || requestedKey === key)) return { key, kind: "check_failure", body: `${status.context}: ${status.state}\n${status.description ?? ""}`, comments: [] };
    }
    return null;
  }

  protected async linear<T>(token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch("https://api.linear.app/graphql", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }), redirect: "manual" });
    // Linear also returns GraphQL error bodies for HTTP 400 (including rate
    // limits) and 404. Classify those bodies before handling the HTTP status.
    const result = await response.json().catch(() => null) as { data?: T; errors?: { message?: unknown; extensions?: { code?: unknown } | null }[] } | null;
    const errors = Array.isArray(result?.errors) ? result.errors : [];
    if (!response.ok || !result?.data || result.errors && (!Array.isArray(result.errors) || errors.length)) {
      const data = result?.data;
      const missingIssue = (response.ok || response.status === 400 || response.status === 404) &&
        (data == null || typeof data === "object" && "issue" in data && data.issue === null) &&
        errors.length > 0 && errors.every(error =>
          error !== null && typeof error === "object" && "message" in error && typeof error.message === "string" &&
          /^Entity not found:\s*Issue\b/i.test(error.message) && "extensions" in error &&
          error.extensions !== null && typeof error.extensions === "object" && "code" in error.extensions && error.extensions.code === "INPUT_ERROR");
      const codes = errors.map(error => error?.extensions?.code);
      const limited = response.status === 429 || codes.includes("RATELIMITED");
      const code = limited ? "RATELIMITED" : codes.find(code => typeof code === "string" && LINEAR_ERROR_CODES.has(code));
      const providerCode = `${response.ok ? "graphql_error" : `http_${response.status}`}${code ? `/${code}` : ""}`;
      // Linear's reset headers are UTC epoch milliseconds. Only an exhausted
      // bucket may delay retries; other buckets can have unrelated reset times.
      let retryAfterSeconds: number | undefined;
      if (limited) {
        retryAfterSeconds = 60;
        const retry = response.headers.get("Retry-After");
        if (retry && /^\d+$/.test(retry)) retryAfterSeconds = Math.max(retryAfterSeconds, Number(retry));
        for (const bucket of ["Requests", "Complexity", "Endpoint-Requests"]) {
          const remaining = response.headers.get(`X-RateLimit-${bucket}-Remaining`);
          const reset = response.headers.get(`X-RateLimit-${bucket}-Reset`);
          if (remaining !== null && /^0+$/.test(remaining) && reset && /^\d+$/.test(reset)) {
            retryAfterSeconds = Math.max(retryAfterSeconds, Math.ceil((Number(reset) - Date.now()) / 1000));
          }
        }
        retryAfterSeconds = Math.min(86400, retryAfterSeconds);
      }
      throw Object.assign(new Error("Linear request failed"), { providerCode, missingIssue, retryAfterSeconds });
    }
    return result.data;
  }

}
