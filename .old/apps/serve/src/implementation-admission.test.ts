import { expect, test } from "bun:test";

import {
  approvalFingerprint,
  canonicalBranchName,
} from "./approval-fingerprint";
import {
  readImplementationApproval,
  sealCanonicalBranch,
  workflowIsFenced,
  type ImplementationApprovalPorts,
  type SealOutcome,
} from "./implementation-admission";

const repositoryId = 11;
const repositoryNodeId = "R_kgDOABCDEF";
const issueNodeId = "I_kwDOABCDEF";
const linearIssueId = "0f6f6a0c-1c1e-4a0a-9f6e-2f5f1f3f4f5f";
const baseOid = "1111111111111111111111111111111111111111";
const fingerprint = approvalFingerprint({
  repositoryId: repositoryNodeId,
  githubIssueNodeId: issueNodeId,
  githubTitle: "WHAT title",
  githubBody: "WHAT body",
  linearIssueUuid: linearIssueId,
  linearTitle: "HOW title",
  linearDescription: "HOW description",
});
const canonicalBranch = canonicalBranchName({
  linearIdentifier: "ENG-12",
  githubIssueNumber: 28,
  approvalFingerprint: fingerprint,
});

interface FakeState {
  linear: {
    issueId: string;
    identifier: string;
    title: string;
    description: string | null;
    stateName: string;
    attachmentUrls: string[];
  } | null;
  issues: Record<
    string,
    {
      issueNumber: number;
      issueNodeId: string;
      repositoryNodeId: string;
      title: string;
      body: string | null;
      state: string;
    }
  >;
  base: { ref: string; oid: string } | null;
  refs: Record<string, string>;
  unknownRefs: string[];
  /** 曖昧な応答の後だけrefを読めなくする。 */
  unknownRefsAfterSeal: string[];
  /** `updateRefs`が実際に書いたOID。結果不明でも書けている場合を作る。 */
  sealWritesOid: string | null;
  pullRequestHeadRefs: string[] | null;
  refFormatOk: boolean;
  seal: SealOutcome;
}

function fakeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    linear: {
      issueId: linearIssueId,
      identifier: "ENG-12",
      title: "HOW title",
      description: "HOW description",
      stateName: "Todo",
      attachmentUrls: [
        "https://github.com/mikan-919/oriel/issues/28",
        "https://linear.app/team/issue/ENG-12",
      ],
    },
    issues: {
      "https://github.com/mikan-919/oriel/issues/28": {
        issueNumber: 28,
        issueNodeId,
        repositoryNodeId,
        title: "WHAT title",
        body: "WHAT body",
        state: "open",
      },
    },
    base: { ref: "refs/heads/main", oid: baseOid },
    refs: {},
    unknownRefs: [],
    unknownRefsAfterSeal: [],
    sealWritesOid: null,
    pullRequestHeadRefs: [],
    refFormatOk: true,
    seal: "sealed",
    ...overrides,
  };
}

function fakePorts(state: FakeState): ImplementationApprovalPorts & {
  calls: string[];
} {
  const calls: string[] = [];
  let sealAttempted = false;

  return {
    calls,
    readTargetBaseFile: async () => ({ status: "unknown" as const }),
    readLinearIssue: async (id) =>
      state.linear?.issueId === id ? state.linear : null,
    resolveGitHubIssueByAttachmentUrl: async (url) => state.issues[url] ?? null,
    readTargetBase: async () => state.base,
    readRef: async (ref) =>
      state.unknownRefs.includes(ref) ||
      (sealAttempted && state.unknownRefsAfterSeal.includes(ref))
        ? { status: "unknown" }
        : ref in state.refs
          ? { status: "present", oid: state.refs[ref]! }
          : { status: "absent" },
    listOpenPullRequestHeadRefs: async () => state.pullRequestHeadRefs,
    checkRefFormat: async () => state.refFormatOk,
    updateRefsAtomically: async ({ canonicalRef, expectedBaseOid }) => {
      calls.push(`updateRefs:${canonicalRef}`);
      sealAttempted = true;

      const written =
        state.seal === "sealed" ? expectedBaseOid : state.sealWritesOid;

      if (written !== null) {
        state.refs[canonicalRef] = written;
      }

      return state.seal;
    },
  };
}

