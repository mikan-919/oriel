import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { authorize, client, connect, device, hostHeaders, origin, pair, runtime } from "./helpers.mjs";
import { workflowFixture } from "./workflow-fixture.mjs";

async function setup(measureSql = false) {
  const fixture = workflowFixture();
  const worker = await runtime(fixture.env, request => fixture.fetch(request), measureSql);
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

test("Discovery overlaps independent reads and bounded HOW and issue batches without dropping facts", {timeout:10000}, async () => {
  const s = await setup();
  const releases = [];
  let timer;
  try {
    for (let number = 43; number < 50; number++) {
      s.fixture.issues.push({...s.fixture.issues[0],number,node_id:`I_${number}`,html_url:`https://github.com/octocat/connected/issues/${number}`});
    }
    for (let number = 42; number < 46; number++) {
      const how = s.fixture.addHow("Todo", number);
      how.id = `11111111-1111-5111-a111-${String(number).padStart(12,"0")}`;
      how.identifier = `ENG-${number}`;
    }
    const gate = () => {let release;const ready = new Promise(resolve=>{release=resolve;});releases.push(release);return {ready,release};};
    const reference = gate(), how = gate();
    let howReads = 0, commentReads = 0;
    s.fixture.holdReads = async ({operation}) => {
      if(operation==="ref") await reference.ready;
      if(operation==="whats") reference.release();
      if(operation==="how") {if(++howReads===1) await how.ready;else how.release();}
      if(operation==="pr-comments") commentReads++;
    };
    const snapshot = await Promise.race([s.snapshot(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Independent discovery reads were serialized")),3000);})]);
    assert.deepEqual(snapshot.workflows.map(row=>row.issue.number), [42,43,44,45,46,47,48,49]);
    assert.equal(howReads,4); // HOW metadata is batched; four discussion collections remain.
    assert.equal(commentReads,1,"All eight WHAT discussions fit in one bounded GraphQL batch");
    for(const row of snapshot.workflows.slice(0,4)) assert.equal(row.phase,"approved");
  } finally {
    clearTimeout(timer);s.fixture.holdReads=undefined;for(const release of releases)release();await s.close();
  }
});

test("Read tokens are reused within expiry while provider facts and access generations stay live", async () => {
  const s = await setup();
  try {
    s.fixture.addHow("Todo");
    await s.snapshot();
    const minted = s.fixture.grants.length;
    s.fixture.issues[0].title = "Human changed the WHAT";
    assert.equal((await s.snapshot()).workflows[0].issue.title, "Human changed the WHAT");
    assert.equal(s.fixture.grants.length, minted, "Fresh facts must not mint a new read token each time");
    s.fixture.failures.set("repository",503);
    assert.equal((await s.daemon.api(`/api/workflows/${device}`,undefined,hostHeaders)).status,502);
    s.fixture.failures.delete("repository");
    await connect(s.owner,s.fixture,"github");
    await s.snapshot();
    assert.equal(s.fixture.grants.length,minted+1,"A new authorization generation cannot reuse the old token");
    const provider = s.fixture.fetch.bind(s.fixture);
    s.fixture.fetch = async request => {
      const response = await provider(request);
      if (new URL(request.url).pathname.endsWith("/access_tokens") &&
          (await request.clone().json()).permissions.issues === "read") {
        return Response.json({...await response.json(),expires_at:new Date(Date.now()+60000).toISOString()});
      }
      return response;
    };
    await connect(s.owner,s.fixture,"github");
    await s.snapshot();
    const shortLived = s.fixture.grants.length;
    await s.snapshot();
    assert.equal(s.fixture.grants.length,shortLived+1,"Tokens near expiry must be replaced");
  } finally {await s.close();}
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
    const proposal = await s.action(await s.claim("plan"), "proposal", { title: "HOW", description: "Scope for human review.", summary: "Prepared the HOW for human review." });
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
    s.fixture.missingHowStatus = 404;
    const missing = { message: "Entity not found: Issue", path: ["issue"], extensions: { code: "INPUT_ERROR" } };
    const forbidden = { message: "Entity not found: Issue", path: ["issue"], extensions: { code: "FORBIDDEN" } };
    for (const errors of [[forbidden], [missing, forbidden]]) {
      s.fixture.missingHowErrors = errors;
      assert.equal((await s.action(lease, "proposal", { title: "HOW", description: "Review before approving implementation.", summary: "Prepared the HOW; implementation awaits approval." })).status, 502);
      assert.deepEqual(s.fixture.linears, []);
    }
    s.fixture.missingHowErrors = [missing];
    const proposal = await s.action(lease, "proposal", { title: "HOW", description: "Review before approving implementation.", summary: "Prepared the HOW; implementation awaits approval." });
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
    const proposal = await s.action(lease, "proposal", { title: "HOW plan", description: "Implement source and run verification.", summary: "Prepared the HOW with implementation and verification steps." });
    assert.equal(proposal.status, 200, JSON.stringify(proposal.data));
    assert.equal(proposal.data.linear.state.name, "Triage");
    assert.equal(s.fixture.linears.length, 1);
    s.fixture.linears[0].description = "Human refinement remains authoritative";
    const retry = await s.action(lease, "proposal", { title: "HOW plan", description: "Implement source and run verification.", summary: "Prepared the HOW with implementation and verification steps." });
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
    s.fixture.comments.set(42, []); // Exercise HOW feedback without a pending Issue command.
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

test("HOW transitions ignore attachment order and PR links but preserve formal Issue links", async () => {
  for (const [change, allowed] of [
    [how => how.attachments.reverse(), true],
    [how => how.attachments.unshift({ url: "https://github.com/octocat/connected/pull/90" }), true],
    [how => how.attachments.shift(), false],
    [how => { how.attachments[0].url += "?alias=1"; }, false],
    [how => how.attachments.push({ url: "https://github.com/foreign/repo/issues/9" }), false],
  ]) {
    const s = await setup();
    try {
      const how = s.fixture.addHow();
      how.attachments.push({ url: "https://example.com/reference" });
      const approved = (await s.snapshot()).workflows[0];
      s.fixture.refs.set(approved.branch, s.fixture.target_oid);
      const lease = await s.claim("implement");
      let injected = false;
      s.fixture.holdReads = ({ provider, operation, body }) => {
        if (provider !== "linear" || operation !== "how" || !body.query.includes("attachments(")) return;
        // Collection reads supply the baseline; this direct read precedes issueUpdate.
        if (!injected) { change(how); injected = true; }
      };
      const result = await s.action(lease, "begin");
      assert.equal(injected, true);
      assert.equal(result.status, allowed ? 200 : 409, JSON.stringify(result.data));
      assert.equal(how.state.name, allowed ? "In Progress" : "Todo");
      if (!allowed) {
        assert.match(result.data.error, /HOW update \(attachments\)/);
        assert.equal(s.fixture.calls.filter(call => call.operation === "how-update").length, 0);
      }
    } finally { await s.close(); }
  }
});

test("canonical update receipts do not hide intervening human edits", async () => {
  const s = await setup();
  try {
    s.fixture.comments.set(42, []); // Exercise HOW feedback without a pending Issue command.
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
    s.fixture.comments.set(42, []); // Exercise HOW feedback without a pending Issue command.
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
    const responseToken = await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: responding }, hostHeaders);
    assert.equal(responseToken.status, 200, JSON.stringify(responseToken.data));
    assert.deepEqual(s.fixture.grants.at(-1), { contents: "write", metadata: "read", workflows: "write" });
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

test("begin accepts an already completed In Progress transition without overwriting other states", { timeout: 60000 }, async () => {
  for (const stateId of ["progress", "review", "triage", "done", "canceled"]) {
    const s = await setup();
    try {
      const how = s.fixture.addHow();
      const approved = (await s.snapshot()).workflows[0];
      s.fixture.refs.set(approved.branch, s.fixture.target_oid);
      const lease = await s.claim("implement");
      let reads = 0;
      s.fixture.holdReads = ({ operation }) => {
        // The first begin read sees Todo. Another actor completes the transition
        // before workflowUpdateHow rechecks its admission.
        if (operation === "hows" && ++reads === 2) how.state = { ...s.fixture.states.find(state => state.id === stateId) };
      };
      const result = await s.action(lease, "begin");
      assert.ok(reads >= 2, "The concurrent transition must occur inside begin");
      assert.equal(result.status, stateId === "progress" ? 200 : 409, JSON.stringify(result.data));
      assert.equal(how.state.id, stateId);
      assert.equal(s.fixture.calls.filter(call => call.operation === "how-update").length, 0);
      if (stateId === "progress") {
        assert.equal(result.data.branch, approved.branch);
        assert.equal(result.data.canonical_oid, s.fixture.target_oid);
      } else if (stateId === "review") {
        assert.match(result.data.error, /^Human changes prevented the HOW update/);
      } else {
        const actual = { triage: "triage", done: "blocked", canceled: "closed" }[stateId];
        assert.ok(result.data.error.includes(`expected: approved, running; actual: ${actual}`), result.data.error);
      }
    } finally { await s.close(); }
  }
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

test("changed approvals and failures return to Triage with reasons and require human reapproval", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow(); const initial = (await s.snapshot()).workflows[0];
    const lease = await s.claim("implement"); assert.equal((await s.action(lease, "begin")).status, 200);
    s.fixture.failures.set("workflow-token", 422);
    delete s.fixture.installationPermissions.workflows;
    const denied = await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: lease }, hostHeaders);
    assert.equal(denied.status, 502);
    assert.match(denied.data.error, /workflows=write/);
    assert.match(denied.data.error, /approve updated permissions/);
    assert.match(denied.data.error, /Installation 101 \(App 123\) grants: contents=write, metadata=read, workflows=not granted/);
    assert.doesNotMatch(JSON.stringify(denied.data), /private-provider-diagnostic|must-not-leak-token/);
    s.fixture.installationPermissions.workflows = "write";
    const grantedButRejected = await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: lease }, hostHeaders);
    assert.equal(grantedButRejected.status, 502);
    assert.match(grantedButRejected.data.error, /grants: contents=write, metadata=read, workflows=write/);
    s.fixture.failures.set("installation-permissions", 503);
    const unknown = await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: lease }, hostHeaders);
    assert.equal(unknown.status, 502);
    assert.match(unknown.data.error, /permission readback unavailable/);
    assert.doesNotMatch(JSON.stringify(unknown.data), /private-provider-diagnostic|must-not-leak-token/);
    s.fixture.failures.delete("installation-permissions");
    s.fixture.failures.delete("workflow-token");
    const token = await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: lease }, hostHeaders);
    assert.equal(token.status, 200, JSON.stringify(token.data)); assert.deepEqual(s.fixture.grants.at(-1), { contents: "write", metadata: "read", workflows: "write" });
    how.description += " Human changed the HOW.";
    assert.equal((await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: lease }, hostHeaders)).status, 409);
    assert.equal((await s.action(lease, "publish", { head_oid: initial.canonical_oid, verified: true, summary: "Stale" })).status >= 400, true);
    const invalidated = await s.action(lease, "invalidate"); assert.equal(invalidated.status, 200, JSON.stringify(invalidated.data)); assert.equal(how.state.name, "Triage");
    assert.match(how.comments[0].body, /差し戻し理由（承認内容の変更）/);
    assert.match(how.comments[0].body, /WHATまたはHOW/);
    await s.message({ type: "release", lease_id: lease });
    const plan = await s.claim("plan");
    const readonly = await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: plan }, hostHeaders);
    assert.equal(readonly.status, 200); assert.deepEqual(s.fixture.grants.at(-1), { contents: "read", metadata: "read" });
    await s.message({ type: "release", lease_id: plan }); how.state = { ...s.fixture.states.find(state => state.id === "todo") };
    const broken = await s.claim("implement"); assert.equal((await s.action(broken, "begin")).status, 200);
    s.fixture.uncertainty.set("how-comment", true); s.fixture.uncertainty.set("how-update", true);
    const beforeFailure = (await s.snapshot()).workflows[0];
    const reason = "npm test failed after 2 repair attempts: private-linear-access";
    const failure = await s.action(broken, "fail", { reason, category: "verification" });
    assert.equal(failure.status, 200, JSON.stringify(failure.data)); assert.equal(how.state.name, "Triage");
    assert.equal((await s.snapshot()).workflows[0].phase, "triage");
    assert.match(how.comments.at(-1).body, /差し戻し理由（検証失敗）/);
    assert.match(how.comments.at(-1).body, /npm test failed after 2 repair attempts/);
    assert.match(how.comments.at(-1).body, /必要な対応:[\s\S]*再承認/);
    assert.equal(how.comments.at(-1).body.includes("private-linear-access"), false);
    assert.equal(s.fixture.refs.get(beforeFailure.branch), beforeFailure.canonical_oid, "Existing source checkpoint is retained");
    const count = how.comments.length;
    assert.equal((await s.action(broken, "fail", { reason, category: "verification" })).status, 200);
    assert.equal(how.comments.length, count, "An uncertain return is not reported twice");
    assert.equal((await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: broken }, hostHeaders)).status, 409);
    await s.message({ type: "release", lease_id: broken });
    const returned = (await s.snapshot()).workflows[0];
    assert.equal((await s.message({ type: "claim", kind: "implement", issue_number: 42, version: returned.version, branch: returned.branch })).type, "rejected");
    how.state = { ...s.fixture.states.find(state => state.id === "todo") };
    assert.equal((await s.snapshot()).workflows[0].version, beforeFailure.version);
    const reapproved = await s.claim("implement");
    assert.equal((await s.action(reapproved, "begin")).status, 200);
    assert.equal((await s.snapshot()).workflows[0].canonical_oid, beforeFailure.canonical_oid);
    await s.owner.api("/api/integrations/github/disconnect", {});
    const revoked = await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: reapproved }, hostHeaders); assert.equal(revoked.status, 409);
  } finally { await s.close(); }
});

