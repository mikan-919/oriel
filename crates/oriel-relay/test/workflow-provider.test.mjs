import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { client, connect, device, hostHeaders, origin, pair, runtime } from "./helpers.mjs";
import { workflowFixture } from "./workflow-fixture.mjs";

async function setup() {
  const fixture = workflowFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request));
  const { owner, daemon } = await pair(worker);
  await connect(owner, fixture, "github"); await connect(owner, fixture, "linear");
  assert.equal((await daemon.api(`/api/integrations/${device}/repository`, { repository: fixture.repository }, hostHeaders)).status, 200);
  const upgraded = await worker.dispatchFetch(`${origin}/api/workflows/${device}/connect`, { headers: { ...hostHeaders, Upgrade: "websocket" } });
  assert.equal(upgraded.status, 101);
  const socket = upgraded.webSocket; socket.accept();
  let sequence = 0;
  const message = payload => new Promise((resolve, reject) => {
    const request_id = `provider-${++sequence}`;
    const timer = setTimeout(() => reject(new Error("workflow lease response timeout")), 10000);
    const listener = event => {
      const value = JSON.parse(event.data);
      if (value.request_id !== request_id) return;
      clearTimeout(timer); socket.removeEventListener("message", listener); resolve(value);
    };
    socket.addEventListener("message", listener); socket.send(JSON.stringify({ ...payload, request_id }));
  });
  const snapshot = async () => {
    const response = await daemon.api(`/api/workflows/${device}`, undefined, hostHeaders);
    assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data;
  };
  const claim = async kind => {
    const row = (await snapshot()).workflows.find(row => row.issue.number === 42);
    const response = await message({ type: "claim", kind, issue_number: 42, version: row.version, branch: row.branch });
    assert.equal(response.type, "granted", JSON.stringify(response)); return response.lease_id;
  };
  const action = (lease_id, action, body = {}) => daemon.api(`/api/workflows/${device}/actions`, { lease_id, action, ...body }, hostHeaders);
  const close = async () => { socket.close(); await worker.dispose(); };
  return { fixture, worker, owner, daemon, socket, message, snapshot, claim, action, close };
}

test("discovery failures identify the provider without exposing upstream bodies or granting work", async () => {
  const s = await setup();
  try {
    s.fixture.addHow("Todo");
    for (const [operation, provider] of [["pr-comments", "GitHub"], ["states", "Linear"]]) {
      s.fixture.failures.set(operation, 503);
      const failed = await s.daemon.api(`/api/workflows/${device}`, undefined, hostHeaders);
      assert.equal(failed.status, 502);
      assert.ok(failed.data.error.includes(provider), JSON.stringify(failed.data));
      assert.ok(failed.data.error.includes("503"), JSON.stringify(failed.data));
      assert.ok(!JSON.stringify(failed.data).includes("private-provider-diagnostic"));
      const rejected = await s.message({ type: "claim", kind: "implement", issue_number: 42, version: "unconfirmed", branch: "oriel/unconfirmed" });
      assert.equal(rejected.type, "rejected");
      s.fixture.failures.delete(operation);
    }
    assert.equal((await s.snapshot()).workflows.find(row => row.issue.number === 42).phase, "approved");
  } finally { await s.close(); }
});

test("HOW planning waits for native Triage and resumes when the team enables it", async () => {
  const s = await setup();
  try {
    const triage = s.fixture.states.shift();
    const unavailable = (await s.snapshot()).workflows.find(row => row.issue.number === 42);
    assert.equal(unavailable.phase, "blocked");
    assert.equal((await s.message({ type: "claim", kind: "plan", issue_number: 42, version: unavailable.version, branch: unavailable.branch })).type, "rejected");
    assert.deepEqual(s.fixture.linears, []);
    s.fixture.states.unshift(triage);
    assert.equal((await s.snapshot()).workflows.find(row => row.issue.number === 42).phase, "needs-how");
    const proposal = await s.action(await s.claim("plan"), "proposal", { title: "HOW", description: "Scope for human review." });
    assert.equal(proposal.status, 200);
    assert.equal(proposal.data.linear.state.id, triage.id);
    assert.equal((await s.snapshot()).workflows.find(row => row.issue.number === 42).phase, "triage");
  } finally { await s.close(); }
});