function read(state: FakeState) {
  return readImplementationApproval(fakePorts(state), {
    repositoryId,
    linearIssueId,
  });
}

test("the current Todo approval derives the fingerprint, canonical branch, and Job key", async () => {
  const admitted = await read(fakeState());

  expect(admitted).toEqual({
    status: "read",
    // 承認済みWHAT/HOWはworkerへ渡すためだけの現在値であり、指紋の入力には
    // なるが識別子やbranch名へは入らない。
    content: {
      whatTitle: "WHAT title",
      whatBody: "WHAT body",
      howTitle: "HOW title",
      howDescription: "HOW description",
    },
    approval: {
      jobId: `implementation:${repositoryId}:28:${fingerprint}`,
      approvalFingerprint: fingerprint,
      canonicalBranch,
      canonicalRef: `refs/heads/${canonicalBranch}`,
      targetBaseRef: "refs/heads/main",
      targetBaseOid: baseOid,
      githubIssueNumber: 28,
      githubIssueNodeId: issueNodeId,
      githubRepositoryNodeId: repositoryNodeId,
      linearIssueId,
      linearIdentifier: "ENG-12",
    },
  });
});

test("an approval that is not current Todo, unique, and open is refused", async () => {
  expect(await read(fakeState({ linear: null }))).toEqual({
    status: "refused",
    reason: "linear_issue_not_found",
  });

  const triaged = fakeState();
  triaged.linear!.stateName = "Triage";

  expect(await read(triaged)).toEqual({
    status: "refused",
    reason: "linear_state_not_todo",
  });

  const inProgress = fakeState();
  inProgress.linear!.stateName = "In Progress";

  expect(await read(inProgress)).toEqual({
    status: "refused",
    reason: "linear_state_not_todo",
  });

  const closed = fakeState();
  closed.issues["https://github.com/mikan-919/oriel/issues/28"]!.state =
    "closed";

  expect(await read(closed)).toEqual({
    status: "refused",
    reason: "github_issue_not_open",
  });
});

test("the GitHub Issue must come from exactly one attachment reverse lookup", async () => {
  const none = fakeState();
  none.linear!.attachmentUrls = ["https://linear.app/team/issue/ENG-12"];

  expect(await read(none)).toEqual({
    status: "refused",
    reason: "github_issue_not_uniquely_attached",
  });

  const ambiguous = fakeState();
  ambiguous.linear!.attachmentUrls.push(
    "https://github.com/mikan-919/oriel/issues/29",
  );
  ambiguous.issues["https://github.com/mikan-919/oriel/issues/29"] = {
    issueNumber: 29,
    issueNodeId: "I_other",
    repositoryNodeId,
    title: "another WHAT",
    body: "",
    state: "open",
  };

  expect(await read(ambiguous)).toEqual({
    status: "refused",
    reason: "github_issue_not_uniquely_attached",
  });

  // 同じIssueへの重複attachmentは一意な逆引きを壊さない。
  const duplicated = fakeState();
  duplicated.linear!.attachmentUrls.push(
    "https://github.com/mikan-919/oriel/issues/28",
  );

  expect((await read(duplicated)).status).toBe("read");
});

test("an input the product cannot encode exactly fails closed", async () => {
  const unencodable = fakeState();
  unencodable.issues["https://github.com/mikan-919/oriel/issues/28"]!.title =
    "";

  expect(await read(unencodable)).toEqual({
    status: "refused",
    reason: "approval_fingerprint_unavailable",
  });

  const identifier = fakeState();
  identifier.linear!.identifier = "ENG 12";

  expect(await read(identifier)).toEqual({
    status: "refused",
    reason: "canonical_branch_unavailable",
  });

  // Git実装のcheck-ref-formatを通らない名前は使わない。
  expect(await read(fakeState({ refFormatOk: false }))).toEqual({
    status: "refused",
    reason: "canonical_branch_unavailable",
  });

  expect(await read(fakeState({ base: null }))).toEqual({
    status: "refused",
    reason: "target_base_unavailable",
  });
});