test("a failed review returns to Triage with the required decision while retaining the PR", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow(); const row = (await s.snapshot()).workflows[0];
    const implementation = await s.claim("implement");
    assert.equal((await s.action(implementation, "begin")).status, 200);
    const head = "2".repeat(40); s.fixture.refs.set(row.branch, head);
    assert.equal((await s.action(implementation, "publish", { head_oid: head, verified: true, summary: "Verified implementation" })).status, 200);
    await s.message({ type: "release", lease_id: implementation });
    s.fixture.checks.push({ app: { id: 101 }, id: 1, name: "required-test", head_sha: head, status: "completed", conclusion: "failure", completed_at: "2026-01-01T00:00:01.000Z", output: { title: "Failure", summary: "Fix actual behavior", text: null } });
    const beforeFailure = (await s.snapshot()).workflows[0];
    const response = await s.claim("respond");
    const reason = "公開認証方式が未確定です。トークン認証か信頼された発行元を選び、HOWに記載してください。";
    const failure = await s.action(response, "fail", { category: "needs-human", reason });
    assert.equal(failure.status, 200, JSON.stringify(failure.data));
    assert.equal(how.state.name, "Triage");
    assert.match(how.comments.at(-1).body, /差し戻し理由（人の判断が必要）/);
    assert.ok(how.comments.at(-1).body.includes(reason));
    assert.equal(s.fixture.pulls[0].state, "open");
    assert.equal(s.fixture.refs.get(row.branch), head);
    assert.equal((await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: response }, hostHeaders)).status, 409);
    await s.message({ type: "release", lease_id: response });
    const waiting = (await s.snapshot()).workflows[0];
    assert.equal(waiting.feedback, null);
    assert.match(waiting.blocked_reason, /human Todo reapproval/);
    const denied = await s.message({ type: "claim", kind: "respond", issue_number: 42, version: waiting.version, branch: waiting.branch });
    assert.equal(denied.type, "rejected", "Failure and an existing PR do not infer renewed approval");
    assert.equal((await s.snapshot()).workflows[0].phase, "triage");
    how.state = { ...s.fixture.states.find(state => state.id === "todo") };
    const renewed = (await s.snapshot()).workflows[0];
    assert.equal(renewed.phase, "review");
    assert.equal(renewed.pull_request.number, s.fixture.pulls[0].number);
    assert.equal(renewed.branch, row.branch);
    assert.equal(renewed.feedback.kind, "check_failure");
    assert.equal(renewed.version, beforeFailure.version);
    assert.equal(renewed.feedback.key, beforeFailure.feedback.key);
    const repair = await s.claim("respond");
    assert.equal((await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: repair }, hostHeaders)).status, 200);
    assert.equal((await s.action(repair, "responded", { head_oid: head, verified: true, feedback_key: renewed.feedback.key, summary: "Verified after human reapproval" })).status, 200);
    await s.message({ type: "release", lease_id: repair });
    assert.equal((await s.snapshot()).workflows[0].feedback, null);
    s.fixture.pulls[0].state = "closed";
    const closed = (await s.snapshot()).workflows[0];
    assert.equal(closed.phase, "blocked");
    assert.match(closed.blocked_reason, /PR closed without merge/);
  } finally { await s.close(); }
});