test("Todo implementation context includes complete chronological WHAT and HOW discussions", async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow("Todo");
    const github = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1, body: `WHAT decision ${index}: preserve existing sessions`,
      user: { login: index === 100 ? "oriel[bot]" : "requester", type: index === 100 ? "Bot" : "User" },
      created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }));
    const linear = Array.from({ length: 101 }, (_, index) => ({
      id: `discussion-${index}`, body: `HOW decision ${index}: do not delete pairing credentials`,
      user: index === 100 ? null : { name: "Reviewer" },
      createdAt: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(),
    }));
    s.fixture.comments.set(42, github);
    how.comments = [...linear].reverse();
    const row = (await s.snapshot()).workflows.find(row => row.issue.number === 42);
    assert.equal(row.phase, "approved");
    assert.deepEqual(row.what_comments, github.map(comment => ({
      id: String(comment.id), body: comment.body, author: comment.user.login, created_at: comment.created_at,
    })));
    assert.deepEqual(row.how_comments, linear.map(comment => ({
      id: comment.id, body: comment.body, author: comment.user?.name ?? null, created_at: comment.createdAt,
    })));
    s.fixture.failures.set("pr-comments", 503);
    const unavailable = await s.daemon.api(`/api/workflows/${device}`, undefined, hostHeaders);
    assert.equal(unavailable.status, 502, "Unreadable history must not become an empty discussion");
  } finally { await s.close(); }
});

test("native missing-HOW errors permit creation but authorization and mixed failures do not", async () => {
  const s = await setup();
  try {
    const lease = await s.claim("plan");
    const missing = { message: "Entity not found: Issue", path: ["issue"], extensions: { code: "INPUT_ERROR" } };
    const forbidden = { message: "Entity not found: Issue", path: ["issue"], extensions: { code: "FORBIDDEN" } };
    for (const errors of [[forbidden], [missing, forbidden]]) {
      s.fixture.missingHowErrors = errors;
      assert.equal((await s.action(lease, "proposal", { title: "HOW", description: "Review before approving implementation." })).status, 502);
      assert.deepEqual(s.fixture.linears, []);
    }
    s.fixture.missingHowErrors = [missing];
    const proposal = await s.action(lease, "proposal", { title: "HOW", description: "Review before approving implementation." });
    assert.equal(proposal.status, 200, JSON.stringify(proposal.data));
    assert.equal(proposal.data.linear.state.type, "triage");
    assert.equal((await s.snapshot()).workflows.find(row => row.issue.number === 42).linear.id, proposal.data.linear.id);
  } finally { await s.close(); }
});

test("WHAT browser creation and deterministic HOW recover unknown sends without granting Todo", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    const request = { title: "Browser WHAT", body: "Describe the actual need", request_id: randomUUID() };
    s.fixture.uncertainty.set("what-create", true);
    const [created, concurrent] = await Promise.all([s.owner.api(`/api/workflows/${device}/issues`, request), s.owner.api(`/api/workflows/${device}/issues`, request)]);
    assert.equal(created.status, 200, JSON.stringify(created.data)); assert.equal(concurrent.status, 200, JSON.stringify(concurrent.data));
    assert.equal(concurrent.data.issue.number, created.data.issue.number);
    const repeated = await s.owner.api(`/api/workflows/${device}/issues`, request);
    assert.equal(repeated.data.issue.number, created.data.issue.number);
    assert.equal(s.fixture.issues.filter(issue => issue.title === request.title).length, 1);
    assert.equal((await s.daemon.api(`/api/workflows/${device}/issues`, request, hostHeaders)).status, 403);
    const foreign = client(s.worker); await foreign.enroll((await import("./helpers.mjs")).authenticator());
    assert.equal((await foreign.api(`/api/workflows/${device}/issues`, { ...request, request_id: randomUUID() })).status, 403);
    const lease = await s.claim("plan");
    s.fixture.uncertainty.set("how-create", true); s.fixture.uncertainty.set("how-link", true);
    const proposal = await s.action(lease, "proposal", { title: "HOW plan", description: "Implement source and run verification." });
    assert.equal(proposal.status, 200, JSON.stringify(proposal.data));
    assert.equal(proposal.data.linear.state.name, "Triage");
    assert.equal(s.fixture.linears.length, 1);
    s.fixture.linears[0].description = "Human refinement remains authoritative";
    const retry = await s.action(lease, "proposal", { title: "HOW plan", description: "Implement source and run verification." });
    assert.equal(retry.status, 200, JSON.stringify(retry.data));
    assert.equal(retry.data.linear.description, "Human refinement remains authoritative");
    assert.equal(s.fixture.linears[0].attachments.length, 1);
    assert.equal((await s.action(lease, "begin")).status, 403);
    assert.equal((await s.snapshot()).workflows.find(row => row.issue.number === 42).phase, "triage");
  } finally { await s.close(); }
});

