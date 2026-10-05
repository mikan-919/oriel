import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  DeviceRegistrationPurpose,
  InstanceConfig,
  TranscriptEntry,
  ModelDefaults,
  ModelOption,
  ModelSelection,
  ServeConfig,
} from "@mikan-919/oriel-contracts";
import {
  implementationJobRequestSchema,
  instanceConfigSchema,
  modelDefaultKinds,
  modelDefaultUpdateSchema,
} from "@mikan-919/oriel-contracts";
import { identity } from "@mikan-919/oriel-identity";
import { sValidator } from "@hono/standard-validator";
import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";

import type { DeviceRegistrationFlow } from "./device-registration";
import type { InstanceConfigStore } from "./instance-config";
import {
  createJobRegistry,
  type JobRegistry,
  type StartedJob,
} from "./job-registry";
import type { ModelDefaultsStore } from "./model-defaults";

/** 起動できたJobの取り扱い。開始結果を捨てず、終了まで面倒を見る。 */
export interface StartedIssueConversation extends StartedJob {
  status: "started";
}

function isStarted(
  value: StartedIssueConversation | { status: string; reason?: string },
): value is StartedIssueConversation {
  return value.status === "started";
}

function isTranscriptScope(
  value: string,
): value is "job" | "local" | "repository" {
  return value === "job" || value === "local" || value === "repository";
}

function isDeviceRegistrationPurpose(
  value: string,
): value is DeviceRegistrationPurpose {
  return (
    value === "installations" ||
    value === "registration" ||
    value === "device_list" ||
    value === "revocation"
  );
}

function serializeModelSelection(
  model: ModelSelection | null,
): { provider: string; modelId: string } | null {
  return model === null
    ? null
    : { provider: model.provider, modelId: model.id };
}

function serializeModelDefaults(defaults: ModelDefaults) {
  return {
    base: serializeModelSelection(defaults.base),
    perKind: Object.fromEntries(
      modelDefaultKinds.map((kind) => [
        kind,
        serializeModelSelection(defaults.perKind[kind]),
      ]),
    ),
  };
}

function emptyModelDefaults(): ModelDefaults {
  return {
    base: null,
    perKind: Object.fromEntries(
      modelDefaultKinds.map((kind) => [kind, null]),
    ) as ModelDefaults["perKind"],
  };
}

const loopbackHostname = "127.0.0.1";
const readinessPath = "/healthz";
const callbackPath = "/device/callback";
const webPath = "/app";
const sessionCookieName = `${identity.codeName}_session`;
const csrfHeaderName = `x-${identity.codeName}-csrf`;
/** ビルド後は`dist/cli.js`と同じ`dist/`直下にVite buildの`web/`が並ぶ。 */
const defaultWebDistRoot = fileURLToPath(new URL("./web", import.meta.url));

function environmentVariable(name: string): string {
  return `${identity.environmentPrefix}${name}`;
}

const deviceRegistrationNotConfiguredMessage = `Device registration is not configured. Set ${environmentVariable("RELAY_ORIGIN")} and ${environmentVariable("STATE_PATH")}.`;
const transcriptSearchNotConfiguredMessage = `Transcript search is not configured. Set ${environmentVariable("STATE_PATH")}, ${environmentVariable("REPOSITORY_OWNER")}, and ${environmentVariable("REPOSITORY_NAME")}.`;
const apiPathsWithoutDeviceRegistration = new Set([
  "/api/config",
  "/api/instance-config",
  "/api/models",
  "/api/issue-conversations",
  "/api/implementation-jobs",
]);

function invalidJsonRequest(message: string) {
  return (result: { success: boolean }, context: Context) =>
    result.success
      ? undefined
      : context.json({ error: "bad_request", message }, 400);
}

function normalizeModelSelection(model: ModelSelection): ModelSelection | null {
  const provider = model.provider.trim();
  const id = model.id.trim();

  return provider === "" || id === "" ? null : { provider, id };
}