test("failure return preserves terminal human states and accepts legacy reasons", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow(); const implementation = await s.claim("implement");
    assert.equal((await s.action(implementation, "begin")).status, 200);
    assert.equal((await s.action(implementation, "fail", { category: "unknown", reason: "Unknown category" })).status, 400);
    assert.equal(how.state.name, "In Progress");
    for (const id of ["done", "canceled"]) {
      how.state = { ...s.fixture.states.find(state => state.id === id) };
      assert.equal((await s.action(implementation, "fail", { reason: "Command could not start" })).status, 200);
      assert.equal(how.state.id, id); assert.equal(how.comments.length, 0);
    }
    how.state = { ...s.fixture.states.find(state => state.id === "progress") };
    const reason = `Command could not start ${"x".repeat(3966)}private-linear-access UNBOUNDEDTAIL`;
    assert.equal((await s.action(implementation, "fail", { reason })).status, 200);
    assert.equal(how.state.name, "Triage");
    assert.match(how.comments.at(-1).body, /差し戻し理由（実行失敗）:[\s\S]*Command could not start/);
    assert.ok(how.comments.at(-1).body.includes("[redacted]"));
    assert.ok(!how.comments.at(-1).body.includes("private-linear"));
    assert.ok(!how.comments.at(-1).body.includes("UNBOUNDEDTAIL"));
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

test("managed PR conflicts resume approved work without comments or failed checks", async () => {
  const s = await setup();
  try {
    const how = s.fixture.addHow();
    const row = (await s.snapshot()).workflows[0], implementation = await s.claim("implement");
    assert.equal((await s.action(implementation, "begin")).status, 200);
    const head = "2".repeat(40); s.fixture.refs.set(row.branch, head);
    assert.equal((await s.action(implementation, "publish", { head_oid: head, verified: true, summary: "Verified source" })).status, 200);
    await s.message({ type: "release", lease_id: implementation });
    const pr = s.fixture.pulls[0];
    s.fixture.addCheck({ conclusion: "success" });
    for (const mergeable of [undefined, null, true]) {
      pr.mergeable = mergeable;
      assert.equal((await s.snapshot()).workflows[0].feedback, null);
    }
    pr.mergeable = false;
    const conflict = (await s.snapshot()).workflows[0];
    assert.equal(conflict.phase, "review"); assert.equal(conflict.ci.status, "success");
    assert.equal(conflict.feedback.kind, "merge_conflict");
    assert.equal(conflict.feedback.key, `conflict:${pr.number}:${head}:${s.fixture.target_oid}`);
    const lease = await s.claim("respond");
    await s.message({ type: "release", lease_id: lease });
    const review = { ...how.state };
    for (const disabled of ["triage", "configuration", "draft", "unmanaged"]) {
      if (disabled === "triage") how.state = { ...s.fixture.states.find(state => state.name === "Triage") };
      if (disabled === "configuration") s.fixture.autonomous = false;
      if (disabled === "draft") pr.draft = true;
      if (disabled === "unmanaged") pr.body = "Human-managed PR";
      const blocked = (await s.snapshot()).workflows[0];
      assert.equal(blocked.feedback, null, disabled);
      const rejected = await s.message({ type: "claim", kind: "respond", issue_number: 42, version: blocked.version, branch: blocked.branch });
      assert.equal(rejected.type, "rejected", disabled);
      how.state = { ...review }; s.fixture.autonomous = true; pr.draft = false; pr.body = "Closes #42";
    }
  } finally { await s.close(); }
});

test("conflict repairs survive hibernation, acknowledge the admitted head once and pin the target", async () => {
  const s = await setup();
  try {
    s.fixture.addHow(); const row = (await s.snapshot()).workflows[0], implementation = await s.claim("implement");
    assert.equal((await s.action(implementation, "begin")).status, 200);
    const head = "2".repeat(40); s.fixture.refs.set(row.branch, head);
    const published = await s.action(implementation, "publish", { head_oid: head, verified: true, summary: "Verified source" });
    assert.equal(published.status, 200);
    await s.message({ type: "release", lease_id: implementation });
    const pr = s.fixture.pulls[0]; pr.mergeable = false;
    const feedback = (await s.snapshot()).workflows[0].feedback, lease = await s.claim("respond");
    const token = () => s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: lease }, hostHeaders);
    assert.equal((await token()).status, 200);
    await s.worker.unsafeEvictDurableObject("oriel-relay", "AccountRegistry", { name: "accounts" });
    assert.equal((await token()).status, 200);
    const repaired = "4".repeat(40); s.fixture.refs.set(row.branch, repaired); pr.mergeable = true;
    assert.equal((await s.snapshot()).workflows[0].feedback, null);
    assert.equal((await token()).status, 200, "The admitted cursor remains valid for verified push readback");
    const response = { head_oid: repaired, verified: true, feedback_key: feedback.key, summary: "Integrated target and verified conflict resolution" };
    assert.equal((await s.action(lease, "responded", { ...response, verified: false })).status, 400);
    assert.equal((await s.action(lease, "responded", response)).status, 200);
    const comments = s.fixture.comments.get(pr.number).length;
    assert.equal((await s.action(lease, "responded", response)).status, 200);
    assert.equal(s.fixture.comments.get(pr.number).length, comments);
    await s.message({ type: "release", lease_id: lease });
    // Replaying the same conflicting pair cannot wake another repair.
    s.fixture.refs.set(row.branch, head); pr.mergeable = false;
    assert.equal((await s.snapshot()).workflows[0].feedback, null);
    s.fixture.refs.set(row.branch, repaired);
    s.fixture.target_oid = "5".repeat(40); s.fixture.refs.set("main", s.fixture.target_oid);
    const next = (await s.snapshot()).workflows[0].feedback;
    assert.equal(next.kind, "merge_conflict"); assert.notEqual(next.key, feedback.key);
    const stale = await s.claim("respond");
    s.fixture.target_oid = "6".repeat(40); s.fixture.refs.set("main", s.fixture.target_oid);
    assert.equal((await s.daemon.api(`/api/workflows/${device}/git-token`, { lease_id: stale }, hostHeaders)).status, 409);
    assert.equal((await s.action(stale, "responded", { ...response, feedback_key: next.key })).status, 409);
    assert.equal(s.fixture.linears[0].state.name, "In Review");
  } finally { await s.close(); }
});