test("native Markdown formatting is acknowledged once without granting Todo", async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow("Triage");
    how.comments.push({ id: "request", body: "https://linear.app/example/profiles/oriel-agent revise the HOW", createdAt: "2026-01-01T00:00:00Z", user: { name: "Human" } });
    s.fixture.normalizeDescription = body => body.replace("Questions:\n1.", "Questions:\n\n1.");
    const description = "Questions:\n1. Keep disconnected devices visible?";
    const lease = await s.claim("plan");
    const proposal = await s.action(lease, "proposal", { title: "Revised HOW", description, summary: "Offline devices remain visible; please confirm their status labels." });
    assert.equal(proposal.status, 200, JSON.stringify(proposal.data));
    assert.equal(proposal.data.linear.description, "Questions:\n\n1. Keep disconnected devices visible?");
    const row = (await s.snapshot()).workflows.find(row => row.issue.number === 42);
    assert.equal(row.how_feedback, null, "The processed request must not retrigger another model run");
    assert.equal(row.phase, "triage");
  } finally { await s.close(); }
});

test("canonical update receipts do not hide intervening human edits", async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow("Triage");
    how.comments.push({ id: "request", body: "https://linear.app/example/profiles/oriel-agent revise", createdAt: "2026-01-01T00:00:00Z", user: { id: "human", name: "Human", app: false } });
    const lease = await s.claim("plan");
    s.fixture.holdReads = ({ provider, operation }) => {
      if (provider === "linear" && operation === "how" && s.fixture.calls.some(call => call.operation === "how-update")) how.description = "Human revision after the mutation";
    };
    const proposal = await s.action(lease, "proposal", { title: "Revised HOW", description: "Agent proposal", summary: "Updated the proposed scope." });
    assert.equal(proposal.status, 409);
    assert.equal(how.description, "Human revision after the mutation");
    assert.deepEqual(how.comments.map(comment => comment.id), ["request"]);
    assert.equal(how.state.name, "Triage");
  } finally { await s.close(); }
});

test("HOW update receipts do not consume unanswered questions and reply retries do not duplicate answers", async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow("Triage");
    const request = { id: "question", body: "https://linear.app/example/profiles/oriel-agent 見えてる？", createdAt: "2026-01-01T00:00:00Z", user: { id: "human", name: "Human", app: false } };
    const key = `how:${createHash("sha256").update(JSON.stringify([how.id, request.id, request.body])).digest("hex")}`;
    const signature = createHmac("sha256", Buffer.from(s.fixture.env.INTEGRATION_ENCRYPTION_KEY, "hex"))
      .update(JSON.stringify(["oriel/workflow-cursor/v1", 501, "team", "how", key])).digest("base64url");
    const receipt = { id: "old-receipt", body: `HOW update recorded.\n\n<!-- oriel:how:${Buffer.from(key).toString("base64url")}:${signature} -->`, createdAt: "2026-01-01T00:01:00Z" };
    how.comments.push(request, receipt);
    assert.equal((await s.snapshot()).workflows.find(row => row.issue.number === 42).how_feedback.key, key);
    const lease = await s.claim("plan");
    const draft = { title: how.title, description: how.description };
    for (const summary of [undefined, "", " ", "x".repeat(12001)]) {
      const rejected = await s.action(lease, "proposal", { ...draft, ...(summary === undefined ? {} : { summary }) });
      assert.equal(rejected.status, 400);
      assert.equal(how.title, draft.title);
      assert.equal(how.description, draft.description);
      assert.deepEqual(how.comments.map(comment => comment.id), [request.id, receipt.id]);
    }
    s.fixture.uncertainty.set("how-comment", true);
    const answered = await s.action(lease, "proposal", { ...draft, summary: "はい、コメントは見えています。実装はまだ承認していません。" });
    assert.equal(answered.status, 200, JSON.stringify(answered.data));
    const response = structuredClone(how.comments[2]);
    assert.equal((await s.snapshot()).workflows.find(row => row.issue.number === 42).how_feedback, null);
    const retried = await s.action(lease, "proposal", { ...draft, summary: "A late retry must not replace the original answer." });
    assert.equal(retried.status, 200);
    assert.deepEqual(how.comments, [request, receipt, response]);
    assert.equal(how.state.name, "Triage");
    assert.equal((await s.action(lease, "begin")).status, 403);
  } finally { await s.close(); }
});