export interface ServeHttpServerOptions {
  /** Web UIから確認できる、credentialを含まないserve設定。 */
  relayOrigin?: string;
  repositoryId?: number;
  repositoryOwner?: string;
  repositoryName?: string;
  modelProviderId?: string;
  modelId?: string;
  /** local state SQLiteへ保存するmodelのbase/per-kind既定値。 */
  modelDefaults?: ModelDefaultsStore;
  /**
   * relay origin、repositoryなど利用者固有のinstance設定をlocal state
   * SQLiteへ保存する。保存後は`buildInstanceBindings`で組み直した配線へ
   * 即座に差し替え、プロセスは再起動しない。
   */
  instanceConfigStore?: InstanceConfigStore;
  /**
   * 保存されたinstance設定から、`reconfigure()`が差し替える配線一式を組み
   * 直す。relay client、discovery loopなどの再構築は呼び出し元(cli.ts)の
   * 責務であり、`server`はその結果を受け取って配線を差し替えるだけとする。
   */
  buildInstanceBindings?: (config: InstanceConfig) => ServeInstanceBindings;
  /** `serve`のModels集合から、現在選択できるmodelを列挙する。 */
  listModels?: () => Promise<readonly ServeModelOption[]>;
  /** localhost UIがdevice登録と失効に使う経路。relayの設定が無ければ配線しない。 */
  createDeviceRegistration?: (redirectUri: URL) => DeviceRegistrationFlow;
  /** Web UIのビルド成果物を置くディレクトリ。既定はビルド後の`dist/web`。 */
  webDistRoot?: string;
  /**
   * Workflow/Job一覧の唯一の正本。discoveryLoopなどHTTPを経由しない起動経路と
   * 共有できるよう、既定では内部で新しく作らず外部から注入できるようにする。
   */
  jobRegistry?: JobRegistry;
  /**
   * 明示的に起動する、コードを変更しないIssue対話。relay所有権を取れた場合だけ
   * workerが動く。
   */
  startIssueConversation?: (input: {
    issueNumber: number;
    body: string;
  }) => Promise<StartedIssueConversation | { status: string; reason?: string }>;
  /**
   * コードを変更する実装Job。入力は承認されたHOWのLinear Issueだけとし、WHAT、
   * Jobキー、canonicalブランチ、作業内容はすべて`serve`が現在値から導く。
   */
  startImplementationJob?: (input: {
    linearIssueId: string;
    modelOverride?: ModelSelection;
  }) => Promise<StartedIssueConversation | { status: string; reason?: string }>;
  /**
   * 明示的に起動する、コードを変更しないLinear対話。人間が書いた本文をLinear
   * commentとして投稿してからHOW確定Jobを始める。relay所有権を取れた場合だけ
   * workerが動く。
   */
  startHowConversation?: (input: {
    issueNumber: number;
    linearIssueId: string;
    body: string;
    command: boolean;
  }) => Promise<StartedIssueConversation | { status: string; reason?: string }>;
  /**
   * ROADMAPの「local、current Job、repositoryの範囲」を横断するtranscript検索。
   * `statePath`や`repository`が構成されていない起動では配線しない。
   */
  searchTranscripts?: (input: {
    scope: "job" | "local" | "repository";
    jobId?: string;
    query: string;
    limit: number;
  }) => Promise<TranscriptEntry[]>;
}

export type ServeModelOption = ModelOption;

/** 起動ごとのsession値とCSRF token。永続化しない。 */
function newSessionSecrets() {
  return {
    sessionId: randomBytes(32).toString("base64url"),
    csrfToken: randomBytes(32).toString("base64url"),
  };
}

/**
 * 登録画面のパレットとfontは、Web UIのデザイントークンだけを正本にする。
 * ビルド済みSPAのstylesheetを読み、`@theme`が定義するCSS変数をそのまま使う。
 * `dist/web`が無い開発時はここもstyleを持たないが、その状況では`/app`自体が
 * 配信できないため、登録画面だけを別に飾らない。
 */
function webStylesheetHref(webDistRoot: string): string | null {
  try {
    return (
      /<link[^>]*\shref="([^"]+\.css)"/.exec(
        readFileSync(join(webDistRoot, "index.html"), "utf8"),
      )?.[1] ?? null
    );
  } catch {
    return null;
  }
}

