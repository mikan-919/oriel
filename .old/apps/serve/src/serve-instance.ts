import type { InstanceConfig } from "@mikan-919/oriel-contracts";

import {
  bunSecretsDeviceTokenStore,
  createDeviceRegistrationFlow,
} from "./device-registration";
import { createDiscoveryLoop } from "./discovery";
import {
  createGitHubApprovalPorts,
  createGitHubTargetBaseReader,
} from "./github-approval-ports";
import { createGitHubOpenIssuePort } from "./github-discovery-ports";
import {
  createGitHubPrResponsePorts,
  createGitHubPrResponseReconciliationPorts,
  createGitHubPrResponseReportPorts,
} from "./github-pr-response-ports";
import {
  createGitHubPullRequestMergeCheck,
  createGitHubPullRequestPorts,
} from "./github-pull-request-ports";
import { startHowConfirmationJob } from "./how-confirmation-job";
import { createHowTriggerLoop } from "./how-trigger-discovery";
import { createOctokitIssueCommentPublisher } from "./issue-comments";
import { startImplementationJob } from "./implementation-job";
import { createInstallationGitCredentialResolver } from "./installation-credential";
import { createInstallationOctokitResolver } from "./installation-octokit";
import { startIssueConversationJob } from "./issue-conversation-job";
import { holdIfStarted, type JobRegistry } from "./job-registry";
import {
  bunSecretsLinearToken,
  createLinearApprovalReader,
  createLinearApprovalStateWriter,
  createLinearDiscoveryReader,
} from "./linear-approval";
import { createLinearGraphqlCommentPublisher } from "./linear-comments";
import { createLinearGraphqlDescriptionPublisher } from "./linear-description";
import { createLinearTriageWriter } from "./linear-triage-writer";
import { openServeLocalState } from "./local-state";
import { conversationJobSatisfiesModelCapabilities } from "./model-capability-gate";
import {
  resolveModelDefault,
  type ModelDefaultsStore,
  type ModelSelection,
} from "./model-defaults";
import { createNotificationConnection } from "./notification-connection";
import { createPendingCancellationStore } from "./pending-cancellations";
import { createPrMergeDiscoveryLoop } from "./pr-merge-discovery";
import { createPrResponseCheckFailureStore } from "./pr-response-check-failures";
import { createPrResponseLoop } from "./pr-response-discovery";
import { startPrResponseJob } from "./pr-response-job";
import { createPullRequestWatchStore } from "./pull-request-watch";
import {
  bunSecretsModelCredential,
  createPiModelStreamProvider,
  createServeModels,
  resolveModelCapabilities,
} from "./pi-model-provider";
import {
  createRelayDeviceClient,
  type RelayDeviceClient,
} from "./relay-client";
import type { ServeInstanceBindings } from "./server";
import { createTranscriptSearch } from "./transcript-search";
import { createTranscriptStore } from "./transcript-store";
import { startWhatConfirmationJob } from "./what-confirmation-job";
import { createWhatTriggerLoop } from "./what-trigger-discovery";

/**
 * `serve`コマンドの起動ごとには依存せず、instance設定の再構成をまたいで
 * 生き続ける依存関係。Workflow/Job一覧、device token、statePath、運用値、
 * modelのbase/per-kind既定値はinstance設定(relay origin、repositoryなど)
 * の対象外であり、`reconfigure`のたびに作り直さない。
 */
export interface ServeInstanceShared {
  jobRegistry: JobRegistry;
  tokenStore: ReturnType<typeof bunSecretsDeviceTokenStore>;
  statePath: string;
  heartbeatStopMs: number;
  discoveryPollIntervalMs: number;
  modelDefaults: ModelDefaultsStore;
}

export interface ServeInstance {
  bindings: ServeInstanceBindings;
  /** discovery loopとnotification connectionを止める。再構成、終了の両方で使う。 */
  stop(): void;
}