test("exact human approval seals atomically, publishes only verified source, resumes review and reconciles actual merge", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow();
    const approved = (await s.snapshot()).workflows[0];
    const expected = createHash("sha256").update(JSON.stringify(["oriel/approval-fingerprint/v1", "R_501", "I_42", s.fixture.issues[0].title, s.fixture.issues[0].body, how.id, how.title, how.description])).digest("hex");
    assert.equal(approved.fingerprint, expected);
    assert.equal(approved.branch, `oriel/ENG-42-gh-42-${expected}`);
    const lease = await s.claim("implement");
    s.fixture.uncertainty.set("seal", true); s.fixture.uncertainty.set("how-update", true);
    const begin = await s.action(lease, "begin");
    assert.equal(begin.status, 200, JSON.stringify(begin.data));
    assert.equal(begin.data.canonical_oid, s.fixture.target_oid); assert.equal(how.state.name, "In Progress");
    const resumed = await s.action(lease, "begin"); assert.equal(resumed.status, 200);
    assert.equal(s.fixture.calls.filter(call => call.operation === "seal").length, 1);
    const noSource = await s.action(lease, "publish", { head_oid: s.fixture.target_oid, verified: true, summary: "No code" });
    assert.equal(noSource.status, 409); assert.equal(s.fixture.pulls.length, 0);
    const head = "2".repeat(40); s.fixture.refs.set(approved.branch, head);
    assert.equal((await s.action(lease, "publish", { head_oid: head, verified: false, summary: "Unverified" })).status, 400);
    s.fixture.uncertainty.set("pr-create", true); s.fixture.uncertainty.set("how-update", true);
    const published = await s.action(lease, "publish", { head_oid: head, verified: true, summary: "Implemented source" });
    assert.equal(published.status, 200, JSON.stringify(published.data));
    const pr = published.data.pull_request;
    assert.equal(pr.draft, false); assert.equal(pr.head_oid, head); assert.equal(how.state.name, "In Review");
    assert.equal(s.fixture.pulls[0].body, "Closes #42");
    assert.equal((await s.action(lease, "publish", { head_oid: head, verified: true, summary: "Retry" })).status, 200);
    assert.equal(s.fixture.pulls.length, 1);
    await s.message({ type: "release", lease_id: lease });
    s.fixture.feedback(pr.number);
    const reviewing = (await s.snapshot()).workflows[0]; assert.equal(reviewing.feedback.kind, "comment");
    const responding = await s.claim("respond");
    const nextHead = "3".repeat(40); s.fixture.refs.set(approved.branch, nextHead);
    s.fixture.uncertainty.set("pr-comment", true);
    const responded = await s.action(responding, "responded", { head_oid: nextHead, verified: true, feedback_key: reviewing.feedback.key, summary: "Fixed and verified review request" });
    assert.equal(responded.status, 200, JSON.stringify(responded.data));
    assert.equal((await s.snapshot()).workflows[0].feedback, null);
    await s.message({ type: "release", lease_id: responding });
    s.fixture.pulls[0].state = "closed";
    assert.equal((await s.snapshot()).workflows[0].phase, "blocked");
    s.fixture.merge(pr.number);
    const merged = (await s.snapshot()).workflows[0]; assert.equal(merged.issue.state, "closed"); assert.equal(merged.phase, "merged");
    const reconcile = await s.claim("reconcile"); s.fixture.uncertainty.set("how-update", true);
    const done = await s.action(reconcile, "done"); assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.linear.state.name, "Done"); assert.equal((await s.snapshot()).workflows[0].phase, "done");
  } finally { await s.close(); }
});

test("aliases, ambiguous links, unknown states and strict target configuration cannot confer code approval", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow();
    how.attachments[0].url += "?alias=1";
    assert.equal((await s.snapshot()).workflows[0].phase, "blocked");
    how.attachments[0].url = s.fixture.issues[0].html_url;
    how.attachments.push({ url: "https://github.com/foreign/repository/issues/7" });
    assert.equal((await s.snapshot()).workflows[0].phase, "blocked"); how.attachments.pop();
    const foreign = structuredClone(how); foreign.id = "22222222-2222-5222-a222-222222222222"; foreign.team.id = "foreign";
    s.fixture.linears.push(foreign);
    assert.equal((await s.snapshot()).workflows[0].phase, "blocked"); s.fixture.linears.pop();
    how.state = { id: "custom", name: "Todo", type: "unstarted" };
    assert.equal((await s.snapshot()).workflows[0].phase, "blocked"); how.state = { ...s.fixture.states.find(state => state.id === "todo") };
    for (const config of [null, 'schemaVersion: 1\nexecution: {backend: worktree, autonomous: "true", verification: [[true]]}', 'schemaVersion: 1\nexecution: {backend: worktree, autonomous: true, verification: [["true"]], surprise: true}', 'schemaVersion: 1\nmodelCapabilities: {reasoning: true}\nexecution: {backend: worktree, autonomous: true, verification: [["true"]]}', 'schemaVersion: 1\nexecution: !custom {backend: worktree, autonomous: true, verification: [["true"]]}']) {
      s.fixture.config_source = config;
      const snapshot = await s.snapshot(); assert.equal(snapshot.configuration.autonomous, false); assert.equal(snapshot.workflows[0].phase, "blocked");
      const claim = await s.message({ type: "claim", kind: "implement", issue_number: 42, version: snapshot.workflows[0].version, branch: snapshot.workflows[0].branch });
      assert.equal(claim.type, "rejected");
    }
    s.fixture.config_source = undefined; s.fixture.sealSupported = false;
    const lease = await s.claim("implement"); assert.equal((await s.action(lease, "begin")).status, 409);
    assert.equal(how.state.name, "Todo"); assert.equal([...s.fixture.refs.keys()].some(ref => ref.startsWith("oriel/")), false);
  } finally { await s.close(); }
});