test("mergeability reads reject PR and target races instead of starting stale repairs", async () => {
  const s = await setup();
  try {
    s.fixture.addHow(); const row = (await s.snapshot()).workflows[0], implementation = await s.claim("implement");
    assert.equal((await s.action(implementation, "begin")).status, 200);
    const head = "2".repeat(40); s.fixture.refs.set(row.branch, head);
    assert.equal((await s.action(implementation, "publish", { head_oid: head, verified: true, summary: "Verified source" })).status, 200);
    await s.message({ type: "release", lease_id: implementation });
    const pr = s.fixture.pulls[0]; pr.mergeable = false;
    for (const race of ["head", "target", "base", "closed", "foreign"]) {
      let changed = false;
      s.fixture.holdReads = async ({ operation }) => {
        if (operation !== "pr" || changed) return;
        changed = true;
        if (race === "head") s.fixture.refs.set(row.branch, "3".repeat(40));
        if (race === "target") s.fixture.refs.set("main", "3".repeat(40));
        if (race === "base") pr.base.ref = "other";
        if (race === "closed") pr.state = "closed";
        if (race === "foreign") pr.head.repo.id = 999;
      };
      const stale = await s.daemon.api(`/api/workflows/${device}`, undefined, hostHeaders);
      assert.equal(stale.status, 409, `${race}: ${JSON.stringify(stale.data)}`);
      s.fixture.holdReads = undefined;
      s.fixture.refs.set(row.branch, head); s.fixture.refs.set("main", s.fixture.target_oid);
      pr.base.ref = "main"; pr.state = "open"; pr.head.repo.id = 501;
    }
    s.fixture.failures.set("pr", 503);
    assert.equal((await s.daemon.api(`/api/workflows/${device}`, undefined, hostHeaders)).status, 502);
    s.fixture.failures.delete("pr");
    assert.equal((await s.snapshot()).workflows[0].feedback.kind, "merge_conflict");
  } finally { await s.close(); }
});

test("ordinary human and bot PR comments resume once, with edits revoking stale feedback", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    s.fixture.addHow(); const row = (await s.snapshot()).workflows[0]; const implementation = await s.claim("implement");
    assert.equal((await s.action(implementation, "begin")).status, 200);
    const head = "2".repeat(40); s.fixture.refs.set(row.branch, head);
    const published = await s.action(implementation, "publish", { head_oid: head, verified: true, summary: "Verified source" }); assert.equal(published.status, 200);
    await s.message({ type: "release", lease_id: implementation });
    const pr = published.data.pull_request;
    s.fixture.feedback(pr.number, "Why does this return early?");
    const request = s.fixture.comments.get(pr.number).at(-1);
    const first = (await s.snapshot()).workflows[0].feedback; assert.equal(first.kind, "comment"); assert.equal(first.body, request.body);
    const stale = await s.claim("respond");
    request.body = "Please handle the empty input instead.";
    assert.equal((await s.action(stale, "responded", { head_oid: head, verified: true, feedback_key: first.key, summary: "Stale answer" })).status, 409);
    await s.message({ type: "release", lease_id: stale });
    assert.notEqual((await s.snapshot()).workflows[0].feedback.key, first.key);
    for (const body of [request.body, "<!-- oriel:response:Zm9yZ2Vk:Zm9yZ2Vk -->\nCheck the upper bound.", "Review bot: cover the null case."]) {
      if (body !== request.body) {
        s.fixture.feedback(pr.number, body);
        if (body.startsWith("Review bot")) s.fixture.comments.get(pr.number).at(-1).user = { type: "Bot", login: "reviewer[bot]" };
      }
      const feedback = (await s.snapshot()).workflows[0].feedback; assert.equal(feedback.body, body);
      const lease = await s.claim("respond");
      assert.equal((await s.action(lease, "responded", { head_oid: head, verified: true, feedback_key: feedback.key, summary: "Answered and verified" })).status, 200);
      await s.message({ type: "release", lease_id: lease });
      assert.equal((await s.snapshot()).workflows[0].feedback, null, "Signed Oriel replies and handled content cannot wake another turn");
    }
    s.fixture.feedback(pr.number, " \n ");
    assert.equal((await s.snapshot()).workflows[0].feedback, null);
  } finally { await s.close(); }
});