test("an open pull request for the same Workflow stops a new implementation Job", async () => {
  expect(
    await read(
      fakeState({
        pullRequestHeadRefs: [`oriel/ENG-12-gh-28-${"0".repeat(64)}`],
      }),
    ),
  ).toEqual({ status: "refused", reason: "workflow_pull_request_open" });

  expect(await read(fakeState({ pullRequestHeadRefs: null }))).toEqual({
    status: "refused",
    reason: "pull_request_state_unknown",
  });

  // routing部分のidentifierが変わっていても、同じWorkflowなら止める。
  expect(
    await read(
      fakeState({
        pullRequestHeadRefs: [`oriel/ENG-9-gh-28-${"0".repeat(64)}`],
      }),
    ),
  ).toEqual({ status: "refused", reason: "workflow_pull_request_open" });

  // 別のWorkflowのプルリクエストは妨げない。
  expect(
    (
      await read(
        fakeState({ pullRequestHeadRefs: ["oriel/ENG-13-gh-29-something"] }),
      )
    ).status,
  ).toBe("read");
});

test("the Workflow-wide fence only admits the current approval fingerprint", async () => {
  const admitted = await read(fakeState());

  if (admitted.status !== "read") {
    throw new Error("the approval was refused");
  }

  const approval = admitted.approval;
  const otherFingerprint = "0".repeat(64);
  const fenced = (
    live: { jobKeys: string[]; branchKeys: string[] } | null,
  ): boolean => workflowIsFenced(live, approval, repositoryId);

  expect(fenced({ jobKeys: [approval.jobId], branchKeys: [] })).toBe(true);
  expect(
    fenced({
      jobKeys: [],
      branchKeys: [`${repositoryId}/${approval.canonicalBranch}`],
    }),
  ).toBe(true);
  // 別Workflowの生きたJobとブランチは妨げない。
  expect(
    fenced({
      jobKeys: [`implementation:${repositoryId}:29:${otherFingerprint}`],
      branchKeys: [`${repositoryId}/oriel/ENG-13-gh-29-${otherFingerprint}`],
    }),
  ).toBe(true);

  // 同じWorkflowで、異なる承認指紋の生きた所有権があれば隔離できていない。
  expect(
    fenced({
      jobKeys: [`implementation:${repositoryId}:28:${otherFingerprint}`],
      branchKeys: [],
    }),
  ).toBe(false);
  expect(
    fenced({
      jobKeys: [],
      branchKeys: [`${repositoryId}/oriel/ENG-9-gh-28-${otherFingerprint}`],
    }),
  ).toBe(false);
  // 現在値を読めない場合はfail closedにする。
  expect(fenced(null)).toBe(false);

  // 隔離判定は`canonicalBranchName`が書いた名前をそのまま読めなければならない。
  // 接頭辞を直書きすると、識別子を変えたときにこの判定だけが全ブランチをfalseへ
  // 倒し、隔離済みとして通してしまう(fail open)ため、writerの出力で検証する。
  expect(
    fenced({
      jobKeys: [],
      branchKeys: [
        `${repositoryId}/${canonicalBranchName({
          linearIdentifier: "ENG-9",
          githubIssueNumber: 28,
          approvalFingerprint: otherFingerprint,
        })}`,
      ],
    }),
  ).toBe(false);
});

test("a canonical ref that cannot be read is neither created nor adopted", async () => {
  const state = fakeState();
  const ports = fakePorts(state);
  const admitted = await readImplementationApproval(ports, {
    repositoryId,
    linearIssueId,
  });

  if (admitted.status !== "read") {
    throw new Error("the approval was refused");
  }

  expect(
    await sealCanonicalBranch(ports, admitted.approval, { status: "unknown" }),
  ).toEqual({ status: "refused", reason: "canonical_branch_state_unknown" });
  expect(ports.calls).toEqual([]);
});