test("changed approval is returned to Triage, failures are bounded, and Git grants are narrowed and revoked", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow(); const initial = (await s.snapshot()).workflows[0];
    const lease = await s.claim("implement"); assert.equal((await s.action(lease, "begin")).status, 200);
    const token = await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: lease }, hostHeaders);
    assert.equal(token.status, 200, JSON.stringify(token.data)); assert.deepEqual(s.fixture.grants.at(-1), { contents: "write", metadata: "read" });
    how.description += " Human changed the HOW.";
    assert.equal((await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: lease }, hostHeaders)).status, 409);
    assert.equal((await s.action(lease, "publish", { head_oid: initial.canonical_oid, verified: true, summary: "Stale" })).status >= 400, true);
    const invalidated = await s.action(lease, "invalidate"); assert.equal(invalidated.status, 200, JSON.stringify(invalidated.data)); assert.equal(how.state.name, "Triage");
    await s.message({ type: "release", lease_id: lease });
    const plan = await s.claim("plan");
    const readonly = await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: plan }, hostHeaders);
    assert.equal(readonly.status, 200); assert.deepEqual(s.fixture.grants.at(-1), { contents: "read", metadata: "read" });
    await s.message({ type: "release", lease_id: plan }); how.state = { ...s.fixture.states.find(state => state.id === "todo") };
    const broken = await s.claim("implement"); assert.equal((await s.action(broken, "begin")).status, 200);
    s.fixture.uncertainty.set("how-comment", true); s.fixture.uncertainty.set("how-update", true);
    s.fixture.allowFailureApprovalRestore = true;
    const failure = await s.action(broken, "fail", { reason: "Configured verification failed: private-linear-access" });
    assert.equal(failure.status, 200, JSON.stringify(failure.data)); assert.equal(how.state.name, "Todo");
    assert.equal((await s.snapshot()).workflows[0].phase, "approved", "runtime failures restore, but do not revoke, human approval");
    assert.equal(how.comments[0].body.includes("private-linear-access"), false);
    await s.owner.api("/api/integrations/github/disconnect", {});
    const revoked = await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: broken }, hostHeaders); assert.equal(revoked.status, 409);
  } finally { await s.close(); }
});

test("restart derives invalidate-only recovery from unique prior native Git identity", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow();
    const original = (await s.snapshot()).workflows[0];
    const implementation = await s.claim("implement"); assert.equal((await s.action(implementation, "begin")).status, 200);
    const head = "2".repeat(40); s.fixture.refs.set(original.branch, head);
    assert.equal((await s.action(implementation, "publish", { head_oid: head, verified: true, summary: "Verified source" })).status, 200);
    await s.message({ type: "release", lease_id: implementation });
    how.description += " Human changed the approved design.";
    const edited = (await s.snapshot()).workflows[0];
    assert.equal(edited.phase, "blocked"); assert.equal(edited.recovery, "invalidate"); assert.notEqual(edited.branch, original.branch);
    const reconcile = await s.claim("reconcile");
    assert.equal((await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: reconcile }, hostHeaders)).status, 409);
    assert.equal((await s.action(reconcile, "done")).status, 409);
    const invalidated = await s.action(reconcile, "invalidate"); assert.equal(invalidated.status, 200, JSON.stringify(invalidated.data));
    assert.equal(how.state.name, "Triage"); assert.equal(s.fixture.pulls[0].state, "closed");
    assert.equal(s.fixture.refs.get(original.branch), head, "Interrupted source checkpoints are preserved");
    assert.equal((await s.action(reconcile, "invalidate")).status, 200);
    await s.message({ type: "release", lease_id: reconcile });
    how.state = { ...s.fixture.states.find(state => state.id === "progress") };
    s.fixture.refs.set(`oriel/${how.identifier}-gh-42-${"f".repeat(64)}`, "3".repeat(40));
    const ambiguous = (await s.snapshot()).workflows[0]; assert.equal(ambiguous.recovery, null);
    assert.match(ambiguous.blocked_reason, /ambiguous/);
    const rejected = await s.message({ type: "claim", kind: "reconcile", issue_number: 42, version: ambiguous.version, branch: ambiguous.branch }); assert.equal(rejected.type, "rejected");
  } finally { await s.close(); }
});