function shellHtml(csrfToken: string, stylesheetHref: string | null): string {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="${identity.codeName}-csrf" content="${csrfToken}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${identity.displayName}</title>
    ${stylesheetHref === null ? "" : `<link rel="stylesheet" href="${stylesheetHref}" />`}
    <style>
      body {
        margin: 0;
        min-height: 100dvh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        width: 100%;
        max-width: 440px;
        border: 1px solid var(--color-border);
        background: var(--color-surface);
        padding: 32px;
        border-radius: 16px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
      }
      h1 {
        margin: 0 0 4px;
        font-family: var(--font-display);
        font-size: 22px;
        font-weight: 500;
        letter-spacing: -0.01em;
      }
      .eyebrow {
        margin: 0 0 24px;
        font-family: var(--font-mono);
        font-size: 11px;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        color: var(--color-faint);
      }
      button {
        font: inherit;
        cursor: pointer;
        border-radius: 10px;
        transition: background-color 0.15s ease, border-color 0.15s ease;
      }
      .gate {
        border: none;
        background: var(--color-accent);
        color: var(--color-sidebar);
        padding: 10px 16px;
        font-weight: 500;
      }
      .gate:hover {
        background: var(--color-accent-hover);
      }
      select,
      #discover {
        font: inherit;
        border: 1px solid var(--color-border);
        background: var(--color-bg);
        color: var(--color-text);
        padding: 9px 12px;
        border-radius: 10px;
      }
      #discover {
        cursor: pointer;
      }
      #discover:hover {
        border-color: var(--color-accent);
        color: var(--color-accent);
      }
      form#target:not([hidden]) {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-top: 16px;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 13px;
        color: var(--color-muted);
      }
      ul {
        list-style: none;
        padding: 0;
        margin: 20px 0 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
        background: var(--color-border);
        border-radius: 10px;
        overflow: hidden;
      }
      ul:empty {
        display: none;
      }
      li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        background: var(--color-surface);
        padding: 10px 14px;
        font-family: var(--font-mono);
        font-size: 13px;
      }
      li button {
        border: 1px solid var(--color-border);
        background: transparent;
        color: var(--color-fail);
        padding: 4px 10px;
        font-size: 12px;
      }
      pre {
        margin-top: 20px;
        padding: 14px;
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: 10px;
        font-family: var(--font-mono);
        font-size: 12px;
        overflow-x: auto;
        color: var(--color-muted);
      }
      pre:empty {
        display: none;
      }
      #dashboard {
        display: inline-block;
        margin-top: 16px;
        color: var(--color-accent);
        font-size: 13px;
      }
      #dashboard[hidden] {
        display: none;
      }
      :focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${identity.displayName}</h1>
      <p class="eyebrow">device registration</p>
      <button id="discover" type="button">GitHubのinstallationを読み込む</button>
      <form id="target" hidden>
        <label>repository <select name="target" id="targets"></select></label>
        <button class="gate" type="submit" name="purpose" value="registration">このrepositoryへ登録</button>
        <button type="submit" name="purpose" value="device_list">deviceを一覧</button>
      </form>
      <ul id="devices"></ul>
      <pre id="result"></pre>
      <a id="dashboard" href="/app/" hidden>ダッシュボードを開く</a>
    </div>
    <script type="module">
      const csrf = document.querySelector('meta[name="${identity.codeName}-csrf"]').content;
      const show = (value) => {
        document.querySelector("#result").textContent = JSON.stringify(value, null, 2);
      };
      const post = (path, body) =>
        fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json", "${csrfHeaderName}": csrf },
          body: JSON.stringify(body ?? {}),
        }).then((response) => response.json().catch(() => ({ status: response.status })));
      const start = async (body) => {
        const started = await post("/api/device-registrations", body);
        if (started.authorizeUrl) {
          window.location.href = started.authorizeUrl;
        } else {
          show(started);
        }
      };

      document.querySelector("#discover").addEventListener("click", () => {
        void start({ purpose: "installations" });
      });

      const showTargets = (installations) => {
        const targets = document.querySelector("#targets");
        targets.replaceChildren();
        for (const installation of installations) {
          for (const entry of installation.repositories) {
            const option = document.createElement("option");
            option.value = JSON.stringify({
              installationId: installation.installationId,
              repositoryId: entry.repositoryId,
            });
            option.textContent =
              entry.repository.owner + "/" + entry.repository.name +
              (installation.canAdminister ? "" : " (失効不可)");
            targets.append(option);
          }
        }
        document.querySelector("#target").hidden = installations.length === 0;
      };

      document.querySelector("#target").addEventListener("submit", (event) => {
        event.preventDefault();
        const selected = document.querySelector("#targets").value;
        if (selected) {
          void start({
            purpose: event.submitter.value,
            ...JSON.parse(selected),
          });
        }
      });

      const showDevices = (devices, target) => {
        const list = document.querySelector("#devices");
        list.replaceChildren();
        for (const device of devices) {
          const item = document.createElement("li");
          item.textContent =
            device.deviceId + (device.revokedAt === null ? "" : " (revoked)");
          if (device.revokedAt === null) {
            const button = document.createElement("button");
            button.textContent = "失効";
            button.addEventListener("click", () => {
              void start({ purpose: "revocation", deviceId: device.deviceId, ...target });
            });
            item.append(button);
          }
          list.append(item);
        }
      };

      const parameters = new URLSearchParams(window.location.search);
      if (parameters.has("code") && parameters.has("state")) {
        const completed = await post("/api/device-registrations/completion", {
          code: parameters.get("code"),
          state: parameters.get("state"),
        });
        show(completed);
        if (completed.status === "registered" || completed.status === "revoked") {
          document.querySelector("#dashboard").hidden = false;
        }
        if (completed.status === "installations") {
          showTargets(completed.installations);
        }
        if (completed.status === "devices") {
          showDevices(completed.devices, {
            installationId: completed.installationId,
            repositoryId: completed.repositoryId,
          });
        }
      }
    </script>
  </body>