/** Linear tokenを解決できた場合だけ、state反映の境界を作る。 */
async function linearStateWriter(repositoryId: number) {
  const token = await bunSecretsLinearToken(repositoryId).get();

  return token === null ? null : createLinearApprovalStateWriter({ token });
}

/**
 * relay origin、repositoryなどinstance設定に依存する配線一式を組み立てる。
 * 呼び出し元(cli.ts)は保存済み設定が変わるたびにこの関数を呼び直し、古い
 * instanceの`stop()`を呼んでから新しいinstanceへ差し替える。
 */
export function buildServeInstance(
  config: InstanceConfig,
  shared: ServeInstanceShared,
): ServeInstance {
  const {
    jobRegistry,
    tokenStore,
    statePath,
    heartbeatStopMs,
    discoveryPollIntervalMs,
    modelDefaults,
  } = shared;
  const environment = config.relayOrigin ?? undefined;
  const repositoryId = config.repositoryId ?? undefined;
  const repositoryOwner = config.repositoryOwner ?? undefined;
  const repositoryName = config.repositoryName ?? undefined;
  const linearTeamId = config.linearTeamId ?? undefined;
  const repositoryRoot = config.repositoryRoot ?? undefined;
  const worktreesRoot = config.worktreesRoot ?? undefined;
  const canonicalRemote = config.canonicalRemote ?? "origin";
  const lmStudioBaseUrl = config.lmStudioBaseUrl ?? undefined;

  const resolveJobModel = (
    kind:
      | "implementation"
      | "what_confirmation"
      | "how_confirmation"
      | "pr_response",
    override?: ModelSelection,
  ) => resolveModelDefault(modelDefaults, kind, override);
  const refuseWithoutModel = () =>
    Promise.resolve({
      status: "refused" as const,
      reason: "model_not_configured" as const,
    });
  const refuseCapabilityMismatch = () =>
    Promise.resolve({
      status: "refused" as const,
      reason: "model_capability_mismatch" as const,
    });
  const models = createServeModels({ lmStudioBaseUrl });
  /** ADR 0009のcapability gateが照合する、選択済みmodelのメタデータ。 */
  const getModelCapabilities = (model: ModelSelection) =>
    resolveModelCapabilities(models, model.provider, model.id);
  /**
   * `.oriel.yaml`のmodelCapabilities gate専用の、admission用途に絞ったOctokit。
   * 対話Job(what_confirmation/how_confirmation)はこれまでGitHub contentsへ
   * 触れていなかったが、ADR 0009の照合のためだけにこの読み取りだけを追加する。
   */
  const createRepositoryTargetBaseReader =
    (
      relay: RelayDeviceClient,
      targetRepositoryId: number,
      repository: { owner: string; name: string },
    ) =>
    async () => {
      const octokit = await createInstallationOctokitResolver({
        relay,
        tokenStore,
        repositoryId: targetRepositoryId,
        purpose: "admission",
      })();

      return octokit === null
        ? null
        : createGitHubTargetBaseReader({ octokit, repository });
    };
  const relayDeviceClient =
    environment === undefined
      ? undefined
      : createRelayDeviceClient({ baseUrl: environment });
  const conversationReady =
    relayDeviceClient !== undefined &&
    environment !== undefined &&
    repositoryId !== undefined &&
    repositoryOwner !== undefined &&
    repositoryName !== undefined;
  const implementationReady =
    conversationReady &&
    repositoryId !== undefined &&
    // worktreeを開けない構成では、実装Jobを始めない。
    repositoryRoot !== undefined &&
    worktreesRoot !== undefined;
  const modelStreamProvider = createPiModelStreamProvider({
    models,
    resolveApiKey: (provider) => bunSecretsModelCredential(provider).get(),
  });

  /**
   * 承認されたHOWのLinear Issueからserveが実装Jobを始める、唯一の入口。
   *
   * `/api/implementation-jobs`からの手動起動と、discoveryが発見した候補からの
   * 自動起動の両方がこの同じ関数を呼ぶ。承認、所有権、canonicalブランチ封印の
   * 判断はすべて`startImplementationJob`が現在値から一貫して行う。
   */
  const startImplementation = implementationReady
    ? ({
        linearIssueId,
        modelOverride,
      }: {
        linearIssueId: string;
        modelOverride?: ModelSelection;
      }) => {
        const model = resolveJobModel("implementation", modelOverride);

        if (model === null) {
          return refuseWithoutModel();
        }

        return startImplementationJob({
          relayOrigin: environment,
          tokenStore,
          // admissionの現在値確認は読み取り権限だけで行う。
          createOctokit: createInstallationOctokitResolver({
            relay: relayDeviceClient,
            tokenStore,
            repositoryId,
            purpose: "admission",
          }),
          // HOWの正本へ届かないなら、実装Jobを始めない。
          createPorts: async (octokit) => {
            const linearToken = await bunSecretsLinearToken(repositoryId).get();

            return linearToken === null
              ? null
              : createGitHubApprovalPorts({
                  octokit,
                  repository: {
                    owner: repositoryOwner,
                    name: repositoryName,
                  },
                  linear: createLinearApprovalReader({
                    token: linearToken,
                  }),
                });
          },
          databasePath: statePath,
          harnessEntry: new URL("./harness.js", import.meta.url),
          repositoryId,
          repository: { owner: repositoryOwner, name: repositoryName },
          linearIssueId,
          heartbeatStopMs,
          repositoryRoot,
          worktreesRoot,
          remote: canonicalRemote,
          // canonicalブランチへの送信だけに使う一回限りのcredential。
          resolveCredential: createInstallationGitCredentialResolver({
            relay: relayDeviceClient,
            tokenStore,
            repositoryId,
          }),
          model,
          // 提供元への接続とcredentialの解決は`serve`の内側だけで行う。
          modelProvider: modelStreamProvider,
          getModelCapabilities: () => getModelCapabilities(model),
          /**
           * 承認後の状態反映は、所有権を確認した`serve`だけがLinearへ行う。
           * tokenはこの内側だけで解決し、harnessへも引数へも渡さない。
           */
          linearApprovalState: {
            readLinearState: async (issueId) => {
              const writer = await linearStateWriter(repositoryId);

              return writer === null ? null : writer.readLinearState(issueId);
            },
            moveToTriage: async (issueId) => {
              const writer = await linearStateWriter(repositoryId);

              return writer !== null && writer.moveToTriage(issueId);
            },
            moveToInProgress: async (issueId) => {
              const writer = await linearStateWriter(repositoryId);

              return writer !== null && writer.moveToInProgress(issueId);
            },
            readReviewStateCandidate: async (issueId) => {
              const writer = await linearStateWriter(repositoryId);

              return writer === null
                ? null
                : writer.readReviewStateCandidate(issueId);
            },
            moveToStateId: async (issueId, stateId) => {
              const writer = await linearStateWriter(repositoryId);

              return writer !== null && writer.moveToStateId(issueId, stateId);
            },
          },
          // Pull Request作成には契約のcontents:write/pull_requests:writeへ絞る。
          createPullRequestOctokit: createInstallationOctokitResolver({
            relay: relayDeviceClient,
            tokenStore,
            repositoryId,
            purpose: "pull_request",
          }),
          createPullRequestPorts: (octokit) =>
            createGitHubPullRequestPorts({
              octokit,
              repository: { owner: repositoryOwner, name: repositoryName },
            }),
        }).then((result) =>
          holdIfStarted(jobRegistry, "implementation", result),
        );
      }
    : undefined;

  /**
   * mention/commandトリガーからWHAT確定Jobを始める、唯一の入口。
   *
   * Linear tokenはJob単位でだけ解決し、harnessへは渡さない。
   */
  const whatConfirmationReady = conversationReady && linearTeamId !== undefined;
  const startWhatConfirmation =
    whatConfirmationReady && relayDeviceClient !== undefined
      ? async ({
          issueNumber,
          trigger,
        }: {
          issueNumber: number;
          trigger: { commentId: number; command: boolean };
        }) => {
          const model = resolveJobModel("what_confirmation");

          if (model === null) {
            return refuseWithoutModel();
          }

          if (
            !(await conversationJobSatisfiesModelCapabilities(
              createRepositoryTargetBaseReader(
                relayDeviceClient,
                repositoryId,
                {
                  owner: repositoryOwner,
                  name: repositoryName,
                },
              ),
              () => getModelCapabilities(model),
            ))
          ) {
            return refuseCapabilityMismatch();
          }

          return startWhatConfirmationJob({
            relayOrigin: environment,
            tokenStore,
            createOctokit: createInstallationOctokitResolver({
              relay: relayDeviceClient,
              tokenStore,
              repositoryId,
              purpose: "issue_conversation",
            }),
            databasePath: statePath,
            harnessEntry: new URL("./harness.js", import.meta.url),
            repositoryId,
            repository: { owner: repositoryOwner, name: repositoryName },
            issueNumber,
            trigger,
            model,
            modelProvider: modelStreamProvider,
            linearTeamId,
            createLinearPorts: async () => {
              const linearToken =
                await bunSecretsLinearToken(repositoryId).get();

              return linearToken === null
                ? null
                : {
                    linearDiscovery: createLinearDiscoveryReader({
                      token: linearToken,
                    }),
                    linearTriageWriter: createLinearTriageWriter({
                      token: linearToken,
                    }),
                  };
            },
            heartbeatStopMs,
          }).then((result) =>
            holdIfStarted(jobRegistry, "what_confirmation", result),
          );
        }
      : undefined;

  /**
   * mention/commandトリガーからHOW確定Jobを始める、唯一の入口。
   *
   * Linear tokenはJob単位でだけ解決し、harnessへは渡さない。この対話はLinear
   * issueだけを読み書きし、GitHubへは`.oriel.yaml`のmodelCapabilities照合
   * (ADR 0009)だけに絞ったadmission用途の読み取りOctokitを使う。
   */
  const howConfirmationReady = conversationReady;
  const startHowConfirmation =
    howConfirmationReady && relayDeviceClient !== undefined
      ? async ({
          issueNumber,
          linearIssueId,
          trigger,
        }: {
          issueNumber: number;
          linearIssueId: string;
          trigger: { commentId: string; command: boolean };
        }) => {
          const model = resolveJobModel("how_confirmation");

          if (model === null) {
            return refuseWithoutModel();
          }

          if (
            !(await conversationJobSatisfiesModelCapabilities(
              createRepositoryTargetBaseReader(
                relayDeviceClient,
                repositoryId,
                {
                  owner: repositoryOwner,
                  name: repositoryName,
                },
              ),
              () => getModelCapabilities(model),
            ))
          ) {
            return refuseCapabilityMismatch();
          }

          return startHowConfirmationJob({
            relayOrigin: environment,
            tokenStore,
            databasePath: statePath,
            harnessEntry: new URL("./harness.js", import.meta.url),
            repositoryId,
            repository: { owner: repositoryOwner, name: repositoryName },
            issueNumber,
            linearIssueId,
            trigger,
            model,
            modelProvider: modelStreamProvider,
            createLinearPorts: async () => {
              const linearToken =
                await bunSecretsLinearToken(repositoryId).get();

              if (linearToken === null) {
                return null;
              }

              const reader = createLinearApprovalReader({ token: linearToken });

              return {
                reader,
                commentPublisher: createLinearGraphqlCommentPublisher({
                  token: linearToken,
                }),
                descriptionPublisher: createLinearGraphqlDescriptionPublisher({
                  token: linearToken,
                  reader,
                }),
              };
            },
            heartbeatStopMs,
          }).then((result) =>
            holdIfStarted(jobRegistry, "how_confirmation", result),
          );
        }
      : undefined;

  /**
   * localhost UIで人間が書いた返答本文からHOW対話を始める入口。
   * mention/commandの検知は要らない: Web UIから明示的に始めた時点で対象を
   * 選んでいるため、既存commentのtriggerと同じ受け入れ判定・所有権取得を
   * 経てから`serve`がLinear commentとして投稿する。
   */
  const startHowConversation =
    howConfirmationReady && relayDeviceClient !== undefined
      ? async ({
          issueNumber,
          linearIssueId,
          body,
          command,
        }: {
          issueNumber: number;
          linearIssueId: string;
          body: string;
          command: boolean;
        }) => {
          const model = resolveJobModel("how_confirmation");

          if (model === null) {
            return refuseWithoutModel();
          }

          if (
            !(await conversationJobSatisfiesModelCapabilities(
              createRepositoryTargetBaseReader(
                relayDeviceClient,
                repositoryId,
                {
                  owner: repositoryOwner,
                  name: repositoryName,
                },
              ),
              () => getModelCapabilities(model),
            ))
          ) {
            return refuseCapabilityMismatch();
          }

          return startHowConfirmationJob({
            relayOrigin: environment,
            tokenStore,
            databasePath: statePath,
            harnessEntry: new URL("./harness.js", import.meta.url),
            repositoryId,
            repository: { owner: repositoryOwner, name: repositoryName },
            issueNumber,
            linearIssueId,
            trigger: { body, command },
            model,
            modelProvider: modelStreamProvider,
            createLinearPorts: async () => {
              const linearToken =
                await bunSecretsLinearToken(repositoryId).get();

              if (linearToken === null) {
                return null;
              }

              const reader = createLinearApprovalReader({ token: linearToken });

              return {
                reader,
                commentPublisher: createLinearGraphqlCommentPublisher({
                  token: linearToken,
                }),
                descriptionPublisher: createLinearGraphqlDescriptionPublisher({
                  token: linearToken,
                  reader,
                }),
              };
            },
            heartbeatStopMs,
          }).then((result) =>
            holdIfStarted(jobRegistry, "how_confirmation", result),
          );
        }
      : undefined;

  const transcripts = createTranscriptStore(openServeLocalState(statePath));
  // repository scopeの検索が中継先へ届く接続。webhook通知loopと共に後で開く。
  let notificationConnection: ReturnType<
    typeof createNotificationConnection
  > | null = null;
  const searchTranscripts =
    transcripts !== undefined &&
    repositoryOwner !== undefined &&
    repositoryName !== undefined
      ? createTranscriptSearch(
          transcripts,
          {
            searchRepository: (request) =>
              notificationConnection?.searchRepository(request) ??
              Promise.resolve([]),
          },
          { owner: repositoryOwner, name: repositoryName },
        )
      : undefined;

  /**
   * webhook通知と定期ポーリングから、実装JobとWHAT確定Jobの両方の候補を発見する。
   * 実装Jobを始められる構成(`implementationReady`)とWHAT確定Jobを始められる
   * 構成(`whatConfirmationReady`)は独立に、discoveryのpoll間隔とLinear team両方
   * を明示した場合だけそれぞれ配線する。wake通知は一本のnotification connection
   * から両方のloopへ配る。
   */
  const discoveryLoop =
    implementationReady &&
    startImplementation !== undefined &&
    relayDeviceClient !== undefined &&
    linearTeamId !== undefined
      ? createDiscoveryLoop({
          createPorts: async () => {
            const octokit = await createInstallationOctokitResolver({
              relay: relayDeviceClient,
              tokenStore,
              repositoryId,
              purpose: "admission",
            })();

            if (octokit === null) {
              return null;
            }

            const linearToken = await bunSecretsLinearToken(repositoryId).get();

            if (linearToken === null) {
              return null;
            }

            const openIssues = createGitHubOpenIssuePort({
              octokit,
              repository: { owner: repositoryOwner, name: repositoryName },
            });
            const discoveryReader = createLinearDiscoveryReader({
              token: linearToken,
            });

            return {
              listOpenIssues: () => openIssues.listOpenIssues(),
              findLinearIssuesByGitHubIssueUrl: (url) =>
                discoveryReader.findIssuesByAttachmentUrl(url),
            };
          },
          startImplementationJob: startImplementation,
          pollIntervalMs: discoveryPollIntervalMs,
        })
      : undefined;
  const whatTriggerLoop =
    whatConfirmationReady &&
    startWhatConfirmation !== undefined &&
    relayDeviceClient !== undefined &&
    linearTeamId !== undefined
      ? createWhatTriggerLoop({
          createPorts: async () => {
            const octokit = await createInstallationOctokitResolver({
              relay: relayDeviceClient,
              tokenStore,
              repositoryId,
              purpose: "admission",
            })();

            if (octokit === null) {
              return null;
            }

            const linearToken = await bunSecretsLinearToken(repositoryId).get();

            if (linearToken === null) {
              return null;
            }

            const comments = createOctokitIssueCommentPublisher(octokit);
            const openIssues = createGitHubOpenIssuePort({
              octokit,
              repository: { owner: repositoryOwner, name: repositoryName },
            });
            const discoveryReader = createLinearDiscoveryReader({
              token: linearToken,
            });

            return {
              listOpenIssues: () => openIssues.listOpenIssues(),
              listIssueComments: (issueNumber) =>
                comments
                  .listIssueComments({
                    repository: {
                      owner: repositoryOwner,
                      name: repositoryName,
                    },
                    issueNumber,
                  })
                  .catch(() => null),
              getActorLogin: () => comments.getActorLogin(),
              findLinearIssuesByGitHubIssueUrl: (url) =>
                discoveryReader.findIssuesByAttachmentUrl(url),
            };
          },
          startWhatConfirmationJob: startWhatConfirmation,
          pollIntervalMs: discoveryPollIntervalMs,
        })
      : undefined;
  const howTriggerLoop =
    howConfirmationReady &&
    startHowConfirmation !== undefined &&
    relayDeviceClient !== undefined
      ? createHowTriggerLoop({
          createPorts: async () => {
            const octokit = await createInstallationOctokitResolver({
              relay: relayDeviceClient,
              tokenStore,
              repositoryId,
              purpose: "admission",
            })();

            if (octokit === null) {
              return null;
            }

            const linearToken = await bunSecretsLinearToken(repositoryId).get();

            if (linearToken === null) {
              return null;
            }

            const openIssues = createGitHubOpenIssuePort({
              octokit,
              repository: { owner: repositoryOwner, name: repositoryName },
            });
            const discoveryReader = createLinearDiscoveryReader({
              token: linearToken,
            });
            const reader = createLinearApprovalReader({ token: linearToken });
            const comments = createLinearGraphqlCommentPublisher({
              token: linearToken,
            });

            return {
              listOpenIssues: () => openIssues.listOpenIssues(),
              findLinearIssuesByGitHubIssueUrl: (url) =>
                discoveryReader.findIssuesByAttachmentUrl(url),
              readLinearIssue: (linearIssueId) =>
                reader.readIssue(linearIssueId),
              listLinearComments: (linearIssueId) =>
                comments.listComments({ linearIssueId }).catch(() => null),
              getLinearViewerId: () => comments.getViewerId().catch(() => null),
            };
          },
          startHowConfirmationJob: startHowConfirmation,
          pollIntervalMs: discoveryPollIntervalMs,
        })
      : undefined;

  /**
   * ADR 0005「Linear状態」のとおり、mergeを現在値から確認した後にLinearを
   * Doneへ反映する。webhookは起床通知に過ぎず、pollingが最終的な正しさを担う。
   */
  const prMergeLoop =
    implementationReady && relayDeviceClient !== undefined
      ? (() => {
          const database = openServeLocalState(statePath);

          return createPrMergeDiscoveryLoop({
            createPorts: async () => {
              const octokit = await createInstallationOctokitResolver({
                relay: relayDeviceClient,
                tokenStore,
                repositoryId,
                purpose: "pull_request",
              })();

              if (octokit === null) {
                return null;
              }

              const writer = await linearStateWriter(repositoryId);

              if (writer === null) {
                return null;
              }

              const merges = createGitHubPullRequestMergeCheck({
                octokit,
                repository: { owner: repositoryOwner, name: repositoryName },
              });

              return {
                isPullRequestMerged: (prNumber) =>
                  merges.isPullRequestMerged(prNumber),
                readLinearState: (issueId) => writer.readLinearState(issueId),
                moveToDone: (issueId) => writer.moveToDone(issueId),
              };
            },
            database,
            watchStore: createPullRequestWatchStore(database),
            pollIntervalMs: discoveryPollIntervalMs,
          });
        })()
      : undefined;

  /**
   * ADR 0007のPR対応Job。実装Jobと同じ構成が揃っている場合だけ動かし、Linear
   * credentialは要求しない(このJobはLinearを一切触らない)。
   */
  const prResponseLoop =
    implementationReady && relayDeviceClient !== undefined
      ? (() => {
          const database = openServeLocalState(statePath);
          const checkFailures = createPrResponseCheckFailureStore(database);
          const repository = { owner: repositoryOwner, name: repositoryName };
          const createPrResponseOctokit = createInstallationOctokitResolver({
            relay: relayDeviceClient,
            tokenStore,
            repositoryId,
            purpose: "pr_response",
          });

          return createPrResponseLoop({
            createPorts: async () => {
              const octokit = await createPrResponseOctokit();

              if (octokit === null) {
                return null;
              }

              const actorLogin = await octokit.rest.users
                .getAuthenticated()
                .then((response) => response.data.login)
                .catch(() => null);

              if (actorLogin === null) {
                return null;
              }

              return createGitHubPrResponsePorts({
                octokit,
                repository,
                actorLogin,
              });
            },
            repositoryId,
            checkFailures,
            startPrResponseJob: ({
              prNumber,
              headRef,
              headOid,
              githubIssueNumber,
              approvalFingerprint,
              trigger,
            }) => {
              const model = resolveJobModel("pr_response");

              if (model === null) {
                return refuseWithoutModel();
              }

              return startPrResponseJob({
                relayOrigin: environment,
                tokenStore,
                databasePath: statePath,
                harnessEntry: new URL("./harness.js", import.meta.url),
                repositoryId,
                repository,
                heartbeatStopMs,
                repositoryRoot,
                worktreesRoot,
                remote: canonicalRemote,
                resolveCredential: createInstallationGitCredentialResolver({
                  relay: relayDeviceClient,
                  tokenStore,
                  repositoryId,
                }),
                model,
                modelProvider: modelStreamProvider,
                getModelCapabilities: () => getModelCapabilities(model),
                createExecutionConfigPorts: async () => {
                  const octokit = await createInstallationOctokitResolver({
                    relay: relayDeviceClient,
                    tokenStore,
                    repositoryId,
                    purpose: "admission",
                  })();

                  return octokit === null
                    ? null
                    : createGitHubTargetBaseReader({ octokit, repository });
                },
                createReconciliationPorts: async () => {
                  const octokit = await createPrResponseOctokit();

                  return octokit === null
                    ? null
                    : createGitHubPrResponseReconciliationPorts({
                        octokit,
                        repository,
                      });
                },
                createReportPorts: async () => {
                  const octokit = await createPrResponseOctokit();

                  return octokit === null
                    ? null
                    : createGitHubPrResponseReportPorts({
                        octokit,
                        repository,
                      });
                },
                checkFailures,
                prNumber,
                headRef,
                headOid,
                githubIssueNumber,
                approvalFingerprint,
                trigger,
              }).then((result) =>
                holdIfStarted(jobRegistry, "pr_response", result),
              );
            },
            pollIntervalMs: discoveryPollIntervalMs,
          });
        })()
      : undefined;

  if (
    (discoveryLoop !== undefined ||
      whatTriggerLoop !== undefined ||
      howTriggerLoop !== undefined ||
      prMergeLoop !== undefined ||
      prResponseLoop !== undefined) &&
    repositoryId !== undefined &&
    environment !== undefined
  ) {
    if (linearTeamId !== undefined && relayDeviceClient !== undefined) {
      void (async () => {
        const deviceToken = await tokenStore.get(repositoryId);

        if (deviceToken !== null) {
          await relayDeviceClient.registerLinearRouting(
            deviceToken,
            linearTeamId,
          );
        }
      })();
    }

    discoveryLoop?.start();
    whatTriggerLoop?.start();
    howTriggerLoop?.start();
    prMergeLoop?.start();
    prResponseLoop?.start();

    notificationConnection = createNotificationConnection({
      relayOrigin: environment,
      resolveDeviceToken: () => tokenStore.get(repositoryId),
      onWake: (source) => {
        void discoveryLoop?.wake(source);
        void whatTriggerLoop?.wake(source);
        void howTriggerLoop?.wake(source);
        void prMergeLoop?.wake(source);
        void prResponseLoop?.wake(source);
      },
      onTranscriptSearchRequest: (request) =>
        transcripts === undefined ||
        repositoryOwner === undefined ||
        repositoryName === undefined
          ? []
          : transcripts.search({
              repository: { owner: repositoryOwner, name: repositoryName },
              scope: request.scope === "job" ? "job" : "local",
              jobId: request.jobId,
              query: request.query,
              limit: request.limit,
            }),
    });
  }

  return {
    bindings: {
      relayOrigin: environment,
      repositoryId,
      repositoryOwner,
      repositoryName,
      listModels: async () => {
        await models.refresh({ allowNetwork: true });

        return models.getModels().map(({ provider, id, name }) => ({
          provider,
          id,
          name,
        }));
      },
      startImplementationJob: startImplementation,
      startHowConversation,
      startIssueConversation: conversationReady
        ? ({ issueNumber, body }) =>
            startIssueConversationJob({
              relayOrigin: environment,
              tokenStore,
              // 外部書き込みは、relayが発行するrepository限定の短命installation
              // tokenで認証したOctokitだけで行う。未認証clientは使わない。
              createOctokit: createInstallationOctokitResolver({
                relay: relayDeviceClient,
                tokenStore,
                repositoryId,
                purpose: "issue_conversation",
              }),
              databasePath: statePath,
              harnessEntry: new URL("./harness.js", import.meta.url),
              repositoryId,
              repository: { owner: repositoryOwner, name: repositoryName },
              issueNumber,
              body,
              heartbeatStopMs,
            }).then((result) =>
              holdIfStarted(jobRegistry, "issue_conversation", result),
            )
        : undefined,
      searchTranscripts,
      createDeviceRegistration:
        environment === undefined || relayDeviceClient === undefined
          ? undefined
          : (redirectUri) => {
              const flow = createDeviceRegistrationFlow({
                relay: relayDeviceClient,
                tokenStore,
                authorizeEndpoint: new URL("/device/authorize", environment),
                redirectUri,
                cancellationStore: createPendingCancellationStore(
                  openServeLocalState(statePath),
                ),
              });

              // 前回の起動で取り消せなかった発行済deviceを収束させる。
              void flow.resumePendingCancellations();

              return flow;
            },
    },
    stop() {
      discoveryLoop?.stop();
      whatTriggerLoop?.stop();
      howTriggerLoop?.stop();
      prMergeLoop?.stop();
      prResponseLoop?.stop();
      notificationConnection?.stop();
    },
  };
}