test("current review facts and signed response cursors bound each failed check to three attempts", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    s.fixture.addHow(); const row = (await s.snapshot()).workflows[0]; const implementation = await s.claim("implement");
    assert.equal((await s.action(implementation, "begin")).status, 200);
    const head = "2".repeat(40); s.fixture.refs.set(row.branch, head);
    const published = await s.action(implementation, "publish", { head_oid: head, verified: true, summary: "Verified source" }); assert.equal(published.status, 200);
    await s.message({ type: "release", lease_id: implementation });
    const pr = published.data.pull_request;
    s.fixture.reviews.set(pr.number, [{ id: 1, state: "CHANGES_REQUESTED", body: "Correct the boundary", submitted_at: "2026-01-01T00:00:00.000Z", user: { login: "reviewer" } }]);
    s.fixture.reviewComments.set(pr.number, [{ id: 1, pull_request_review_id: 1, path: "src/change.rs", line: 7, body: "Off by one", commit_id: head }]);
    const review = (await s.snapshot()).workflows[0].feedback; assert.equal(review.kind, "review"); assert.equal(review.comments[0].line, 7);
    const responding = await s.claim("respond");
    assert.equal((await s.action(responding, "responded", { head_oid: head, verified: true, feedback_key: "comment:unrelated", summary: "Not admitted" })).status, 409);
    const comment = s.fixture.reviewComments.get(pr.number)[0]; comment.line = null;
    assert.equal((await s.action(responding, "responded", { head_oid: head, verified: true, feedback_key: review.key, summary: "Adopted verified response checkpoint" })).status, 200);
    await s.message({ type: "release", lease_id: responding });
    assert.equal((await s.snapshot()).workflows[0].feedback, null);
    for (let attempt = 1; attempt <= 3; attempt++) {
      s.fixture.checks.push({ id: attempt, name: "required-test", head_sha: head, status: "completed", conclusion: "failure", completed_at: `2026-01-01T00:00:0${attempt}.000Z`, output: { title: "Failure", summary: "Fix actual behavior", text: null } });
      const feedback = (await s.snapshot()).workflows[0].feedback; assert.equal(feedback.kind, "check_failure");
      const lease = await s.claim("respond");
      const response = await s.action(lease, "responded", { head_oid: head, verified: true, feedback_key: feedback.key, summary: `Verified attempt ${attempt}` });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      await s.message({ type: "release", lease_id: lease });
    }
    s.fixture.checks.push({ id: 4, name: "required-test", head_sha: head, status: "completed", conclusion: "failure", completed_at: "2026-01-01T00:00:04.000Z", output: { title: "Failure", summary: "Still failing", text: null } });
    const exhausted = (await s.snapshot()).workflows[0]; assert.equal(exhausted.feedback, null); assert.match(exhausted.blocked_reason, /3 verified attempts/);
    const rejected = await s.message({ type: "claim", kind: "respond", issue_number: 42, version: exhausted.version, branch: exhausted.branch }); assert.equal(rejected.type, "rejected");
    s.fixture.checks.push({ id: 5, name: "required-test", head_sha: head, status: "completed", conclusion: "success", completed_at: "2099-01-01T00:00:00.000Z", output: { title: null, summary: null, text: null } });
    s.fixture.checks.push({ id: 6, name: "required-test", head_sha: head, status: "completed", conclusion: "failure", completed_at: "2099-01-01T00:00:01.000Z", output: { title: "New regression", summary: "Fresh failure after success", text: null } });
    assert.equal((await s.snapshot()).workflows[0].feedback.kind, "check_failure", "Actual success resets the externally reconstructed retry streak");
  } finally { await s.close(); }
});