test("submitted PR reviews and inline replies resume while pending reviews and empty approvals do not", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    s.fixture.addHow(); const row = (await s.snapshot()).workflows[0]; const implementation = await s.claim("implement");
    assert.equal((await s.action(implementation, "begin")).status, 200);
    const head = "2".repeat(40); s.fixture.refs.set(row.branch, head);
    const published = await s.action(implementation, "publish", { head_oid: head, verified: true, summary: "Verified source" }); assert.equal(published.status, 200);
    await s.message({ type: "release", lease_id: implementation });
    const pr = published.data.pull_request;
    let release, timer;
    const pending = new Promise(resolve => { release = resolve; });
    s.fixture.holdReads = async ({operation}) => {
      if(operation === "reviews") await pending;
      if(operation === "review-comments") release();
    };
    try {
      await Promise.race([s.snapshot(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("PR review reads were serialized")),3000);})]);
    } finally {clearTimeout(timer);release();s.fixture.holdReads=undefined;}
    const reviews = [
      { id: 0, state: "CHANGES_REQUESTED", body: "Superseded request", submitted_at: "2025-12-31T23:59:59Z", user: { login: "reviewer" } },
      { id: 1, state: "COMMENTED", body: "Please explain this boundary.", submitted_at: "2026-01-01T00:00:00Z", user: { login: "reviewer" } },
      { id: 2, state: "APPROVED", body: null, submitted_at: "2026-01-01T00:00:01Z", user: { login: "reviewer" } },
      { id: 3, state: "PENDING", body: "Unsubmitted request", submitted_at: null, user: { login: "reviewer" } },
      { id: 4, state: "DISMISSED", body: "Withdrawn request", submitted_at: "2026-01-01T00:00:02Z", user: { login: "other" } },
    ];
    s.fixture.reviews.set(pr.number, reviews);
    s.fixture.reviewComments.set(pr.number, [{ id: 1, pull_request_review_id: 3, path: "src/change.rs", line: 8, body: "Not submitted", commit_id: head }]);
    const respond = async expected => {
      const feedback = (await s.snapshot()).workflows[0].feedback; assert.equal(feedback.kind, "review"); expected(feedback);
      const lease = await s.claim("respond");
      assert.equal((await s.action(lease, "responded", { head_oid: head, verified: true, feedback_key: feedback.key, summary: "Addressed review" })).status, 200);
      await s.message({ type: "release", lease_id: lease });
      assert.equal((await s.snapshot()).workflows[0].feedback, null);
      return feedback.key;
    };
    await respond(feedback => assert.equal(feedback.body, "Please explain this boundary."));
    reviews.push({ id: 5, state: "COMMENTED", body: null, submitted_at: "2026-01-01T00:00:03Z", user: { login: "reviewer[bot]" } });
    const notes = s.fixture.reviewComments.get(pr.number);
    notes.push({ id: 2, pull_request_review_id: 5, path: "src/change.rs", line: null, original_line: 7, body: "Handle overflow here", commit_id: "1".repeat(40) });
    const first = await respond(feedback => { assert.equal(feedback.body, ""); assert.deepEqual(feedback.comments, [{ path: "src/change.rs", line: 7, body: "Handle overflow here" }]); });
    notes.push({ id: 3, pull_request_review_id: 5, in_reply_to_id: 2, path: "src/change.rs", line: 7, body: "Also check negative values", commit_id: head });
    await respond(feedback => { assert.notEqual(feedback.key, first); assert.equal(feedback.comments[1].body, "Also check negative values"); });
    notes[1].line = 7; notes.reverse();
    assert.equal((await s.snapshot()).workflows[0].feedback, null, "Line mapping and provider ordering changes are not new feedback");
    reviews.push({ id: 6, state: "APPROVED", body: "Consider adding an example.", submitted_at: "2026-01-01T00:00:04Z", user: { login: "reviewer" } });
    await respond(feedback => assert.equal(feedback.body, "Consider adding an example."));
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
      s.fixture.checks.push({ app: { id: 101 }, id: attempt, name: "required-test", head_sha: head, status: "completed", conclusion: "failure", completed_at: `2026-01-01T00:00:0${attempt}.000Z`, output: { title: "Failure", summary: "Fix actual behavior", text: null } });
      const feedback = (await s.snapshot()).workflows[0].feedback; assert.equal(feedback.kind, "check_failure");
      const lease = await s.claim("respond");
      const response = await s.action(lease, "responded", { head_oid: head, verified: true, feedback_key: feedback.key, summary: `Verified attempt ${attempt}` });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      await s.message({ type: "release", lease_id: lease });
    }
    s.fixture.checks.push({ app: { id: 101 }, id: 4, name: "required-test", head_sha: head, status: "completed", conclusion: "failure", completed_at: "2026-01-01T00:00:04.000Z", output: { title: "Failure", summary: "Still failing", text: null } });
    const exhausted = (await s.snapshot()).workflows[0]; assert.equal(exhausted.feedback, null); assert.match(exhausted.blocked_reason, /3 verified attempts/);
    const rejected = await s.message({ type: "claim", kind: "respond", issue_number: 42, version: exhausted.version, branch: exhausted.branch }); assert.equal(rejected.type, "rejected");
    s.fixture.checks.push({ app: { id: 101 }, id: 5, name: "required-test", head_sha: head, status: "completed", conclusion: "success", completed_at: "2099-01-01T00:00:00.000Z", output: { title: null, summary: null, text: null } });
    s.fixture.checks.push({ app: { id: 101 }, id: 6, name: "required-test", head_sha: head, status: "completed", conclusion: "failure", completed_at: "2099-01-01T00:00:01.000Z", output: { title: "New regression", summary: "Fresh failure after success", text: null } });
    assert.equal((await s.snapshot()).workflows[0].feedback.kind, "check_failure", "Actual success resets the externally reconstructed retry streak");
  } finally { await s.close(); }
});