async function seal(state: FakeState) {
  const ports = fakePorts(state);
  const admitted = await readImplementationApproval(ports, {
    repositoryId,
    linearIssueId,
  });

  if (admitted.status !== "read") {
    throw new Error(`the approval was refused: ${admitted.reason}`);
  }

  return {
    outcome: await sealCanonicalBranch(
      ports,
      admitted.approval,
      await ports.readRef(admitted.approval.canonicalRef),
    ),
    calls: ports.calls,
    approval: admitted.approval,
  };
}

test("the canonical branch is created by one atomic updateRefs and read back", async () => {
  const state = fakeState();
  const sealed = await seal(state);

  expect(sealed.outcome).toEqual({ status: "sealed", canonicalOid: baseOid });
  expect(sealed.calls).toEqual([`updateRefs:refs/heads/${canonicalBranch}`]);
  expect(state.refs[`refs/heads/${canonicalBranch}`]).toBe(baseOid);
});

test("a seal that the API cannot do atomically never falls back to a weaker create", async () => {
  for (const [outcome, reason] of [
    ["unsupported", "branch_seal_unsupported"],
    ["rejected", "branch_seal_rejected"],
  ] as const) {
    const state = fakeState({ seal: outcome });
    const sealed = await seal(state);

    expect(sealed.outcome).toEqual({ status: "refused", reason });
    expect(state.refs).toEqual({});
    expect(sealed.calls).toHaveLength(1);
  }
});

test("an ambiguous seal is read back once and never resent", async () => {
  // 応答は曖昧だったが、実際には比較条件付き作成が通っていた場合。
  const converged = fakeState({ seal: "unknown", sealWritesOid: baseOid });
  const sealedAfterReadBack = await seal(converged);

  expect(sealedAfterReadBack.outcome).toEqual({
    status: "sealed",
    canonicalOid: baseOid,
  });
  expect(sealedAfterReadBack.calls).toHaveLength(1);

  // 送ったか分からないまま、refが無い・別のOID・読めない場合は進めない。
  expect((await seal(fakeState({ seal: "unknown" }))).outcome).toEqual({
    status: "refused",
    reason: "branch_seal_result_unknown",
  });

  const moved = fakeState({ seal: "unknown", sealWritesOid: "2".repeat(40) });

  expect((await seal(moved)).outcome).toEqual({
    status: "refused",
    reason: "branch_seal_result_unknown",
  });

  const unreadable = fakeState({ seal: "unknown" });
  unreadable.unknownRefsAfterSeal.push(`refs/heads/${canonicalBranch}`);

  expect((await seal(unreadable)).outcome).toEqual({
    status: "refused",
    reason: "branch_seal_result_unknown",
  });
});

test("an existing canonical ref of the same fingerprint is adopted, never overwritten", async () => {
  const existing = fakeState();
  existing.refs[`refs/heads/${canonicalBranch}`] = "3".repeat(40);

  const sealed = await seal(existing);

  // ADR 0004: 現在の先端を未検証の作業途中成果として引き継ぐ。
  expect(sealed.outcome).toEqual({
    status: "adopted",
    canonicalOid: "3".repeat(40),
  });
  // 比較条件付き作成すら送らない。
  expect(sealed.calls).toEqual([]);
  expect(existing.refs[`refs/heads/${canonicalBranch}`]).toBe("3".repeat(40));
});

test("the target base must still be at the OID the seal compares against", async () => {
  const moved = fakeState();
  const ports = fakePorts(moved);
  const admitted = await readImplementationApproval(ports, {
    repositoryId,
    linearIssueId,
  });

  if (admitted.status !== "read") {
    throw new Error("the approval was refused");
  }

  moved.base = { ref: "refs/heads/main", oid: "4".repeat(40) };

  expect(
    await sealCanonicalBranch(ports, admitted.approval, { status: "absent" }),
  ).toEqual({ status: "refused", reason: "approval_changed" });
  expect(ports.calls).toEqual([]);
});