test("commit-pinned configuration and canonical-head races revoke publication rather than publish unchecked work", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow(); const row = (await s.snapshot()).workflows[0]; const implementation = await s.claim("implement");
    assert.equal((await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: implementation }, hostHeaders)).status, 409, "An unsealed Todo cannot obtain writable Git credentials");
    assert.equal((await s.action(implementation, "begin")).status, 200);
    const head = "2".repeat(40); s.fixture.refs.set(row.branch, head);
    let changed = false;
    s.fixture.holdReads = ({ operation }) => { if (operation === "compare" && !changed) { changed = true; s.fixture.refs.set(row.branch, "3".repeat(40)); } };
    const raced = await s.action(implementation, "publish", { head_oid: head, verified: true, summary: "Verified old head" });
    assert.equal(raced.status, 409); assert.equal(s.fixture.pulls.length, 0);
    s.fixture.holdReads = undefined;
    s.fixture.target_oid = "4".repeat(40);
    assert.equal((await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: implementation }, hostHeaders)).status, 409);
    assert.equal((await s.action(implementation, "publish", { head_oid: "3".repeat(40), verified: true, summary: "Target changed" })).status, 409);
    assert.equal(s.fixture.pulls.length, 0); assert.equal(how.state.name, "In Progress");
  } finally { await s.close(); }
});

test("source proof traverses native trees when GitHub truncates a documentation-heavy comparison", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    s.fixture.addHow(); const row = (await s.snapshot()).workflows[0]; const lease = await s.claim("implement");
    assert.equal((await s.action(lease, "begin")).status, 200);
    const head = "2".repeat(40); s.fixture.refs.set(row.branch, head);
    s.fixture.compare = { status: "ahead", total_commits: 1, files: Array.from({ length: 300 }, (_, index) => ({ filename: `docs/${index}.md`, status: "added" })) };
    s.fixture.trees.set(s.fixture.target_oid, { tree: [], truncated: false });
    s.fixture.trees.set(head, { tree: [{ path: "docs", type: "tree", sha: "d".repeat(40) }], truncated: false });
    s.fixture.trees.set("d".repeat(40), { tree: [{ path: "request.md", type: "blob", sha: "e".repeat(40) }], truncated: false });
    assert.equal((await s.action(lease, "publish", { head_oid: head, verified: true, summary: "Documentation only" })).status, 409);
    assert.equal(s.fixture.pulls.length, 0);
    s.fixture.trees.get(head).tree.push({ path: "src", type: "tree", sha: "a".repeat(40) });
    s.fixture.trees.set("a".repeat(40), { tree: [{ path: "fix.rs", type: "blob", sha: "b".repeat(40) }], truncated: true });
    assert.equal((await s.action(lease, "publish", { head_oid: head, verified: true, summary: "Unknown tree" })).status, 409);
    assert.equal(s.fixture.pulls.length, 0);
    s.fixture.trees.get("a".repeat(40)).truncated = false;
    const published = await s.action(lease, "publish", { head_oid: head, verified: true, summary: "Actual source after 300 documented files" });
    assert.equal(published.status, 200, JSON.stringify(published.data)); assert.equal(published.data.pull_request.head_oid, head);
  } finally { await s.close(); }
});

test("formal linking paginates attachments and issues before deciding uniqueness or approving code", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow(); s.fixture.attachmentPageSize = 1; s.fixture.issuePageSize = 1;
    how.attachments.unshift({ url: "https://example.com/unrelated" });
    assert.equal((await s.snapshot()).workflows[0].phase, "approved");
    how.attachments.push({ url: "https://github.com/foreign/repository/issues/9" });
    assert.equal((await s.snapshot()).workflows[0].phase, "blocked");
    how.attachments.pop();
    const foreign = structuredClone(how); foreign.id = "22222222-2222-5222-a222-222222222222"; foreign.team.id = "foreign";
    s.fixture.linears.push(foreign);
    const ambiguous = (await s.snapshot()).workflows[0]; assert.equal(ambiguous.phase, "blocked"); assert.equal(ambiguous.fingerprint, null);
    const rejected = await s.message({ type: "claim", kind: "implement", issue_number: 42, version: ambiguous.version, branch: ambiguous.branch }); assert.equal(rejected.type, "rejected");
  } finally { await s.close(); }
});

test("human HOW edits during final admission reads are never overwritten", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow("Triage");
    const lease = await s.claim("plan");
    let reads = 0;
    s.fixture.holdReads = ({ operation }) => {
      if (operation === "states" && ++reads === 2) how.description = "Human-authored HOW must survive.";
    };
    const result = await s.action(lease, "proposal", { title: "Agent proposal", description: "Agent-authored HOW" });
    assert.equal(result.status, 409);
    assert.equal(how.description, "Human-authored HOW must survive.");
    assert.equal(how.title, "Implement the HOW");
  } finally { await s.close(); }
});