test("same-name checks keep App identity through display, reruns and signed history recovery", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    s.fixture.addHow(); const row = (await s.snapshot()).workflows[0]; const lease = await s.claim("implement");
    assert.equal((await s.action(lease, "begin")).status, 200);
    const head = "2".repeat(40); s.fixture.refs.set(row.branch, head);
    const published = await s.action(lease, "publish", { head_oid: head, verified: true, summary: "Verified" });
    assert.equal(published.status, 200); await s.message({ type: "release", lease_id: lease });
    const empty = (await s.snapshot()).workflows[0];
    assert.equal(empty.phase,"review");
    assert.equal(empty.ci.acquisition,"received");
    assert.equal(empty.ci.head_oid,head);
    assert.deepEqual(empty.ci.checks,[]);
    assert.ok(Date.parse(empty.ci.fetched_at));
    const failure = s.fixture.addCheck();
    const other = s.fixture.addCheck({ app: { id: 202 }, id: 2, conclusion: "success" });
    const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const expected = `check:${hash(JSON.stringify(["check-run", 101, "test"]))}:1:${head}`;
    for (const checks of [[failure, other], [other, failure]]) {
      s.fixture.checks = checks;
      const current = (await s.snapshot()).workflows[0];
      assert.equal(current.ci.status, "failure"); assert.equal(current.ci.checks.length, 2);
      assert.equal(current.feedback.key, expected);
    }
    const rerun = s.fixture.addCheck({ id: 3, conclusion: "success" });
    assert.equal((await s.snapshot()).workflows[0].feedback, null);
    rerun.status = "in_progress"; rerun.conclusion = null;
    assert.equal((await s.snapshot()).workflows[0].feedback, null);
    assert.equal((await s.snapshot()).workflows[0].ci.status, "pending");
    rerun.head_sha = "9".repeat(40);
    assert.equal((await s.snapshot()).workflows[0].feedback.key, expected);

    // Legacy signed keys carry no App ID. Recover them from runs on past response heads.
    const oldHead = "8".repeat(40);
    const comments = s.fixture.comments.get(published.data.pull_request.number) ?? [];
    const marker = (kind, key) => {
      const signature = createHmac("sha256", Buffer.from(s.fixture.env.INTEGRATION_ENCRYPTION_KEY, "hex"))
        .update(JSON.stringify(["oriel/workflow-cursor/v1", 501, "team", kind, key])).digest("base64url");
      return `<!-- oriel:${kind}:${Buffer.from(key).toString("base64url")}:${signature} -->`;
    };
    for (let id = 10; id < 13; id++) {
      s.fixture.addCheck({ id, head_sha: oldHead });
      const key = `check:${hash("test")}:${id}:${oldHead}`;
      comments.push({ id: 100 + id, user: { login: "oriel", type: "Bot" }, created_at: "2026-02-01T00:00:00Z",
        body: marker("response", key) + marker("response-head", `${key}:${oldHead}`) });
    }
    s.fixture.comments.set(published.data.pull_request.number, comments);
    assert.equal((await s.snapshot()).workflows[0].feedback, null, "Other App success cannot reset App 101 attempts");
    other.conclusion = "failure";
    assert.equal((await s.snapshot()).workflows[0].feedback.key.split(":")[2], "2", "App 101 exhaustion cannot block App 202");
    s.fixture.statuses.push({ id: 1, context: "test", state: "failure", description: "Status failure", created_at: "2026-02-02T00:00:00Z" });
    other.conclusion = "success";
    assert.match((await s.snapshot()).workflows[0].feedback.key, /:status-1:/, "Commit Status attempts are separate");
    s.fixture.statuses = [];
    s.fixture.addCheck({ id: 20, conclusion: "neutral", completed_at: "2099-01-01T00:00:00Z" });
    s.fixture.addCheck({ id: 21 });
    assert.equal((await s.snapshot()).workflows[0].feedback.key.split(":")[2], "21", "Own successful history resets attempts");
    s.fixture.checks.find(check => check.id === 10).app = null;
    const unresolved = (await s.snapshot()).workflows[0];
    assert.equal(unresolved.feedback, null); assert.match(unresolved.blocked_reason, /history origin unavailable/);
    comments.length = 0;
    s.fixture.checks = [s.fixture.addCheck({ id: 30, app: null })];
    const missing = (await s.snapshot()).workflows[0];
    assert.equal(missing.ci.status, "failure"); assert.equal(missing.feedback, null); assert.match(missing.blocked_reason, /App ID unavailable/);
  } finally { await s.close(); }
});