</html>
`;
}

/**
 * `reconfigure()`が差し替えられる、instance設定に依存する配線だけの部分集合。
 * modelProviderId/modelId、jobRegistry、modelDefaults、webDistRootは
 * instance設定の対象外であり、構築時の値を保つ。
 */
export interface ServeInstanceBindings {
  relayOrigin?: string;
  repositoryId?: number;
  repositoryOwner?: string;
  repositoryName?: string;
  listModels?: ServeHttpServerOptions["listModels"];
  createDeviceRegistration?: ServeHttpServerOptions["createDeviceRegistration"];
  startIssueConversation?: ServeHttpServerOptions["startIssueConversation"];
  startImplementationJob?: ServeHttpServerOptions["startImplementationJob"];
  startHowConversation?: ServeHttpServerOptions["startHowConversation"];
  searchTranscripts?: ServeHttpServerOptions["searchTranscripts"];
}

export function startServeHttpServer({
  relayOrigin,
  repositoryId,
  repositoryOwner,
  repositoryName,
  modelProviderId,
  modelId,
  modelDefaults,
  instanceConfigStore,
  buildInstanceBindings,
  listModels,
  createDeviceRegistration,
  startIssueConversation,
  startImplementationJob,
  startHowConversation,
  searchTranscripts,
  webDistRoot = defaultWebDistRoot,
  jobRegistry = createJobRegistry(),
}: ServeHttpServerOptions = {}) {
  const { sessionId, csrfToken } = newSessionSecrets();
  let expectedAuthority = "";
  let deviceRegistration: DeviceRegistrationFlow | null = null;
  let serveConfig: Omit<ServeConfig, "modelDefaults"> = {
    ...(relayOrigin === undefined ? {} : { relayOrigin }),
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(repositoryOwner === undefined ? {} : { repositoryOwner }),
    ...(repositoryName === undefined ? {} : { repositoryName }),
    ...(modelProviderId === undefined ? {} : { modelProviderId }),
    ...(modelId === undefined ? {} : { modelId }),
  };

  /**
   * Web UIからinstance設定を保存した後、プロセスを再起動せずに反映する唯一の
   * 経路。`serve`側で新しい配線一式(instance-config.tsが保存した値から再構築
   * したJob起動関数、discovery loopなど)を組み直した呼び出し元が、その結果を
   * ここへ渡す。
   */
  function reconfigure(update: ServeInstanceBindings): void {
    relayOrigin = update.relayOrigin;
    repositoryId = update.repositoryId;
    repositoryOwner = update.repositoryOwner;
    repositoryName = update.repositoryName;
    listModels = update.listModels;
    createDeviceRegistration = update.createDeviceRegistration;
    startIssueConversation = update.startIssueConversation;
    startImplementationJob = update.startImplementationJob;
    startHowConversation = update.startHowConversation;
    searchTranscripts = update.searchTranscripts;
    serveConfig = {
      ...(relayOrigin === undefined ? {} : { relayOrigin }),
      ...(repositoryId === undefined ? {} : { repositoryId }),
      ...(repositoryOwner === undefined ? {} : { repositoryOwner }),
      ...(repositoryName === undefined ? {} : { repositoryName }),
      ...(modelProviderId === undefined ? {} : { modelProviderId }),
      ...(modelId === undefined ? {} : { modelId }),
    };
    deviceRegistration =
      createDeviceRegistration?.(
        new URL(`http://${expectedAuthority}${callbackPath}`),
      ) ?? null;
  }

  const app = new Hono();

  function requireDeviceRegistration(context: Context): Response | null {
    return deviceRegistration === null
      ? context.json(
          {
            error: "not_configured",
            message: deviceRegistrationNotConfiguredMessage,
          },
          503,
        )
      : null;
  }

  app.use("*", async (context, next) => {
    const host = context.req.header("host");
    const requestAuthority = new URL(context.req.url).host;
    const origin = context.req.header("origin");

    if (host !== expectedAuthority || requestAuthority !== expectedAuthority) {
      return context.text("Bad Request", 400);
    }

    if (origin !== undefined && origin !== `http://${expectedAuthority}`) {
      return context.text("Bad Request", 400);
    }

    context.header("X-Frame-Options", "DENY");
    await next();
  });

  // 状態を変える経路はsession cookieとCSRF token付きcustom headerを要求する。
  app.use("/api/*", async (context, next) => {
    const session = context.req
      .header("cookie")
      ?.split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${sessionCookieName}=`))
      ?.slice(sessionCookieName.length + 1);

    if (session !== sessionId) {
      return context.text("Forbidden", 403);
    }

    if (
      context.req.method !== "GET" &&
      context.req.header(csrfHeaderName) !== csrfToken
    ) {
      return context.text("Forbidden", 403);
    }

    if (
      deviceRegistration === null &&
      !apiPathsWithoutDeviceRegistration.has(context.req.path)
    ) {
      return context.json(
        {
          error: "not_configured",
          message: deviceRegistrationNotConfiguredMessage,
        },
        503,
      );
    }

    await next();
  });

  app.get(readinessPath, (context) => context.json({ status: "ok" }));

  // stylesheetの名前はbuildごとにhashが変わる。起動時に一度だけ読む。
  const stylesheetHref = webStylesheetHref(webDistRoot);

  function serveShell(context: Context) {
    context.header(
      "Set-Cookie",
      `${sessionCookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
    );

    return context.html(shellHtml(csrfToken, stylesheetHref));
  }

  app.get("/", serveShell);
  // relayからの戻り先。GETは状態を変えず、UIが改めてPOSTで交換する。
  app.get(callbackPath, serveShell);

  app.post("/api/device-registrations", async (context) => {
    const unavailable = requireDeviceRegistration(context);

    if (unavailable !== null) {
      return unavailable;
    }

    const body = (await context.req.json().catch(() => null)) as {
      installationId?: unknown;
      repositoryId?: unknown;
      purpose?: unknown;
      deviceId?: unknown;
    } | null;
    const purpose = body?.purpose;
    const installationId = Number(body?.installationId ?? 0);
    const repositoryId = Number(body?.repositoryId ?? 0);
    const deviceId = body?.deviceId;

    if (
      typeof purpose !== "string" ||
      !isDeviceRegistrationPurpose(purpose) ||
      (purpose !== "installations" &&
        (!Number.isInteger(installationId) ||
          installationId <= 0 ||
          !Number.isInteger(repositoryId) ||
          repositoryId <= 0)) ||
      (purpose === "revocation" &&
        (typeof deviceId !== "string" || deviceId === ""))
    ) {
      return context.text("Bad Request", 400);
    }

    const { authorizeUrl } = deviceRegistration!.begin({
      purpose,
      installationId,
      repositoryId,
      deviceId: typeof deviceId === "string" ? deviceId : undefined,
    });

    return context.json({ authorizeUrl: authorizeUrl.toString() });
  });

  app.post("/api/device-registrations/completion", async (context) => {
    const unavailable = requireDeviceRegistration(context);

    if (unavailable !== null) {
      return unavailable;
    }

    const body = (await context.req.json().catch(() => null)) as {
      code?: unknown;
      state?: unknown;
    } | null;

    if (typeof body?.code !== "string" || typeof body.state !== "string") {
      return context.text("Bad Request", 400);
    }

    const callbackUrl = new URL(`http://${expectedAuthority}${callbackPath}`);
    callbackUrl.searchParams.set("code", body.code);
    callbackUrl.searchParams.set("state", body.state);

    return context.json(await deviceRegistration!.complete(callbackUrl));
  });

  /**
   * 起動できたJobをHTTPレスポンスへ変換する共通処理。
   *
   * Job registryへの登録は呼び出し元(`startIssueConversation`/
   * `startImplementationJob`自体)の責務とする。discoveryLoopなどHTTPを経由
   * しない起動経路も同じJob起動関数を呼ぶため、登録をここへ置くと二重登録に
   * なるか、HTTPを経由しない起動が一覧から漏れるかのどちらかになる。
   */
  async function holdStartedJob(
    context: Context,
    start: () => Promise<
      StartedIssueConversation | { status: string; reason?: string }
    >,
  ): Promise<Response> {
    const started = await start();

    if (!isStarted(started)) {
      return context.json(started, 409);
    }

    return context.json({
      status: "started",
      jobId: started.jobId,
    });
  }

  // コードを変更しない対話。WHATのIssueと人間が書いた返答本文だけを受け取る。
  app.post("/api/issue-conversations", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      issueNumber?: unknown;
      body?: unknown;
    } | null;
    const issueNumber = Number(body?.issueNumber);

    const startConversation = startIssueConversation;

    if (startConversation === undefined) {
      return context.json(
        {
          error: "not_configured",
          message: `Issue conversations are not configured. Set ${environmentVariable("RELAY_ORIGIN")}, ${environmentVariable("STATE_PATH")}, ${environmentVariable("REPOSITORY_ID")}, ${environmentVariable("REPOSITORY_OWNER")}, ${environmentVariable("REPOSITORY_NAME")}, and ${environmentVariable("OWNERSHIP_HEARTBEAT_STOP_MS")}.`,
        },
        503,
      );
    }

    // JobキーとcanonicalブランチはWHATの現在値からserveが導く。
    // clientはどちらも指定できず、この入口ではコードを変更するJobも起動できない。
    if (
      body === null ||
      Object.keys(body).some(
        (field) => field !== "issueNumber" && field !== "body",
      ) ||
      typeof body.body !== "string" ||
      body.body === "" ||
      !Number.isInteger(issueNumber) ||
      issueNumber <= 0
    ) {
      return context.json(
        {
          error: "bad_request",
          message:
            "issueNumberは正の整数、bodyは空でない文字列で指定し、余分なフィールドは含めないでください。",
        },
        400,
      );
    }

    return holdStartedJob(context, () =>
      startConversation({ issueNumber, body: body.body as string }),
    );
  });

  /**
   * コードを変更する実装Job。入力は承認されたHOWのLinear Issueだけとし、WHAT、
   * Jobキー、canonicalブランチ、承認指紋、作業内容はclientから受け取らない。
   */
  app.post(
    "/api/implementation-jobs",
    sValidator(
      "json",
      implementationJobRequestSchema,
      invalidJsonRequest(
        "linearIssueIdは空でない文字列で指定し、modelOverrideにはproviderとidを指定してください。",
      ),
    ),
    async (context) => {
      const body = context.req.valid("json");
      const startImplementation = startImplementationJob;

      if (startImplementation === undefined) {
        return context.json(
          {
            error: "not_configured",
            message: `Implementation jobs are not configured. Set ${environmentVariable("RELAY_ORIGIN")}, ${environmentVariable("STATE_PATH")}, ${environmentVariable("REPOSITORY_ID")}, ${environmentVariable("REPOSITORY_OWNER")}, ${environmentVariable("REPOSITORY_NAME")}, ${environmentVariable("OWNERSHIP_HEARTBEAT_STOP_MS")}, ${environmentVariable("REPOSITORY_ROOT")}, ${environmentVariable("WORKTREES_ROOT")}, ${environmentVariable("MODEL_PROVIDER")}, and ${environmentVariable("MODEL_ID")}.`,
          },
          503,
        );
      }

      const modelOverride =
        body.modelOverride === undefined
          ? undefined
          : normalizeModelSelection(body.modelOverride);

      if (body.modelOverride !== undefined && modelOverride === null) {
        return context.json(
          {
            error: "bad_request",
            message:
              "modelOverrideのproviderとidは空白以外を指定してください。",
          },
          400,
        );
      }

      return holdStartedJob(context, () =>
        startImplementation({
          linearIssueId: body.linearIssueId,
          modelOverride: modelOverride ?? undefined,
        }),
      );
    },
  );

  /**
   * コードを変更しないLinear対話。JobキーとcanonicalブランチはHOWの現在値から
   * `serve`が導く。`command`はTriage→Todoの承認そのものではなく、Agentへ渡す
   * 確定意図の合図に過ぎない。
   */
  app.post("/api/how-conversations", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      issueNumber?: unknown;
      linearIssueId?: unknown;
      body?: unknown;
      command?: unknown;
    } | null;
    const issueNumber = Number(body?.issueNumber);
    const startConversation = startHowConversation;

    if (
      startConversation === undefined ||
      body === null ||
      Object.keys(body).some(
        (field) =>
          field !== "issueNumber" &&
          field !== "linearIssueId" &&
          field !== "body" &&
          field !== "command",
      ) ||
      typeof body.linearIssueId !== "string" ||
      body.linearIssueId === "" ||
      typeof body.body !== "string" ||
      body.body === "" ||
      !Number.isInteger(issueNumber) ||
      issueNumber <= 0 ||
      (body.command !== undefined && typeof body.command !== "boolean")
    ) {
      return context.text("Bad Request", 400);
    }

    return holdStartedJob(context, () =>
      startConversation({
        issueNumber,
        linearIssueId: body.linearIssueId as string,
        body: body.body as string,
        command: body.command === true,
      }),
    );
  });

  // Workflow/Jobの現在状態を横断的に確認する唯一の一覧経路。
  app.get("/api/jobs", (context) => context.json({ jobs: jobRegistry.list() }));

  function currentModelDefaults() {
    return serializeModelDefaults(
      modelDefaults?.list() ?? emptyModelDefaults(),
    );
  }

  app.get("/api/config", (context) =>
    context.json({ ...serveConfig, modelDefaults: currentModelDefaults() }),
  );

  app.post(
    "/api/config",
    sValidator(
      "json",
      modelDefaultUpdateSchema,
      invalidJsonRequest(
        "scope、provider、modelIdを指定し、providerとmodelIdは両方指定するか両方nullにしてください。",
      ),
    ),
    async (context) => {
      if (modelDefaults === undefined) {
        return context.json(
          {
            error: "not_configured",
            message: "Model defaults are not configured.",
          },
          503,
        );
      }

      const body = context.req.valid("json");

      if (body.provider === null && body.modelId === null) {
        modelDefaults.clear(body.scope);
      } else {
        const provider = body.provider?.trim() ?? "";
        const modelId = body.modelId?.trim() ?? "";

        if (provider === "" || modelId === "") {
          return context.json(
            {
              error: "bad_request",
              message:
                "providerとmodelIdは空白以外を指定するか、両方nullで既定値を解除してください。",
            },
            400,
          );
        }

        modelDefaults.set(body.scope, {
          provider,
          id: modelId,
        });
      }

      return context.json({ modelDefaults: currentModelDefaults() });
    },
  );

  const emptyInstanceConfig: InstanceConfig = {
    relayOrigin: null,
    repositoryId: null,
    repositoryOwner: null,
    repositoryName: null,
    repositoryRoot: null,
    worktreesRoot: null,
    linearTeamId: null,
    canonicalRemote: null,
    lmStudioBaseUrl: null,
  };

  // relay origin、repositoryなど、初回起動時に人間が入力するinstance設定。
  app.get("/api/instance-config", (context) =>
    context.json(instanceConfigStore?.get() ?? emptyInstanceConfig),
  );

  app.post(
    "/api/instance-config",
    sValidator(
      "json",
      instanceConfigSchema,
      invalidJsonRequest(
        "instance設定の各項目は空でない文字列かnullで指定してください。",
      ),
    ),
    (context) => {
      if (
        instanceConfigStore === undefined ||
        buildInstanceBindings === undefined
      ) {
        return context.json(
          {
            error: "not_configured",
            message: "Instance config storage is not configured.",
          },
          503,
        );
      }

      const body = context.req.valid("json");

      instanceConfigStore.set(body);
      reconfigure(buildInstanceBindings(body));

      return context.json(body);
    },
  );

  app.get("/api/models", async (context) => {
    if (listModels === undefined) {
      return context.json([]);
    }

    try {
      return context.json(await listModels());
    } catch {
      return context.json([]);
    }
  });

  /**
   * Web UIからの計画停止。実行に時間がかかるJob種別だけが応じ、それ以外や
   * 対象が見つからない場合は何も起きない。
   */
  app.post("/api/jobs/:jobId/stop", (context) => {
    const stopped = jobRegistry.requestStop(context.req.param("jobId"));

    return context.json({ stopped });
  });

  // local、current Job、repositoryの範囲でtranscriptを確認する唯一の経路。
  app.get("/api/transcripts", async (context) => {
    if (searchTranscripts === undefined) {
      return context.json(
        {
          error: "not_configured",
          message: transcriptSearchNotConfiguredMessage,
        },
        503,
      );
    }

    const scope = context.req.query("scope");
    const jobId = context.req.query("jobId");
    // 省略時は空文字列。job scopeでは、あるJobの全ログを時系列に取り出す
    // 「一覧」としても`search`を使い、専用の一覧経路を別に持たない。
    const query = context.req.query("query") ?? "";
    /**
     * Limit: 既定50件 / 上限200件
     * Source: 既定値。requester・target specification・実測のいずれでもない。
     * Required For: 1 requestあたりのFTS5走査とrelay中継の量を抑えること。
     *   Web UI側の対応する値は`apps/web/src/limits.ts`にある。
     */
    const limit = Number(context.req.query("limit") ?? 50);

    if (
      typeof scope !== "string" ||
      !isTranscriptScope(scope) ||
      !Number.isInteger(limit) ||
      limit <= 0 ||
      limit > 200
    ) {
      return context.text("Bad Request", 400);
    }

    return context.json({
      entries: await searchTranscripts({ scope, jobId, query, limit }),
    });
  });

  // Workflow/Job一覧を確認するWeb UI。ビルド成果物をそのまま配信する。
  // deviceRegistrationの設定有無に関わらず、sessionとCSRF tokenだけを配る。
  app.get(`${webPath}/session`, (context) => {
    context.header(
      "Set-Cookie",
      `${sessionCookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
    );

    return context.json({ csrfToken });
  });
  app.get(webPath, (context) => context.redirect(`${webPath}/`, 302));
  app.use(
    `${webPath}/*`,
    serveStatic({
      root: webDistRoot,
      rewriteRequestPath: (path) => path.slice(webPath.length) || "/",
    }),
  );

  app.get("/api/device-cancellations", (context) =>
    (() => {
      const unavailable = requireDeviceRegistration(context);

      return (
        unavailable ??
        context.json({ pending: deviceRegistration!.pendingCancellations() })
      );
    })(),
  );

  app.post("/api/device-cancellations/resume", async (context) => {
    const unavailable = requireDeviceRegistration(context);

    if (unavailable !== null) {
      return unavailable;
    }

    return context.json({
      pending: await deviceRegistration!.resumePendingCancellations(),
    });
  });

  const server = Bun.serve({
    hostname: loopbackHostname,
    port: 0,
    fetch: app.fetch,
  });
  expectedAuthority = `${loopbackHostname}:${server.port}`;
  deviceRegistration =
    createDeviceRegistration?.(
      new URL(`http://${expectedAuthority}${callbackPath}`),
    ) ?? null;

  return {
    readinessUrl: new URL(`http://${expectedAuthority}${readinessPath}`),
    server,
    jobRegistry,
    /** 停止時も動いているJobのprocessと所有権接続を閉じる。 */
    close() {
      jobRegistry.closeAll();
      server.stop(true);
    },
  };
}