test("human completion during invalidation reads is never returned to Triage", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow();
    const lease = await s.claim("implement");
    assert.equal((await s.action(lease, "begin")).status, 200);
    how.description = "Human changed the approved implementation.";
    let reads = 0;
    s.fixture.holdReads = ({ operation }) => {
      if (operation === "states" && ++reads === 2) how.state = { ...s.fixture.states.find(state => state.name === "Done") };
    };
    const result = await s.action(lease, "invalidate");
    assert.equal(result.status, 409);
    assert.equal(how.state.name, "Done");
  } finally { await s.close(); }
});

test("a canonical head changed during final admission reads cannot create a ready PR", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    s.fixture.addHow();
    const row = (await s.snapshot()).workflows[0];
    const lease = await s.claim("implement");
    assert.equal((await s.action(lease, "begin")).status, 200);
    const verified = "2".repeat(40);
    s.fixture.refs.set(row.branch, verified);
    let reads = 0;
    s.fixture.holdReads = ({ operation }) => {
      if (operation === "states" && ++reads === 2) s.fixture.refs.set(row.branch, "3".repeat(40));
    };
    const result = await s.action(lease, "publish", { head_oid: verified, verified: true, summary: "Verified candidate" });
    assert.equal(result.status, 409);
    assert.equal(s.fixture.pulls.length, 0);
  } finally { await s.close(); }
});

test("initial HOW requires a human command and invalidates edited or deleted requests", async () => {
  const s = await setup();
  try {
    const row = async () => (await s.snapshot()).workflows.find(row => row.issue.number === 42);
    s.fixture.comments.set(42, []);
    for (const body of ["", "@oriel", "/oriel how?", "> /oriel how", "```\n/oriel how\n```", "Do not /oriel how"]) {
      s.fixture.comments.set(42, [{ id: 10, body, user: { login: "human", type: "User" }, created_at: "2026-01-01T00:00:00Z" }]);
      const waiting = await row();
      assert.equal(waiting.phase, "waiting-how");
      assert.equal((await s.message({ type: "claim", kind: "plan", issue_number: 42, version: waiting.version, branch: null })).type, "rejected");
    }
    const request = s.fixture.comments.get(42)[0];
    request.body = "/oriel how"; request.user.type = "Bot";
    assert.equal((await row()).phase, "waiting-how");
    request.user.type = "User";
    const ready = await row();
    assert.equal(ready.phase, "needs-how");
    assert.equal((await row()).version, ready.version);
    const lease = await s.claim("plan");
    request.body = "/oriel how?";
    assert.notEqual((await row()).version, ready.version);
    assert.equal((await s.action(lease, "proposal", { title: "HOW", description: "Plan" })).status, 409);
    request.body = "/oriel how";
    assert.equal((await row()).version, ready.version);
    s.fixture.comments.set(42, []);
    assert.equal((await row()).phase, "waiting-how");
    assert.equal((await s.action(lease, "proposal", { title: "HOW", description: "Plan" })).status, 409);
    assert.deepEqual(s.fixture.linears, []);
    s.fixture.addHow("Triage");
    assert.equal((await row()).phase, "triage", "Existing HOW survives request deletion");
    s.fixture.linears = [];
    s.fixture.comments.set(42, [request]); request.body = "/oriel how";
    s.fixture.issues[0].state = "closed";
    assert.equal((await row()).phase, "closed");
  } finally { await s.close(); }
});

test("initial HOW retries remain idempotent after the request is removed", async () => {
  const s = await setup();
  try {
    const lease = await s.claim("plan");
    const draft = { title: "HOW", description: "Resolve open WHAT questions before Todo." };
    const proposal = await s.action(lease, "proposal", draft);
    assert.equal(proposal.status, 200, JSON.stringify(proposal.data));
    s.fixture.comments.set(42, []);
    const retry = await s.action(lease, "proposal", draft);
    assert.equal(retry.status, 200, JSON.stringify(retry.data));
    assert.equal(retry.data.linear.id, proposal.data.linear.id);
    assert.equal(s.fixture.linears.length, 1);
    const row = (await s.snapshot()).workflows.find(row => row.issue.number === 42);
    assert.equal(row.phase, "triage");
    assert.equal((await s.message({ type: "claim", kind: "implement", issue_number: 42, version: row.version, branch: row.branch })).type, "rejected");
  } finally { await s.close(); }
});

test("request deletion during final creation reads prevents initial HOW creation", async () => {
  const s = await setup();
  try {
    const lease = await s.claim("plan");
    let reads = 0;
    s.fixture.holdReads = ({ operation }) => {
      if (operation === "states" && ++reads === 2) s.fixture.comments.set(42, []);
    };
    const result = await s.action(lease, "proposal", { title: "HOW", description: "Plan for review." });
    assert.equal(result.status, 409);
    assert.deepEqual(s.fixture.linears, []);
  } finally { await s.close(); }
});