test("failed PR Actions resume with current job steps, annotations and a bounded log without leaking credentials", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    s.fixture.addHow(); const row = (await s.snapshot()).workflows[0]; const implementation = await s.claim("implement");
    assert.equal((await s.action(implementation, "ci-feedback")).status, 403);
    assert.equal((await s.action(implementation, "begin")).status, 200);
    const head = "2".repeat(40); s.fixture.refs.set(row.branch, head);
    const published = await s.action(implementation, "publish", { head_oid: head, verified: true, summary: "Verified source" });
    assert.equal(published.status, 200); await s.message({type:"release",lease_id:implementation});
    s.fixture.checks.push({app: { id: 101 }, id: 10, name:"test", head_sha:head, status:"completed", conclusion:"failure", completed_at:"2026-01-01T00:00:00Z",
      details_url:"https://github.com/octocat/connected/actions/runs/20/job/30", output:{title:"Tests failed",summary:null,text:null}});
    s.fixture.addCheck({ app: { id: 202 }, id: 200, conclusion: "success", name: "test" });
    s.fixture.annotations.set(10, [{path:"src/lib.rs", start_line:7, annotation_level:"failure", message:"Expected true, got false", raw_details:"Assertion failed"}]);
    s.fixture.actionJobs.set(30, {id:30, run_id:20, head_sha:head, check_run_url:"https://api.github.com/repos/octocat/connected/check-runs/10", name:"cargo tests", status:"completed", conclusion:"failure",
      steps:[{number:1,name:"Checkout",conclusion:"success"},{number:2,name:"cargo test --workspace",conclusion:"failure"}]});
    s.fixture.jobLogs.set(30, "earlier output\n".repeat(10000)+"\u001b[31merror: test_boundary failed\u001b[0m\n");
    const failure = (await s.snapshot()).workflows[0].feedback;
    assert.equal(failure.kind,"check_failure");
    assert.equal(s.fixture.calls.filter(call=>call.operation==="job-logs").length,0,"Polling must not repeatedly download diagnostics");
    const lease = await s.claim("respond");
    const diagnostics = await s.action(lease,"ci-feedback");
    assert.equal(diagnostics.status,200,JSON.stringify(diagnostics.data));
    assert.equal(diagnostics.data.key,failure.key);
    assert.match(diagnostics.data.body,/Step 2: cargo test --workspace \(failure\)/);
    assert.match(diagnostics.data.body,/error: test_boundary failed/);
    assert.ok(diagnostics.data.body.length<=80000);
    assert.ok(!diagnostics.data.body.includes("\u001b"));
    assert.ok(!JSON.stringify(diagnostics.data).includes("private-storage-signature"));
    assert.deepEqual(diagnostics.data.comments,[{path:"src/lib.rs",line:7,body:"Expected true, got false\nAssertion failed"}]);
    assert.deepEqual(s.fixture.grants.at(-1),{metadata:"read",actions:"read"});
    s.fixture.checks[0].output.summary="long summary ".repeat(1500);
    const longSummary=await s.action(lease,"ci-feedback");
    assert.equal(longSummary.status,200); assert.ok(longSummary.data.body.length<=80000);
    assert.match(longSummary.data.body,/error: test_boundary failed/,"Summary truncation must preserve the final failure log");
    s.fixture.checks[0].output.summary=null;
    s.fixture.installationPermissions.actions=undefined;
    const fallback = await s.action(lease,"ci-feedback");
    assert.equal(fallback.status,200); assert.match(fallback.data.body,/Actions: read/); assert.equal(fallback.data.comments.length,1);
    assert.ok(!JSON.stringify(fallback.data).includes("private-provider-diagnostic"));
    s.fixture.installationPermissions.actions="read";
    s.fixture.logStorage="https://attacker.example";
    const rejectedUrl = await s.action(lease,"ci-feedback");
    assert.equal(rejectedUrl.status,200); assert.match(rejectedUrl.data.body,/logs are unavailable/);
    s.fixture.logStorage="https://pipelines.actions.githubusercontent.com";
    s.fixture.actionJobs.get(30).head_sha="9".repeat(40);
    assert.equal((await s.action(lease,"ci-feedback")).status,409,"Logs from a different commit cannot be repair input");
    s.fixture.actionJobs.get(30).head_sha=head;
    let raced=false;
    s.fixture.holdReads=({operation})=>{if(operation==="job-log-download"&&!raced){raced=true;s.fixture.checks.push({...s.fixture.checks[0],id:11,conclusion:"success"});}};
    assert.equal((await s.action(lease,"ci-feedback")).status,409,"Successful rerun during log download revokes the failure input");
    s.fixture.holdReads=undefined;
    assert.equal((await s.snapshot()).workflows[0].feedback,null);
    // A failed check on an older commit never starts a response for the current head.
    s.fixture.checks.push({...s.fixture.checks[0],id:12,head_sha:"8".repeat(40)});
    assert.equal((await s.snapshot()).workflows[0].feedback,null);
  } finally {await s.close();}
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

test("approved verified documentation, renames and deletions can publish without source padding", async () => {
  for (const file of [
    {filename: "README.md", status: "modified"},
    {filename: "docs/setup.md", status: "added"},
    {filename: "guide.md", previous_filename: "main.rs", status: "renamed"},
    {filename: "old.md", status: "removed"},
  ]) {
    const s = await setup();
    try {
      s.fixture.addHow(); const row = (await s.snapshot()).workflows[0]; const lease = await s.claim("implement");
      assert.equal((await s.action(lease, "begin")).status, 200);
      const head = "2".repeat(40); s.fixture.refs.set(row.branch, head);
      s.fixture.compare = {status: "ahead", total_commits: 1, files: [file]};
      assert.equal((await s.action(lease, "publish", {head_oid: head, verified: false, summary: "Unverified"})).status, 400);
      const published = await s.action(lease, "publish", {head_oid: head, verified: true, summary: "Verified documentation"});
      assert.equal(published.status, 200, JSON.stringify(published.data));
    } finally {await s.close();}
  }
});

test("change proof traverses native trees when GitHub truncates a policy-only comparison", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    s.fixture.addHow(); const row = (await s.snapshot()).workflows[0]; const lease = await s.claim("implement");
    assert.equal((await s.action(lease, "begin")).status, 200);
    const head = "2".repeat(40); s.fixture.refs.set(row.branch, head);
    s.fixture.compare = { status: "ahead", total_commits: 1, files: Array.from({ length: 300 }, (_, index) => ({ filename: `.codex/${index}.toml`, status: "added" })) };
    s.fixture.trees.set(s.fixture.target_oid, { tree: [], truncated: false });
    s.fixture.trees.set(head, { tree: [{ path: "docs", type: "tree", sha: "d".repeat(40) }], truncated: false });
    s.fixture.trees.set("d".repeat(40), { tree: [{ path: "AGENTS.md", type: "blob", sha: "e".repeat(40) }], truncated: false });
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
    s.fixture.comments.set(42, []); // Exercise HOW feedback without a pending Issue command.
    const how = s.fixture.addHow("Triage");
    const lease = await s.claim("plan");
    let reads = 0;
    s.fixture.holdReads = ({ operation }) => {
      if (operation === "states" && ++reads === 2) how.description = "Human-authored HOW must survive.";
    };
    const result = await s.action(lease, "proposal", { title: "Agent proposal", description: "Agent-authored HOW", summary: "Updated the proposed scope." });
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
    assert.equal(how.comments.length, 0, "Do not announce a return after human completion");
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
    assert.equal((await s.action(lease, "proposal", { title: "HOW", description: "Plan", summary: "Prepared the HOW for review." })).status, 409);
    request.body = "/oriel how";
    assert.equal((await row()).version, ready.version);
    s.fixture.comments.set(42, []);
    assert.equal((await row()).phase, "waiting-how");
    assert.equal((await s.action(lease, "proposal", { title: "HOW", description: "Plan", summary: "Prepared the HOW for review." })).status, 409);
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
    const draft = { title: "HOW", description: "Resolve open WHAT questions before Todo.", summary: "Prepared the HOW with open questions for human review." };
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
    const result = await s.action(lease, "proposal", { title: "HOW", description: "Plan for review.", summary: "Prepared the HOW for review." });
    assert.equal(result.status, 409);
    assert.deepEqual(s.fixture.linears, []);
  } finally { await s.close(); }
});

