import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { githubFixture } from "./helpers.mjs";

export function workflowFixture() {
  const fixture = githubFixture();
  const original = fixture.fetch.bind(fixture);
  Object.assign(fixture, {
    issues: [{ number: 42, node_id: "I_42", title: "Implement the request", body: "WHAT: implement the requested change.", html_url: "https://github.com/octocat/connected/issues/42", state: "open" }],
    linears: [], pulls: [], refs: new Map([["main", "1".repeat(40)]]), states: [
      { id: "triage", name: "Triage", type: "triage" }, { id: "todo", name: "Todo", type: "unstarted" },
      { id: "progress", name: "In Progress", type: "started" }, { id: "review", name: "In Review", type: "started" },
      { id: "done", name: "Done", type: "completed" }, { id: "canceled", name: "Canceled", type: "canceled" },
    ], base_branch: "main", target_oid: "1".repeat(40), repository_node_id: "R_501", autonomous: true, verification: [["true"]],
    config_source: undefined, configurations: new Map(), calls: [], grants: [], uncertainty: new Map(), failures: new Map(), allowFailureApprovalRestore: false, allowAutomaticTodo: true, holdReads: undefined,
    issuePageSize: 100, attachmentPageSize: 100, comments: new Map(), reviews: new Map(), reviewComments: new Map(), checks: [], statuses: [],
    compare: undefined, sealSupported: true, trees: new Map(),
  });
  fixture.addHow = (state = "Todo", number = 42) => {
    const how = {
      id: "11111111-1111-5111-a111-111111111111", identifier: "ENG-42", title: "Implement the HOW", description: "Change source and verify the requested behavior.",
      url: "https://linear.app/example/issue/ENG-42", state: { ...fixture.states.find(candidate => candidate.name === state) }, team: { id: "team" },
      attachments: [{ url: `https://github.com/octocat/connected/issues/${number}` }], comments: [],
    };
    fixture.linears.push(how);
    return how;
  };
  fixture.feedback = (number, body = "@oriel Please fix this behavior") => {
    const comments = fixture.comments.get(number) ?? [];
    const comment = { id: comments.length + 1, body, user: { login: "human", type: "User" }, created_at: new Date().toISOString() };
    comments.push(comment); fixture.comments.set(number, comments); return comment;
  };
  fixture.merge = number => {
    const pr = fixture.pulls.find(pr => pr.number === number);
    assert.ok(pr); pr.state = "closed"; pr.merged_at = new Date().toISOString();
    const issue = fixture.issues.find(issue => pr.body?.trim() === `Closes #${issue.number}`);
    if (issue) issue.state = "closed";
    return pr;
  };
  const page = (nodes, after, size = 100) => {
    const start = after ? Number(after) : 0;
    const end = Math.min(nodes.length, start + size);
    return { nodes: structuredClone(nodes.slice(start, end)), pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? String(end) : null } };
  };
  const restPage = (nodes, url) => {
    const start = (Number(url.searchParams.get("page") ?? 1) - 1) * Number(url.searchParams.get("per_page") ?? 100);
    return structuredClone(nodes.slice(start, start + Number(url.searchParams.get("per_page") ?? 100)));
  };
  const uncertain = (operation, response) => {
    if (fixture.uncertainty.has(operation)) {
      const remaining = fixture.uncertainty.get(operation);
      if (typeof remaining === "number" && remaining > 1) fixture.uncertainty.set(operation, remaining - 1);
      else fixture.uncertainty.delete(operation);
      return new Response("private-provider-diagnostic", { status: 503 });
    }
    return response;
  };
  const record = async (provider, operation, request, body) => {
    fixture.calls.push({ provider, operation, method: request.method, ...(body === undefined ? {} : { body: structuredClone(body) }) });
    if (request.method === "GET" || body?.query?.startsWith("query")) await fixture.holdReads?.({ provider, operation });
    const failure = fixture.failures.get(operation);
    return failure ? new Response("private-provider-diagnostic", { status: typeof failure === "number" ? failure : 503 }) : null;
  };
  const howNode = how => ({ ...structuredClone(how), attachments: page(how.attachments, null, fixture.attachmentPageSize), comments: page(how.comments ?? [], null, fixture.issuePageSize) });
  const pullNode = pr => ({ ...structuredClone(pr), head: { ...structuredClone(pr.head), sha: fixture.refs.get(pr.head.ref) ?? pr.head.sha } });
  fixture.fetch = async request => {
    const url = new URL(request.url);
    if (url.origin === "https://api.github.com" && url.pathname === "/app/installations/101/access_tokens") {
      const body = await request.clone().json();
      assert.deepEqual(body.repository_ids, [501]);
      assert.equal(body.permissions.metadata, "read");
      for (const [permission, value] of Object.entries(body.permissions)) {
        assert.ok(["contents", "issues", "pull_requests", "metadata", "checks", "statuses"].includes(permission));
        assert.ok(["read", "write"].includes(value));
        if (["metadata", "checks", "statuses"].includes(permission)) assert.equal(value, "read");
      }
      fixture.grants.push(structuredClone(body.permissions));
      const normalized = new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify({ repository_ids: [501], permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" } }) });
      return original(normalized);
    }
    if (url.origin === "https://api.linear.app" && url.pathname === "/graphql") {
      const payload = await request.clone().json();
      const { query, variables = {} } = payload;
      if (query.includes("teams(")) return original(request);
      assert.equal(request.headers.get("Authorization"), `Bearer ${fixture.linearToken}`);
      if (fixture.apiFailed) return Response.json({ errors: [{ message: "private-provider-diagnostic" }] });
      const operation = query.includes("issueCreate(") ? "how-create" : query.includes("issueUpdate(") ? "how-update" : query.includes("attachmentCreate(") ? "how-link" : query.includes("commentCreate(") ? "how-comment" : query.includes("states(") ? "states" : query.includes("issue(id:") ? "how" : "hows";
      const failure = await record("linear", operation, request, payload); if (failure) return failure;
      const input = variables.input;
      if (["how-create", "how-link", "how-comment"].includes(operation) && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.id)) {
        return Response.json({ errors: [{ message: "id must be a UUID v4", extensions: { code: "INPUT_ERROR" } }] });
      }
      if (operation === "how-create") {
        assert.equal(fixture.states.find(state => state.id === input.stateId)?.name, "Triage");
        let how = fixture.linears.find(how => how.id === input.id);
        if (!how) {
          how = { id: input.id, identifier: `ENG-${fixture.linears.length + 43}`, title: input.title, description: input.description, url: `https://linear.app/example/issue/ENG-${fixture.linears.length + 43}`,
            state: structuredClone(fixture.states.find(state => state.id === input.stateId)), team: { id: input.teamId }, attachments: [], comments: [] };
          fixture.linears.push(how);
        }
        return uncertain(operation, Response.json({ data: { issueCreate: { success: true, issue: { id: how.id } } } }));
      }
      if (operation === "how-update") {
        const how = fixture.linears.find(how => how.id === variables.id);
        if (!how) return Response.json({ errors: [{ message: "not found" }] });
        if (input.stateId) {
          const state = fixture.states.find(state => state.id === input.stateId);
          if (state?.name === "Todo") assert.equal(fixture.allowFailureApprovalRestore || fixture.allowAutomaticTodo, true, "Todo may only be restored after an admitted failure or automatic repository execution");
          how.state = structuredClone(state);
        }
        if (input.title !== undefined) how.title = input.title;
        if (input.description !== undefined) how.description = fixture.normalizeDescription?.(input.description) ?? input.description;
        return uncertain(operation, Response.json({ data: { issueUpdate: { success: true, issue: { id: how.id, title: how.title, description: how.description } } } }));
      }
      if (operation === "how-link") {
        const how = fixture.linears.find(how => how.id === input.issueId); assert.ok(how);
        if (!how.attachments.some(attachment => attachment.url === input.url)) how.attachments.push({ id: input.id, url: input.url });
        return uncertain(operation, Response.json({ data: { attachmentCreate: { success: true } } }));
      }
      if (operation === "how-comment") {
        const how = fixture.linears.find(how => how.id === input.issueId); assert.ok(how);
        how.comments ??= [];
        if (!how.comments.some(comment => comment.id === input.id)) how.comments.push({ id: input.id, body: input.body, createdAt: new Date().toISOString() });
        return uncertain(operation, Response.json({ data: { commentCreate: { success: true } } }));
      }
      if (operation === "states") return Response.json({ data: { team: { states: page(fixture.states, variables.after, fixture.issuePageSize) } } });
      if (operation === "how") {
        const how = fixture.linears.find(how => how.id === variables.id);
        if (!how) return Response.json(fixture.missingHowErrors ? { data: { issue: null }, errors: fixture.missingHowErrors } : { data: { issue: null } });
        const node = howNode(how);
        if (query.includes("comments(")) node.comments = page(how.comments ?? [], variables.after, fixture.issuePageSize);
        if (query.includes("attachments(")) node.attachments = page(how.attachments, variables.after, fixture.attachmentPageSize);
        return Response.json({ data: { issue: node } });
      }
      if (query.includes("team(id:")) return Response.json({ data: { team: { issues: page(fixture.linears, variables.after, fixture.issuePageSize) } } });
      const candidates = fixture.linears.filter(how => !variables.prefix || how.attachments.some(attachment => attachment.url.toLowerCase().startsWith(variables.prefix.toLowerCase())));
      return Response.json({ data: { issues: page(candidates, variables.after, fixture.issuePageSize) } });
    }
    if (url.origin === "https://api.github.com" && url.pathname === "/graphql") {
      assert.equal(request.headers.get("Authorization"), "Bearer limited-installation-token");
      const body = await request.json();
      const failure = await record("github", "seal", request, body); if (failure) return failure;
      if (!fixture.sealSupported) return Response.json({ errors: [{ message: "unsupported" }] });
      assert.equal(body.variables.input.repositoryId, fixture.repository_node_id);
      const updates = body.variables.input.refUpdates;
      assert.equal(updates.length, 2);
      assert.deepEqual(updates[0], { name: `refs/heads/${fixture.base_branch}`, beforeOid: fixture.target_oid, afterOid: fixture.target_oid, force: false });
      const current = ref => ref === `refs/heads/${fixture.base_branch}` ? fixture.target_oid : fixture.refs.get(ref.replace("refs/heads/", "")) ?? "0".repeat(40);
      if (updates.some(update => update.force !== false || current(update.name) !== update.beforeOid)) return Response.json({ errors: [{ message: "compare failed" }] });
      for (const update of updates) fixture.refs.set(update.name.replace("refs/heads/", ""), update.afterOid);
      return uncertain("seal", Response.json({ data: { updateRefs: { clientMutationId: null } } }));
    }
    const prefix = "/repos/octocat/connected";
    if (url.origin !== "https://api.github.com" || !url.pathname.startsWith(prefix)) return original(request);
    assert.equal(request.headers.get("Authorization"), "Bearer limited-installation-token");
    const path = url.pathname.slice(prefix.length);
    const body = request.method === "GET" ? undefined : await request.json();
    const operation = path === "" ? "repository" : path.startsWith("/contents/") ? "configuration" : path.startsWith("/git/ref/") ? "ref" : path.startsWith("/git/matching-refs/") ? "refs" : path.startsWith("/git/commits/") ? "git-commit" : path.startsWith("/git/trees/") ? "tree" :
      path === "/issues" ? request.method === "POST" ? "what-create" : "whats" : path === "/pulls" ? request.method === "POST" ? "pr-create" : "prs" : path.startsWith("/compare/") ? "compare" :
      /\/issues\/\d+\/comments$/.test(path) ? request.method === "POST" ? "pr-comment" : "pr-comments" : /\/pulls\/\d+\/reviews$/.test(path) ? "reviews" : /\/pulls\/\d+\/comments$/.test(path) ? "review-comments" : path.includes("/check-runs") ? "checks" : path.endsWith("/statuses") ? "statuses" : "pr";
    const failure = await record("github", operation, request, body); if (failure) return failure;
    if (fixture.apiFailed) return new Response("private-provider-diagnostic", { status: 503 });
    if (operation === "repository") return Response.json({ id: 501, node_id: fixture.repository_node_id, default_branch: fixture.base_branch });
    if (operation === "configuration") {
      assert.equal(url.searchParams.get("ref"), fixture.target_oid, "Configuration is immutable target-commit pinned");
      const source = fixture.configurations.has(fixture.target_oid) ? fixture.configurations.get(fixture.target_oid) : fixture.config_source === undefined ? JSON.stringify({ schemaVersion: 1, execution: { backend: "worktree", autonomous: fixture.autonomous, verification: fixture.verification } }) : fixture.config_source;
      if (source === null) return new Response(null, { status: 404 });
      return Response.json({ type: "file", encoding: "base64", sha: createHash("sha1").update(source).digest("hex"), content: Buffer.from(source).toString("base64") });
    }
    if (operation === "ref") {
      const branch = decodeURIComponent(path.slice("/git/ref/heads/".length));
      const sha = branch === fixture.base_branch ? fixture.target_oid : fixture.refs.get(branch);
      return sha ? Response.json({ object: { sha } }) : new Response(null, { status: 404 });
    }
    if (operation === "refs") return Response.json([...fixture.refs].filter(([branch]) => branch.startsWith("oriel/")).map(([branch, sha]) => ({ ref: `refs/heads/${branch}`, object: { sha } })));
    if (operation === "whats") return Response.json(restPage(fixture.issues, url));
    if (operation === "what-create") {
      const number = Math.max(42, ...fixture.issues.map(issue => issue.number)) + 1;
      const issue = { number, node_id: `I_${number}`, title: body.title, body: body.body, state: "open", html_url: `https://github.com/octocat/connected/issues/${number}` };
      fixture.issues.push(issue); return uncertain(operation, Response.json(issue, { status: 201 }));
    }
    if (operation === "prs") return Response.json(restPage(fixture.pulls.map(pullNode), url));
    if (operation === "pr-create") {
      assert.equal(body.draft, false); assert.equal(body.base, fixture.base_branch);
      const pr = { number: 100 + fixture.pulls.length, html_url: `https://github.com/octocat/connected/pull/${100 + fixture.pulls.length}`, title: body.title, body: body.body, draft: false, state: "open", merged_at: null,
        head: { ref: body.head, sha: fixture.refs.get(body.head), repo: { id: 501 } }, base: { ref: body.base, repo: { id: 501 } } };
      fixture.pulls.push(pr); return uncertain(operation, Response.json(pullNode(pr), { status: 201 }));
    }
    if (operation === "compare") return Response.json(fixture.compare ?? { status: path.endsWith(fixture.target_oid) ? "identical" : "ahead", total_commits: path.endsWith(fixture.target_oid) ? 0 : 1, files: [{ filename: "src/change.rs", status: "modified" }] });
    if (operation === "git-commit") return Response.json({ tree: { sha: path.slice("/git/commits/".length) } });
    if (operation === "tree") return Response.json(fixture.trees.get(path.slice("/git/trees/".length)) ?? { tree: [], truncated: false });
    const number = Number(path.split("/")[2]);
    if (operation === "pr-comments") return Response.json(restPage(fixture.comments.get(number) ?? [], url));
    if (operation === "pr-comment") {
      const comments = fixture.comments.get(number) ?? [];
      const comment = { id: comments.length + 1, body: body.body, user: { type: "Bot", login: "oriel[bot]" }, created_at: new Date().toISOString() };
      comments.push(comment); fixture.comments.set(number, comments); return uncertain(operation, Response.json(comment, { status: 201 }));
    }
    if (operation === "reviews") return Response.json(restPage(fixture.reviews.get(number) ?? [], url));
    if (operation === "review-comments") return Response.json(restPage(fixture.reviewComments.get(number) ?? [], url));
    if (operation === "checks") {
      if (path.startsWith("/check-runs/")) return Response.json(fixture.checks.find(check => check.id === Number(path.split("/")[2])) ?? null);
      return Response.json({ check_runs: restPage(fixture.checks.filter(check => check.head_sha === path.split("/")[2]), url) });
    }
    if (operation === "statuses") return Response.json(restPage(fixture.statuses.filter(status => !status.sha || status.sha === path.split("/")[2]), url));
    if (operation === "pr") {
      const pr = fixture.pulls.find(pr => pr.number === number);
      if (!pr) return new Response(null, { status: 404 });
      if (request.method === "PATCH") {
        assert.deepEqual(body, { state: "closed" }); assert.equal(pr.merged_at, null);
        pr.state = "closed";
      }
      return uncertain(operation, Response.json(pullNode(pr)));
    }
    assert.fail(`Unexpected workflow provider request: ${request.method} ${path}`);
  };
  return fixture;
}