test("Leased discovery reads only the current WHAT while still checking approval and ambiguous links", async () => {
  const s = await setup(true);
  try {
    const namespace = await s.worker.getDurableObjectNamespace("ACCOUNTS");
    const costs = () => namespace.get(namespace.idFromName("accounts")).costForTest();
    s.fixture.addHow("Todo");
    for (let number = 43; number < 90; number++) s.fixture.issues.push({...s.fixture.issues[0], number, node_id:`I_${number}`, html_url:`https://github.com/octocat/connected/issues/${number}`});
    s.fixture.calls.length = 0;
    const beforeFull = await costs();
    const full = await s.snapshot();
    const afterFull = await costs();
    const fullComments = s.fixture.calls.filter(call => call.operation === "pr-comments").length;
    assert.equal(full.workflows.length, 48);
    const beforeIdle = await costs();
    const idle = await s.message({ type: "snapshot", changes: true });
    const afterIdle = await costs();
    assert.equal(idle.snapshot.workflows.length, 48);
    const lease_id = await s.claim("implement");
    s.fixture.calls.length = 0;
    const beforeScoped = await costs();
    const current = await s.message({type:"snapshot", lease_id});
    const afterScoped = await costs();
    const fullReads = afterFull.reads - beforeFull.reads, scopedReads = afterScoped.reads - beforeScoped.reads;
    assert.equal(fullReads, 0);
    assert.equal(scopedReads, 0);
    const idleReads = afterIdle.reads - beforeIdle.reads;
    assert.equal(idleReads, 0);
    console.log("SQLite rowsRead for 48 WHATs:", JSON.stringify({fullReads, idleReads, scopedReads}));
    assert.equal(current.type, "snapshot", JSON.stringify(current));
    assert.deepEqual(current.snapshot.workflows.map(row => row.issue.number), [42]);
    assert.equal(current.snapshot.workflows[0].phase, "approved");
    const scopedComments = s.fixture.calls.filter(call => call.operation === "pr-comments").length;
    assert.equal(scopedComments, 1);
    assert.equal(fullComments, 3,"Full comments are read in batches of twenty, without omitting issues");
    assert.equal(s.fixture.calls.some(call => call.operation === "whats"), false);
    s.fixture.linears[0].state = {...s.fixture.states.find(state => state.name === "Triage")};
    assert.equal((await s.message({type:"snapshot", lease_id})).snapshot.workflows[0].phase, "triage");
    s.fixture.addHow("Todo").id = "22222222-2222-4222-a222-222222222222";
    const duplicate = (await s.message({type:"snapshot", lease_id})).snapshot.workflows[0];
    assert.equal(duplicate.phase, "blocked");
    assert.match(duplicate.blocked_reason, /Multiple Linear/);
    s.fixture.issues = s.fixture.issues.filter(issue => issue.number !== 42);
    assert.deepEqual((await s.message({type:"snapshot", lease_id})).snapshot.workflows, []);
  } finally { await s.close(); }
});

test("JSON limits protect authenticated creation while preserving Japanese field boundaries", { timeout: 60000 }, async () => {
  const s = await setup();
  try {
    const path = `/api/workflows/${device}/issues`;
    const create = (title, body, extra = {}) => s.owner.api(path, { title, body, request_id: randomUUID(), ...extra });
    assert.equal((await create("日".repeat(256), "日".repeat(60000))).status, 200);
    assert.equal((await create("日".repeat(257), "ok")).status, 400);
    assert.equal((await create("ok", "日".repeat(60001))).status, 400);
    assert.equal((await s.daemon.api("/api/pair/start", { device_id: device, name: "日".repeat(255) }, hostHeaders)).status, 200);
    assert.equal((await s.daemon.api("/api/pair/start", { device_id: device, name: "日".repeat(256) }, hostHeaders)).status, 400);
    assert.equal((await client(s.worker).api(path, { padding: "x".repeat(65537) })).status, 401);
    const before = s.fixture.issues.length;
    const body = { title: "上限", body: "日".repeat(60000), request_id: randomUUID(), padding: "" };
    body.padding = "日".repeat(65536 - JSON.stringify(body).length);
    assert.equal(JSON.stringify(body).length, 65536);
    assert.equal((await s.owner.api(path, body)).status, 200);
    assert.equal(s.fixture.issues.length, before + 1);
    const creations = s.fixture.calls.filter(call => call.operation === "what-create").length;
    body.request_id = randomUUID();
    body.padding += "日";
    const rejected = await s.owner.api(path, body);
    assert.equal(rejected.status, 413);
    assert.deepEqual(rejected.data, { error: "Request is too large" });
    assert.equal(s.fixture.calls.filter(call => call.operation === "what-create").length, creations);
    assert.equal(s.fixture.issues.length, before + 1);

    // Selection needs a pending OAuth authorization, not the active connection
    // already selected by setup. An oversized request must leave it usable.
    const state = await authorize(s.owner, s.fixture, "linear");
    assert.equal((await s.owner.callback("linear", state)).headers.get("Location"), `${origin}/#connected=linear`);
    for (const [client, route, valid, headers] of [
      [s.owner, "/api/auth/login/options", {}, {}],
      [s.daemon, "/api/pair/start", { device_id: device, name: "日" }, hostHeaders],
      [s.owner, "/api/integrations/linear/select", { team_id: "team" }, {}],
    ]) {
      const response = await client.api(route, { ...valid, padding: "日".repeat(65536) }, headers);
      assert.equal(response.status, 413, route);
      assert.deepEqual(response.data, { error: "Request is too large" });
      assert.equal((await client.api(route, valid, headers)).status, 200, route);
    }
  } finally { await s.close(); }
});

test("attachment capacity blocks execution before start and recovers without changing approval", { timeout: 120000 }, async () => {
  const s = await setup();
  try {
    s.fixture.addHow("Todo");
    const before = (await s.snapshot()).workflows[0];
    s.fixture.verification = [["printf", "x".repeat(20000)]];
    const stale = await s.message({ type: "claim", kind: "implement", issue_number: before.issue.number, version: before.version, branch: before.branch });
    assert.equal(stale.type, "rejected");
    for (const commands of [ [["printf", "x".repeat(20000)]], [["文😀".repeat(4000)]], [["\"\n".repeat(6000)]], Array.from({ length: 1024 }, () => ["x"]) ]) {
      s.fixture.verification = commands;
      const snapshot = await s.snapshot();
      assert.equal(snapshot.configuration.autonomous, true);
      assert.deepEqual(snapshot.configuration.verification, commands);
      const row = snapshot.workflows[0];
      assert.equal(row.phase, "blocked");
      assert.equal(row.linear.state.name, "Todo");
      assert.match(row.blocked_reason, /execution.verification.*available .*used .*16384/);
      const denied = await s.message({ type: "claim", kind: "implement", issue_number: row.issue.number, version: row.version, branch: row.branch });
      assert.equal(denied.type, "rejected");
      assert.match(denied.error, /execution.verification capacity exceeded/);
    }
    s.fixture.verification = [["true"]];
    assert.equal((await s.snapshot()).workflows[0].phase, "approved");
    const title = s.fixture.issues[0].title;
    s.fixture.issues[0].title = "文".repeat(20000);
    const oversizedTask = (await s.snapshot()).workflows[0];
    assert.equal(oversizedTask.phase, "blocked");
    assert.match(oversizedTask.blocked_reason, /task\/binding metadata/);
    s.fixture.issues[0].title = title;
    const lease_id = await s.claim("implement");
    assert.equal((await s.message({ type: "release", lease_id })).type, "released");
  } finally { await s.close(); }
});
