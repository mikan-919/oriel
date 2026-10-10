const pairing = window.orielPairing;
delete window.orielPairing;
const connectionRequest = window.orielConnection;
delete window.orielConnection;

const dashboard = document.getElementById("dashboard");
const status = document.getElementById("status");
const account = document.getElementById("account");
const anonymousActions = document.getElementById("anonymous-actions");
const sessionActions = document.getElementById("session-actions");
const deviceList = document.getElementById("devices");
const deviceSummary = document.getElementById("device-summary");
const progressStatus = document.getElementById("workflow-progress-status");
const pairSection = document.getElementById("pairing");
const pairDetails = document.getElementById("pair-details");
const pairStatus = document.getElementById("pair-status");
const approvePair = document.getElementById("approve-pair");
const integrationSection = document.getElementById("integration");
const integrationActions = document.getElementById("integration-actions");
const integrationStatus = document.getElementById("integration-status");
const issuesStatus = document.getElementById("issues-status");
const refreshIssuesButton = document.getElementById("refresh-issues");
const repositoryWork = document.getElementById("repository-work");
const repositoryDetails = document.getElementById("repository-details");
const repositoryStatus = document.getElementById("repository-status");
const repositoryIssues = document.getElementById("repository-issues");
const refreshRepositoryButton = document.getElementById("refresh-repository");
const whatForm = document.getElementById("what-form");
const whatFields = document.getElementById("what-fields");
const whatTitle = document.getElementById("what-title");
const whatBody = document.getElementById("what-body");
const providers = ["github", "linear"];
const providerNames = {github: "GitHub", linear: "Linear"};
const providerControls = Object.fromEntries(providers.map((provider) => [provider, {
    details: document.getElementById(`${provider}-details`),
    authorization: document.getElementById(`${provider}-authorization`),
    connect: document.getElementById(`${provider}-connect`),
    disconnect: document.getElementById(`${provider}-disconnect`),
    selection: document.getElementById(`${provider}-selection`),
    select: document.getElementById(`${provider}-target`),
    save: document.getElementById(`${provider}-save`),
    issues: document.getElementById(`${provider}-issues`),
}]));
let integrations = null;
let accountEpoch = 0;
let integrationsRequest = 0;
let issuesRequest = 0;
let repositoryRequest = 0;
let repositoryDeviceId = null;
let workflowSnapshot = null;
let pendingWhat = null;
let workflowRefreshing = false;
let integrationNotice = connectionRequest.returned
    ? `${providerNames[connectionRequest.returned]}の認可が完了しました。設定でリポジトリまたはチームを選択し、保存して連携を完了してください。`
    : connectionRequest.failed
        ? "サービス認可に失敗したか、取り消されました。再度連携してください。"
        : "";
const terminalView = document.getElementById("terminal-view");
const terminalTitle = document.getElementById("terminal-title");
const container = document.getElementById("terminal");
let user = null;
let sessionLoading = true;
let devices = [];
let busy = false;
let pairInfo = null;
let pairClaimed = false;
let pairOwner = null;
let deviceRefresh = null;
let deviceTimer;
let deviceListFailed = false;
let terminal;
let fit;
let socket;
let progressSocket;
let progressRetry;
let progressExpiry;
let progressRetryDelay = 5000;
let progressReceivedAt = 0;
let progressStream = "signed-out";
let progressSnapshot = new Map();
const deviceRows = new Map();
const progressStages = {
    idle: "待機", discovering: "探索", preparing: "準備",
    planning: "計画", discussing: "相談", implementing: "実装", reviewing: "レビュー",
    verifying: "検証", integrating: "統合", pushing: "送信",
    publishing: "公開", reconciling: "同期", paused: "一時停止",
};
const encoder = new TextEncoder();

function render() {
    renderOverview();
    account.textContent = sessionLoading ? "ログイン状態を確認中…" : user ? `ログイン中: ${user.display_name} (${user.id})` : "未ログインです。";
    anonymousActions.hidden = !!user;
    sessionActions.hidden = !user;
    for (const button of dashboard.querySelectorAll("button")) button.disabled = busy;
    for (const row of deviceRows.values()) row.open.disabled = busy || deviceListFailed || row.device.terminal_status !== "online";
    approvePair.disabled = busy || !user || !pairInfo || pairClaimed;
    pairSection.hidden = !pairing.token && !pairing.invalid && !pairInfo;
    if (pairing.invalid) {
        pairStatus.textContent = "ペアリングリンクが無効です。端末で再開してください。";
    } else if (pairing.token && !user) {
        pairStatus.textContent = "ログインまたはアカウント作成後に端末を確認してください。このタブを開いたままにしてください。再読み込みするとリンク情報が失われます。";
    }
    integrationSection.hidden = !user && !integrationNotice;
    integrationActions.hidden = !user;
    integrationStatus.textContent = integrationNotice + (!user && integrationNotice ? " 連携設定にはログインが必要です。" : "");
    for (const provider of providers) {
        const controls = providerControls[provider];
        const target = integrations?.[provider];
        const choices = integrations?.choices?.[provider] ?? [];
        const attempt = integrations?.authorization?.[provider];
        let explanation = "";
        if (attempt?.status === "failed") {
            const code = attempt.error;
            if (code === "incorrect_client_credentials" || code === "invalid_client") {
                explanation = `${providerNames[provider]}のアプリ設定が拒否されました。Relay管理者に設定の確認を依頼してください。`;
            } else if (code === "app_actor_required") {
                explanation = "Linearを再連携し、ワークスペース管理者としてOrielを認可してください。";
            } else if (attempt.step === "targets") {
                explanation = `${providerNames[provider]}の認可は完了しましたが、連携先を取得できませんでした（${code || "詳細不明"}）。`;
            } else {
                explanation = `${providerNames[provider]}の認可に失敗しました${attempt.step ? `（${attempt.step}）` : ""}${code ? ` (${code})` : ""}。`;
            }
        } else if (attempt?.status === "ready" && !target) {
            explanation = choices.length
                ? `認可が完了しました。${provider === "github" ? "リポジトリ" : "チーム"}を選択して保存してください。`
                : provider === "github"
                    ? "認可は完了しましたが、利用可能なリポジトリがありません。GitHub Appへのアクセス権を確認してください。"
                    : "認可は完了しましたが、利用可能なLinearチームがありません。";
        } else if (attempt?.status === "interrupted") {
            explanation = "認可が中断されました。再度連携してください。";
        } else if (attempt && !target) {
            explanation = "認可が完了していません。再度連携してください。";
        }
        controls.authorization.textContent = explanation;
        controls.authorization.hidden = !explanation;
        controls.details.textContent = target
            ? provider === "github"
                ? `連携先: ${target.owner}/${target.name}（repository ${target.repository_id}, installation ${target.installation_id}）`
                : `連携先: ${target.team_name}（team ${target.team_id}, workspace ${target.workspace_id}） ` +
                    (target.agent ? `Linear Triageのコメントで @ から ${target.agent.name} を選択してHOWを相談できます。`
                        : "OrielをメンションするにはLinearを再連携してください。ワークスペース管理者の承認が必要です。")
            : integrations ? "連携先は未設定です。" : busy ? "連携状態を読み込み中…" : "連携状態を取得できません。アカウントを更新してください。";
        controls.connect.textContent = target ? `${providerNames[provider]}を再連携` : `${providerNames[provider]}と連携`;
        controls.connect.disabled = busy || !user;
        controls.disconnect.disabled = busy || !user || !integrations;
        controls.selection.hidden = !choices.length;
        controls.select.disabled = busy || !user;
        controls.save.disabled = busy || !user || controls.select.value === "";
    }
    refreshIssuesButton.disabled = busy || !user || (!integrations?.github && !integrations?.linear);
    repositoryWork.hidden = !user || !devices.length;
    refreshRepositoryButton.disabled = busy || !user || !repositoryDeviceId;
    whatFields.disabled = busy || !user || !repositoryDeviceId || !workflowSnapshot;
}

function disconnect() {
    const wasVisible = !terminalView.hidden;
    const connection = socket;
    socket = undefined;
    connection?.close();
    terminalView.hidden = true;
    dashboard.hidden = false;
    if (wasVisible) document.getElementById("page-title").focus();
}

function setUser(next) {
    if (user?.id !== next?.id) {
        disconnect();
        accountEpoch++;
        stopProgress();
        progressSnapshot.clear();
        deviceRows.clear();
        integrationsRequest++;
        issuesRequest++;
        repositoryRequest++;
        repositoryDeviceId = null;
        workflowSnapshot = null;
        pendingWhat = null;
        whatTitle.value = "";
        whatBody.value = "";
        integrations = null;
        for (const controls of Object.values(providerControls)) {
            controls.select.replaceChildren();
            controls.issues.replaceChildren();
        }
        issuesStatus.textContent = "";
        repositoryDetails.textContent = "";
        repositoryStatus.textContent = "";
        repositoryIssues.replaceChildren();
        if (user || !next) integrationNotice = "";
        devices = [];
        deviceList.replaceChildren();
        deviceSummary.textContent = next ? "端末を読み込み中…" : "ログインすると端末を確認できます。";
    }
    user = next;
    clearTimeout(deviceTimer);
    if (user) scheduleDevices();
    render();
    if (user) connectProgress();
}

async function api(path, body) {
    const requestEpoch = accountEpoch;
    const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: body === undefined ? {} : {"Content-Type": "application/json"},
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        if (response.status === 401) {
            const sessionExpired = accountEpoch === requestEpoch;
            if (sessionExpired) setUser(null);
            throw Object.assign(new Error("セッションが失効したか、未ログインです。再度ログインしてください。"), {sessionExpired});
        }
        throw new Error(data.error || data.message || `リクエストが拒否されました（${response.status}）。`);
    }
    return data;
}

function errorText(error) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") {
        return "Passkey操作が取り消されたか、期限切れまたは拒否されました。ログイン・登録は完了していません。";
    }
    if (error.name === "InvalidStateError") {
        return "このPasskeyは登録済みです。予備には別の認証器を選択してください。";
    }
    return error.message || "操作に失敗しました。";
}

async function perform(action) {
    if (busy) return;
    busy = true;
    status.textContent = "処理中…";
    render();
    try {
        await action();
    } catch (error) {
        status.textContent = errorText(error);
    } finally {
        busy = false;
        if (status.textContent === "処理中…") status.textContent = "";
        render();
    }
}

function decodeBase64url(value) {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encodeBase64url(value) {
    let binary = "";
    for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function credentialJSON(credential) {
    if (typeof credential.toJSON === "function") return credential.toJSON();
    const response = {clientDataJSON: encodeBase64url(credential.response.clientDataJSON)};
    if (credential.response.attestationObject) {
        response.attestationObject = encodeBase64url(credential.response.attestationObject);
        response.transports = credential.response.getTransports?.() ?? [];
    } else {
        response.authenticatorData = encodeBase64url(credential.response.authenticatorData);
        response.signature = encodeBase64url(credential.response.signature);
        response.userHandle = credential.response.userHandle
            ? encodeBase64url(credential.response.userHandle) : null;
    }
    return {
        id: credential.id,
        rawId: encodeBase64url(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment,
        response,
        clientExtensionResults: credential.getClientExtensionResults(),
    };
}

async function authenticate(kind) {
    if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) {
        throw new Error("Passkeyには対応ブラウザーとHTTPS（またはループバックHTTP）が必要です。");
    }
    const backup = kind === "register" && !!user;
    const {options} = await api(`/api/auth/${kind}/options`, {});
    const publicKey = {...options, challenge: decodeBase64url(options.challenge)};
    if (kind === "register") {
        publicKey.user = {...options.user, id: decodeBase64url(options.user.id)};
        publicKey.excludeCredentials = (options.excludeCredentials ?? []).map(
            (credential) => ({...credential, id: decodeBase64url(credential.id)}),
        );
    } else if (options.allowCredentials) {
        publicKey.allowCredentials = options.allowCredentials.map(
            (credential) => ({...credential, id: decodeBase64url(credential.id)}),
        );
    }
    const credential = kind === "register"
        ? await navigator.credentials.create({publicKey})
        : await navigator.credentials.get({publicKey});
    if (!credential) throw new Error("Passkeyが選択されませんでした。操作は完了していません。");
    const result = await api(`/api/auth/${kind}/verify`, {credential: credentialJSON(credential)});
    setUser(result.user);
    status.textContent = backup ? "予備のPasskeyを追加しました。" : "ログインしました。";
    await refreshAccountData();
}

function setProgressStream(state) {
    progressStream = state;
    const message = {
        "signed-out": "ログインすると実行状況を確認できます。",
        connecting: "実行状況に接続中です。実行状態はまだ確認できません。",
        live: "実行状況に接続しました。Todo承認とPRマージは各サービスで行ってください。",
        stale: "実行状況の情報が古いか取得できません。現在の状態は未確認です。再接続中です。",
    }[state];
    if (progressStatus.textContent !== message) progressStatus.textContent = message;
    renderProgressCards();
}

function stopProgress() {
    clearTimeout(progressRetry);
    clearTimeout(progressExpiry);
    progressRetry = undefined;
    const connection = progressSocket;
    progressSocket = undefined;
    connection?.close();
    progressReceivedAt = 0;
    progressRetryDelay = 5000;
    setProgressStream("signed-out");
}

function retryProgress(epoch) {
    if (!currentAccount(epoch) || progressRetry) return;
    progressRetry = setTimeout(async () => {
        progressRetry = undefined;
        if (!currentAccount(epoch)) return;
        try {
            const result = await api("/api/session");
            if (!currentAccount(epoch)) return;
            setUser(result.user);
        } catch (_) {
            if (currentAccount(epoch)) retryProgress(epoch);
        }
    }, progressRetryDelay);
    progressRetryDelay = Math.min(progressRetryDelay * 2, 30000);
}

function staleProgress() {
    if (!user) return;
    clearTimeout(progressExpiry);
    const connection = progressSocket;
    progressSocket = undefined;
    connection?.close();
    setProgressStream("stale");
    retryProgress(accountEpoch);
}

function connectProgress() {
    if (!user || progressSocket || progressRetry) return;
    const epoch = accountEpoch;
    const url = new URL("/api/workflow-progress/connect", location.origin);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    setProgressStream(progressSnapshot.size ? "stale" : "connecting");
    let connection;
    try {
        connection = new WebSocket(url);
    } catch (_) {
        setProgressStream("stale");
        retryProgress(epoch);
        return;
    }
    progressSocket = connection;
    const current = () => currentAccount(epoch) && progressSocket === connection;
    connection.addEventListener("open", () => {
        if (current()) connection.send("ready");
    });
    // Relay sends fresh snapshots at least every 10 seconds, even without stage changes.
    const expire = () => {
        if (!current()) return;
        staleProgress();
    };
    progressExpiry = setTimeout(expire, 60000);
    connection.addEventListener("message", (event) => {
        if (!current()) return;
        try {
            const frame = JSON.parse(event.data);
            if (frame.type !== "workflow-progress" || !Array.isArray(frame.devices)) throw new Error("Invalid progress snapshot");
            const snapshot = new Map();
            for (const device of frame.devices) {
                if (typeof device.device_id !== "string" || !["offline", "idle", "running", "paused"].includes(device.state)) {
                    throw new Error("Invalid device progress");
                }
                snapshot.set(device.device_id, device);
            }
            progressSnapshot = snapshot;
            progressReceivedAt = Date.now();
            progressRetryDelay = 5000;
            clearTimeout(progressExpiry);
            progressExpiry = setTimeout(expire, 60000);
            setProgressStream("live");
        } catch (_) {
            expire();
        }
    });
    connection.addEventListener("error", () => {
        if (!current()) return;
        expire();
    });
    connection.addEventListener("close", () => {
        if (!current()) return;
        clearTimeout(progressExpiry);
        progressSocket = undefined;
        setProgressStream("stale");
        retryProgress(epoch);
    });
}

function updateProgressLink(link, label, address, host) {
    link.textContent = label;
    link.hidden = !address;
    if (!address) {
        link.removeAttribute("href");
        return;
    }
    try {
        const checked = issueLink(label, address, host);
        link.href = checked.href;
        link.target = checked.target;
        link.rel = checked.rel;
    } catch (_) {
        link.hidden = true;
        link.removeAttribute("href");
    }
}

function renderProgressCards() {
    renderOverview();
    for (const [id, row] of deviceRows) {
        const progress = progressSnapshot.get(id);
        const stale = progressStream !== "live";
        const stage = progressStages[progress?.stage] || progress?.stage || "段階は未取得";
        const state = progress ? `${({offline:"runner未接続",idle:"待機中",running:"実行中",paused:"一時停止",blocked:"ブロック中"})[progress.state] || progress.state}` : "状態を取得中";
        const detail = progress?.state === "offline" ? " — runner未接続。承認済みの作業を再開するには端末で orield workflow を実行してください。"
            : progress?.state === "idle" ? " — 作業待ち"
            : progress ? ` — ${stage}` : "";
        const label = stale ? `情報未確認 — ${progress ? `最終報告: ${state}${detail}（現在の実行は未確認）` : "現在の実行は未確認"}`
            : `${state}${detail}`;
        row.card.dataset.state = stale ? "stale" : progress?.state || "unknown";
        if (row.state.textContent !== label) row.state.textContent = label;
        const task = progress?.task;
        updateProgressLink(row.whatLink, task ? `#${task.issue_number}: ${task.title}` : "", task?.url, "github.com");
        row.whatEmpty.textContent = task ? (row.whatLink.hidden ? `#${task.issue_number}: ${task.title}（リンク未取得）` : "")
            : "未取得";
        updateProgressLink(row.howLink, task?.how_identifier || "Linear HOWを開く", task?.how_url, "linear.app");
        row.howEmpty.textContent = row.howLink.hidden ? task?.how_identifier || "未取得" : "";
        const repository = task?.repository || (row.device.repository
            ? `${row.device.repository.owner}/${row.device.repository.name}` : "未取得");
        row.progressRepository.textContent = `リポジトリ: ${repository}`;
        const updated = progress?.updated_at ? new Date(progress.updated_at) : null;
        if (updated && !Number.isNaN(updated.getTime())) {
            row.updated.dateTime = updated.toISOString();
            row.updated.textContent = updated.toLocaleString();
        } else {
            row.updated.removeAttribute("datetime");
            row.updated.textContent = "未取得";
        }
    }
}

function actionButton(label) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    return button;
}

function createDeviceRow(device) {
    const item = document.createElement("li");
    item.id = `device-${device.device_id}`;
    const label = document.createElement("h3");
    const repository = document.createElement("p");
    repository.id = `repository-${device.device_id}`;
    const open = actionButton("端末を開く");
    open.title = "切断中の入力は再送されません。ホスト再起動後はPTYを復元できません。";
    const work = actionButton("ワークフローを開く");
    const card = document.createElement("div");
    card.id = `execution-${device.device_id}`;
    card.className = "execution-card";
    const state = document.createElement("p");
    state.id = `execution-state-${device.device_id}`;
    state.className = "execution-state";
    state.setAttribute("role", "status");
    state.setAttribute("aria-atomic", "true");
    const what = document.createElement("p");
    const whatLink = document.createElement("a");
    whatLink.id = `execution-what-${device.device_id}`;
    const whatEmpty = document.createElement("span");
    what.append("WHAT: ", whatLink, whatEmpty);
    const how = document.createElement("p");
    const howLink = document.createElement("a");
    howLink.id = `execution-how-${device.device_id}`;
    const howEmpty = document.createElement("span");
    how.append("HOW: ", howLink, howEmpty);
    const progressRepository = document.createElement("p");
    progressRepository.id = `execution-repository-${device.device_id}`;
    const updatedLine = document.createElement("p");
    const updated = document.createElement("time");
    updated.id = `execution-updated-${device.device_id}`;
    updatedLine.append("更新日時: ", updated);
    card.append(state, what, how, progressRepository, updatedLine);
    item.append(label, repository, open, work, card);
    const row = {device, item, label, repository, open, work, card, state, whatLink, whatEmpty, howLink, howEmpty, progressRepository, updated};
    open.addEventListener("click", () => perform(() => openTerminal(row.device)));
    work.addEventListener("click", () => perform(async () => {
        repositoryDeviceId = row.device.device_id;
        showPage("workflow");
        await refreshWorkflow();
    }));
    return row;
}

async function refreshDevices() {
    if (!user) return;
    const epoch = accountEpoch;
    if (deviceRefresh?.epoch === epoch) return deviceRefresh.promise;
    const promise = updateDevices().catch(error => {
        if (currentAccount(epoch)) {
            deviceListFailed = true;
            deviceSummary.textContent = "状態確認失敗";
            renderOverview();
            for (const row of deviceRows.values()) row.open.disabled = true;
        }
        throw error;
    }).finally(() => { if (deviceRefresh?.promise === promise) deviceRefresh = null; });
    deviceRefresh = {epoch, promise};
    return promise;
}

async function updateDevices() {
    if (!user) return;
    const epoch = accountEpoch;
    const result = await api("/api/devices");
    if (!currentAccount(epoch)) return;
    deviceListFailed = false;
    devices = result.devices;
    for (const [id, row] of deviceRows) {
        if (!devices.some((device) => device.device_id === id)) {
            row.item.remove();
            deviceRows.delete(id);
            progressSnapshot.delete(id);
        }
    }
    if (!devices.some((device) => device.device_id === repositoryDeviceId)) {
        repositoryRequest++;
        repositoryIssues.replaceChildren();
        workflowSnapshot = null;
        repositoryDeviceId = devices.length === 1 ? devices[0].device_id : null;
    }
    const selected = devices.find((device) => device.device_id === repositoryDeviceId);
    repositoryDetails.textContent = selected ? `${selected.name} (${selected.device_id})` : "";
    if (!workflowSnapshot) {
        repositoryStatus.textContent = selected
            ? "ワークフローを更新して端末の報告したリポジトリを確認してください。"
            : "端末を選択してIssue → Linear → PRを確認してください。";
    }
    deviceSummary.textContent = devices.length ? "端末を選択してください。" : "ペアリング済みの端末はありません。";
    for (const device of devices) {
        let row = deviceRows.get(device.device_id);
        if (!row) {
            row = createDeviceRow(device);
            deviceRows.set(device.device_id, row);
            deviceList.append(row.item);
        }
        row.device = device;
        row.label.textContent = `${device.name} (${device.device_id}) — ${({online:"使用可能", grace:"再接続中", offline:"使用不可", unknown:"状態確認中"})[device.terminal_status] || "状態確認中"}`;
        row.repository.textContent = device.repository
            ? `最終報告リポジトリ: ${device.repository.owner}/${device.repository.name}`
            : "GitHubリポジトリは未取得です。GitHubのチェックアウトで最新の orield を起動してください。";
        row.open.disabled = busy || deviceListFailed || device.terminal_status !== "online";
        row.work.disabled = busy;
    }
    renderProgressCards();
    if (pairClaimed && pairInfo && pairOwner?.id === user.id && devices.some((device) => device.device_id === pairInfo.device_id)) {
        pairing.token = null;
        pairStatus.textContent = "端末側の承認でペアリングが完了しました。接続状態は端末一覧で確認できます。";
    } else if (pairClaimed && pairInfo && pairing.token && pairOwner?.id === user.id && Date.now() >= pairInfo.expires_at * 1000) {
        pairing.token = null;
        pairStatus.textContent = "期限までにペアリングが確認できなかったか、端末側で取り消されました。端末でやり直してください。";
    }
}

async function inspectPair() {
    if (!pairing.token || !user) return;
    if (pairClaimed) {
        await waitForPair();
        return;
    }
    const ownerId = user.id;
    const inspected = await api("/api/pair/inspect", {token: pairing.token});
    if (user?.id !== ownerId) return;
    pairInfo = inspected;
    pairDetails.textContent = `${pairInfo.name} (${pairInfo.device_id})`;
    pairStatus.textContent = "自分の端末だけを承認してください。承認後、端末側でアカウントを確認するまで端末アクセスは許可されません。";
    approvePair.hidden = false;
    render();
}

async function claimPair() {
    const owner = user;
    await api("/api/pair/claim", {token: pairing.token});
    pairClaimed = true;
    pairOwner = owner;
    approvePair.hidden = true;
    pairStatus.textContent = "端末側の承認を待っています。端末でアカウント名とIDを確認してください。このタブを開いたままにしてください。";
    await waitForPair();
}

async function waitForPair() {
    if (!user || !pairing.token || !pairClaimed) return;
    if (user.id !== pairOwner.id) {
        pairStatus.textContent = `このペアリングは ${pairOwner.display_name} (${pairOwner.id}) で承認済みです。同じアカウントでログインするか、端末でやり直してください。`;
        return;
    }
    pairStatus.textContent = "端末側の承認を待っています。端末でアカウント名とIDを確認してください。このタブを開いたままにしてください。";
    const epoch = accountEpoch;
    try {
        await refreshDevices();
        // The shared device refresh loop checks registration and pairing expiry.
    } catch (error) {
        if (!currentAccount(epoch)) return;
        pairStatus.textContent = errorText(error) + " 端末を更新して再確認してください。";
    }
}

function currentAccount(epoch) {
    return !!user && accountEpoch === epoch;
}

async function integrationApi(path, body) {
    const epoch = accountEpoch;
    try {
        return await api(path, body);
    } catch (error) {
        if (!currentAccount(epoch) && !error.sessionExpired) return null;
        throw error;
    }
}

async function refreshAccountData() {
    const results = await Promise.allSettled([
        refreshIntegrations(),
        (async () => {
            await refreshDevices();
            await inspectPair();
        })(),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    await refreshWorkflow();
    if (failure) throw failure.reason;
}

async function refreshIntegrations() {
    if (!user) return;
    const epoch = accountEpoch;
    const request = ++integrationsRequest;
    const result = await integrationApi("/api/integrations");
    if (!currentAccount(epoch) || request !== integrationsRequest) return;
    integrations = result;
    issuesRequest++;
    repositoryRequest++;
    repositoryIssues.replaceChildren();
    workflowSnapshot = null;
    for (const provider of providers) {
        const controls = providerControls[provider];
        controls.select.replaceChildren();
        controls.issues.replaceChildren();
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = provider === "github" ? "リポジトリを選択" : "チームを選択";
        controls.select.append(placeholder);
        for (const [index, target] of (result.choices?.[provider] ?? []).entries()) {
            const option = document.createElement("option");
            option.value = String(index);
            option.textContent = provider === "github"
                ? `${target.owner}/${target.name} (installation ${target.installation_id})`
                : `${target.team_name} (workspace ${target.workspace_id})`;
            controls.select.append(option);
        }
    }
    issuesStatus.textContent = result.github || result.linear
        ? "最近のIssueを読み込み中…"
        : "リポジトリまたはチームを保存すると最近のIssueを確認できます。";
    render();
    await refreshIssues();
}

async function startConnection(provider) {
    const epoch = accountEpoch;
    const result = await integrationApi(`/api/integrations/${provider}/start`, {});
    if (!currentAccount(epoch)) return;
    const url = new URL(result.url);
    const expected = provider === "github"
        ? "https://github.com/login/oauth/authorize" : "https://linear.app/oauth/authorize";
    if (url.origin + url.pathname !== expected || url.username || url.password) {
        throw new Error("サービスから無効な認可URLが返されました。");
    }
    location.assign(url.href);
}

async function saveTarget(provider) {
    const value = providerControls[provider].select.value;
    const target = value === "" ? null : integrations?.choices?.[provider]?.[Number(value)];
    if (!target) throw new Error("保存前に連携先を選択してください。");
    const epoch = accountEpoch;
    const body = provider === "github"
        ? {installation_id: target.installation_id, repository_id: target.repository_id}
        : {team_id: target.team_id};
    await integrationApi(`/api/integrations/${provider}/select`, body);
    if (!currentAccount(epoch)) return;
    integrations[provider] = target;
    clearProviderSelection(provider);
    integrationNotice = `${providerNames[provider]} target saved. This connection is shared by all devices paired to your account.`;
    try {
        await refreshIntegrations();
    } finally {
        if (currentAccount(epoch)) await refreshWorkflow();
    }
}

async function disconnectProvider(provider) {
    const epoch = accountEpoch;
    const result = await integrationApi(`/api/integrations/${provider}/disconnect`, {});
    if (!currentAccount(epoch)) return;
    integrations[provider] = null;
    clearProviderSelection(provider);
    integrationNotice = `${providerNames[provider]} disconnected. New access is blocked.`;
    if (!result.revoked) {
        integrationNotice += ` Remote authorization could not be revoked. Revoke access in your ${providerNames[provider]} account settings.`;
    }
    if (provider === "github") {
        integrationNotice += " Previously issued GitHub installation tokens may remain valid until expiry (up to 1 hour).";
    }
    try {
        await refreshIntegrations();
    } finally {
        if (currentAccount(epoch)) await refreshWorkflow();
    }
}

function clearProviderSelection(provider) {
    integrations.choices[provider] = [];
    providerControls[provider].select.replaceChildren();
    providerControls[provider].issues.replaceChildren();
    issuesRequest++;
    repositoryRequest++;
    workflowSnapshot = null;
    repositoryIssues.replaceChildren();
    repositoryStatus.textContent = "ワークフローを更新して現在の連携先を確認してください。";
    issuesStatus.textContent = "最近のIssueを更新 to load the current targets.";
    render();
}

async function refreshIssues() {
    if (!user || (!integrations?.github && !integrations?.linear)) return;
    const epoch = accountEpoch;
    const request = ++issuesRequest;
    for (const controls of Object.values(providerControls)) controls.issues.replaceChildren();
    issuesStatus.textContent = "最近のIssueを読み込み中…";
    try {
        const result = await integrationApi("/api/integrations/issues");
        if (!currentAccount(epoch) || request !== issuesRequest) return;
        for (const provider of providers) {
            const list = providerControls[provider].issues;
            const connection = result[provider];
            if (!connection) continue;
            const target = provider === "github" ? connection.repository : connection.team;
            const heading = document.createElement("li");
            heading.textContent = provider === "github"
                ? `${target.owner}/${target.name}の最近のIssue:`
                : `${target.team_name}の最近のIssue:`;
            list.append(heading);
            for (const issue of connection.issues) {
                const item = document.createElement("li");
                item.textContent = `${provider === "github" ? '#' + issue.number : issue.identifier}: ${issue.title}`;
                list.append(item);
            }
            if (!connection.issues.length) {
                const item = document.createElement("li");
                item.textContent = "最近のIssueはありません。";
                list.append(item);
            }
        }
        issuesStatus.textContent = "最近のIssueを取得しました（各サービス最大20件、GitHub PRを除く）。";
    } catch (error) {
        if (error.sessionExpired) throw error;
        if (!currentAccount(epoch) || request !== issuesRequest) return;
        issuesStatus.textContent = `最近のIssueを取得できません: ${errorText(error)}`;
        throw error;
    }
}

function issueLink(label, address, host) {
    const url = new URL(address);
    if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password || url.port) {
        throw new Error("サービスから無効なIssue URLが返されました。");
    }
    const link = document.createElement("a");
    link.textContent = label;
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
}

function appendDescription(item, label, text) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = label;
    const description = document.createElement("p");
    description.className = "how-description";
    description.textContent = text || "本文はありません。";
    details.append(summary, description);
    item.append(details);
}

async function refreshWorkflow() {
    const device = devices.find((device) => device.device_id === repositoryDeviceId);
    if (!user || !device) return;
    const epoch = accountEpoch;
    const request = ++repositoryRequest;
    repositoryDetails.textContent = `${device.name} (${device.device_id})`;
    repositoryStatus.textContent = "Issue → Linear → PRの状態を読み込み中…";
    try {
        const result = await integrationApi(`/api/workflows/${device.device_id}`);
        if (!currentAccount(epoch) || request !== repositoryRequest || repositoryDeviceId !== device.device_id) return;
        workflowSnapshot = result;
        device.repository = result.repository;
        const label = `${result.repository.owner}/${result.repository.name}`;
        document.getElementById(`repository-${device.device_id}`).textContent = `最終報告リポジトリ: ${label}`;
        repositoryDetails.textContent += ` — ${label} → ${result.team.team_name}`;
        const items = document.createDocumentFragment();
        const progress = progressSnapshot.get(device.device_id);
        const runnerDisconnected = progressStream === "live" && (!progress || progress.state === "offline");
        const progressUnavailable = progressStream !== "live";
        for (const row of result.workflows) {
            const item = document.createElement("li");
            const title = document.createElement("p");
            title.append(issueLink(`#${row.issue.number}`, row.issue.url, "github.com"), `: ${row.issue.title}`);
            const phase = document.createElement("p");
            phase.textContent = `${workflowPhaseLabel(row.phase)}${row.blocked_reason ? ` ${row.blocked_reason}` : ""}`;
            item.append(title, phase);
            if (runnerDisconnected && ["approved", "running"].includes(row.phase)) {
                const recovery = document.createElement("p");
                recovery.textContent = "runnerが未接続です。端末のチェックアウトで orield workflow を実行してください。再開前に承認を再確認します。";
                item.append(recovery);
            } else if (progressUnavailable && ["approved", "running"].includes(row.phase)) {
                const recovery = document.createElement("p");
                recovery.textContent = "実行状況を取得できず、runnerの接続は未確認です。runnerは再開前に承認を再確認します。";
                item.append(recovery);
            }
            appendDescription(item, "WHAT（GitHub Issue本文）", row.issue.body);
            if (row.linear) {
                const how = document.createElement("p");
                how.append("Linear HOW: ", issueLink(row.linear.identifier, row.linear.url, "linear.app"),
                    `: ${row.linear.title} — ${row.linear.state.name} (${row.linear.state.type})`);
                item.append(how);
                appendDescription(item, "HOW（Linear本文）", row.linear.description);
            }
            if (row.branch) {
                const branch = document.createElement("p");
                branch.textContent = `対象ブランチ: ${row.branch}`;
                item.append(branch);
            }
            if (row.pull_request) {
                const pull = document.createElement("p");
                pull.append(issueLink(`PR #${row.pull_request.number}`, row.pull_request.url, "github.com"),
                    row.pull_request.merged ? " — マージ済み" : ` — ${row.pull_request.state}${row.pull_request.draft ? "（下書き）" : ""}`);
                item.append(pull);
            }
            if (row.how_feedback) appendDescription(item, "HOW修正依頼", row.how_feedback.body);
            if (row.feedback) {
                const feedback = [row.feedback.body, ...row.feedback.comments.map((comment) =>
                    `${comment.path ? `${comment.path}${comment.line == null ? "" : `:${comment.line}`}: ` : ""}${comment.body}`)];
                appendDescription(item, `PRフィードバック（${row.feedback.kind}）`, feedback.join("\n\n"));
            }
            items.append(item);
        }
        repositoryIssues.replaceChildren(items);
        const configuration = result.configuration;
        const gate = configuration.error
            ? `コード実行不可: ${configuration.error} HOWの計画は引き続き利用できます。`
            : configuration.autonomous
                ? `コード実行にはTodo承認と設定済みの検証コマンド${configuration.verification.length}件が必要です。`
                : "コード実行不可: 対象ブランチに autonomous: true が設定されていません。";
        repositoryStatus.textContent = `${result.workflows.length ? `ワークフロー${result.workflows.length}件。` : "ワークフローはありません。WHATを作成するかGitHubでIssueを開いてください。"} ${gate}`;
        render();
    } catch (error) {
        if (error.sessionExpired) throw error;
        if (!currentAccount(epoch) || request !== repositoryRequest || repositoryDeviceId !== device.device_id) return;
        workflowSnapshot = null;
        repositoryIssues.replaceChildren();
        const message = errorText(error);
        repositoryStatus.textContent = message.includes("provider state could not be confirmed")
            ? `現在の連携先状態を確認できません。ワークフロー操作は承認されていません。後で再試行してください。連携の失効が表示された場合は再連携してください。${message}`
            : `ワークフローを取得できません: ${message}`;
        render();
        throw error;
    }
}

async function createWhat() {
    if (!user || !repositoryDeviceId || !workflowSnapshot) return;
    const epoch = accountEpoch;
    const deviceId = repositoryDeviceId;
    const title = whatTitle.value.trim();
    const body = whatBody.value;
    if (!title) throw new Error("WHATのタイトルを入力してください。");
    if (!pendingWhat || pendingWhat.deviceId !== deviceId || pendingWhat.title !== title || pendingWhat.body !== body) {
        pendingWhat = {deviceId, title, body, requestId: crypto.randomUUID()};
    }
    const result = await integrationApi(`/api/workflows/${deviceId}/issues`, {
        title, body, request_id: pendingWhat.requestId,
    });
    if (!currentAccount(epoch) || repositoryDeviceId !== deviceId) return;
    pendingWhat = null;
    whatTitle.value = "";
    whatBody.value = "";
    status.textContent = `GitHub WHAT #${result.issue.number} を作成しました。チェックアウトで orield workflow を実行してHOWを提案してください。`;
    await refreshWorkflow();
}

function sendResize() {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(`resize:${terminal.cols}:${terminal.rows}`);
    }
}

async function openTerminal(device) {
    const epoch = accountEpoch;
    await refreshDevices();
    if (!currentAccount(epoch) || deviceListFailed || devices.find(d => d.device_id === device.device_id)?.terminal_status !== "online") throw new Error("端末が使用不可か、接続状態を確認できません。");
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    if (location.protocol !== "https:" && !(location.protocol === "http:" && loopback)) {
        throw new Error("端末接続にはHTTPS（またはループバックHTTP）が必要です。");
    }
    if (!terminal) {
        const [{Terminal}, {FitAddon}] = await Promise.all([
            import("https://esm.sh/@xterm/xterm@6.0.0"),
            import("https://esm.sh/@xterm/addon-fit@0.11.0"),
        ]);
        terminal = new Terminal({
            cursorBlink: true,
            convertEol: false,
            scrollback: 10000,
            fontFamily: '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace',
            fontSize: 14,
        });
        fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(container);
        terminal.onData((data) => {
            if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
        });
        terminal.onBinary((data) => {
            if (socket?.readyState === WebSocket.OPEN) {
                socket.send(Uint8Array.from(data, (character) => character.charCodeAt(0)));
            }
        });
        new ResizeObserver(() => {
            if (terminalView.hidden) return;
            fit.fit();
            sendResize();
        }).observe(container);
    }
    disconnect();
    terminal.reset();
    const url = new URL(`/device/${device.device_id}/client`, location.origin);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const connection = new WebSocket(url, "oriel-client");
    socket = connection;
    connection.binaryType = "arraybuffer";
    status.textContent = `${device.name}に接続中…`;
    let failed = false;
    connection.addEventListener("open", () => {
        if (socket !== connection) return;
        dashboard.hidden = true;
        terminalView.hidden = false;
        terminalTitle.textContent = `${device.name} (${device.device_id})`;
        status.textContent = "";
        fit.fit();
        sendResize();
        terminal.focus();
    });
    connection.addEventListener("message", async (event) => {
        if (socket !== connection) return;
        if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data));
        else if (event.data instanceof Blob) {
            const bytes = new Uint8Array(await event.data.arrayBuffer());
            if (socket === connection) terminal.write(bytes);
        } else if (typeof event.data === "string") terminal.write(event.data);
    });
    connection.addEventListener("error", () => {
        failed = true;
    });
    connection.addEventListener("close", async (event) => {
        if (socket !== connection) return;
        disconnect();
        status.textContent = failed
            ? "接続に失敗しました。端末のオフライン、セッション失効、アクセス拒否を確認してください。"
            : `切断されました（${event.code}）: ${event.reason || "端末を開き直して再接続してください。"}`;
        const ownerId = user?.id;
        try {
            const result = await api("/api/session");
            if (!socket && user?.id === ownerId) {
                setUser(result.user);
                if (!result.user) status.textContent = "セッションが失効しました。再度ログインしてください。";
            }
        } catch (error) {
            if (!socket && user?.id === ownerId) status.textContent = errorText(error);
        }
    });
}

document.getElementById("register").addEventListener("click", () => perform(() => authenticate("register")));
document.getElementById("login").addEventListener("click", () => perform(() => authenticate("login")));
document.getElementById("backup").addEventListener("click", () => perform(() => authenticate("register")));
document.getElementById("logout").addEventListener("click", () => perform(async () => {
    stopProgress();
    progressStatus.textContent = "ログアウト中…";
    try {
        await api("/api/auth/logout", {});
        setUser(null);
        status.textContent = "ログアウトしました。";
    } catch (error) {
        connectProgress();
        throw error;
    }
}));
document.getElementById("refresh").addEventListener("click", () => perform(async () => {
    setUser((await api("/api/session")).user);
    await refreshAccountData();
}));
approvePair.addEventListener("click", () => perform(claimPair));
for (const provider of providers) {
    const controls = providerControls[provider];
    controls.connect.addEventListener("click", () => perform(() => startConnection(provider)));
    controls.save.addEventListener("click", () => perform(() => saveTarget(provider)));
    controls.disconnect.addEventListener("click", () => perform(() => disconnectProvider(provider)));
    controls.select.addEventListener("change", render);
}
refreshIssuesButton.addEventListener("click", () => perform(refreshIssues));
refreshRepositoryButton.addEventListener("click", () => perform(refreshWorkflow));
whatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    perform(createWhat);
});
document.getElementById("close-terminal").addEventListener("click", () => {
    disconnect();
    status.textContent = "端末を閉じました。ペアリングは維持されます。";
});
window.addEventListener("offline", staleProgress);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden && progressStream === "live" && Date.now() - progressReceivedAt >= 60000) staleProgress();
});
setInterval(async () => {
    if (!user || busy || workflowRefreshing || !repositoryDeviceId || dashboard.hidden || document.hidden) return;
    const epoch = accountEpoch;
    workflowRefreshing = true;
    try {
        await refreshWorkflow();
    } catch (error) {
        if (currentAccount(epoch)) status.textContent = errorText(error);
    } finally {
        workflowRefreshing = false;
    }
}, 15000);

function scheduleDevices() {
    clearTimeout(deviceTimer);
    const epoch = accountEpoch;
    deviceTimer = setTimeout(async () => {
        try { await refreshDevices(); } catch (_) {}
        if (currentAccount(epoch)) scheduleDevices();
    }, 5000);
}
render();
perform(async () => {
    try {
        setUser((await api("/api/session")).user);
    } finally {
        sessionLoading = false;
        render();
    }
    await refreshAccountData();
});

let currentPage = "overview";
const pageNames = {overview: "概要", workflow: "ワークフロー", devices: "端末", settings: "設定"};
function showPage(page, focus = true) {
    if (!Object.hasOwn(pageNames, page)) return;
    currentPage = page;
    for (const region of dashboard.querySelectorAll("[data-region]")) {
        region.classList.toggle("page-hidden", region.dataset.region !== page);
    }
    for (const button of dashboard.querySelectorAll("[data-page]")) {
        if (button.dataset.page === page) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
    }
    const heading = document.getElementById("page-title");
    heading.textContent = pageNames[page];
    if (focus) heading.focus();
    renderOverview();
}
function workflowPhaseLabel(phase) {
    const phases = {
            "waiting-how": "GitHub Issueで /oriel に質問するか、/oriel how で計画を依頼してください。実装はLinear Todoで承認します。",
            "needs-how": "Linear TriageへのHOW提案を待っています。",
            triage: "LinearでHOWを確認・編集し、Todoへ移動して実装を承認してください。",
            approved: "承認済みです。daemonの実装開始を待っています。",
            running: "実装中です。daemonは承認済みの対象ブランチを再開します。",
            review: "GitHubでPRをレビューし、マージしてください。",
            merged: "PRはマージ済みです。Linear Doneへの反映を待っています。",
            done: "PRのマージとLinear Doneを確認しました。",
            closed: "管理対象のマージは未確認のまま終了しました。自動実行は行いません。",
            blocked: "ワークフローがブロックされています。",
        };
    return phases[phase] || "状態未取得";
}

function renderOverview() {
    if (sessionLoading) {
        document.getElementById("overview-target").textContent = "ログイン状態を確認中…";
        document.getElementById("overview-progress").textContent = "runner: 未確認";
        document.getElementById("overview-next").textContent = "ログイン状態の確認が終わるまでお待ちください。";
        document.getElementById("overview-action").textContent = "確認中…";
        return;
    }
    const selected = devices.find(device => device.device_id === repositoryDeviceId);
    const progress = selected && progressSnapshot.get(selected.device_id);
    document.getElementById("overview-target").textContent = selected
        ? `${selected.name} — ${selected.repository ? `${selected.repository.owner}/${selected.repository.name}` : "リポジトリ未取得"} / 端末: ${deviceListFailed ? "状態確認失敗" : ({online:"使用可能",grace:"再接続中",offline:"使用不可"})[selected.terminal_status] || "未取得"}`
        : "端末が選択されていません。";
    document.getElementById("overview-progress").textContent = progressStream === "live" && progress
        ? `runner: ${({offline:"未接続",idle:"待機中",running:"実行中",paused:"一時停止",blocked:"ブロック中"})[progress.state] || "状態未取得"} / ${progressStages[progress.stage] || "段階未取得"}`
        : "runner: 未確認（実行状況を取得できていません）";
    const nextWorkflow = workflowSnapshot?.workflows?.find(row => !["done", "closed"].includes(row.phase));
    document.getElementById("overview-next").textContent = !user ? "Passkeyでログインしてください。"
        : deviceListFailed ? "端末の状態を取得できません。設定からアカウントと端末を更新してください。"
        : !devices.length ? "端末でペアリングを開始してください。"
        : !selected ? "端末一覧からワークフローの対象を選択してください。"
        : nextWorkflow ? workflowPhaseLabel(nextWorkflow.phase) : "ワークフローでWHAT・HOW・PRと次の操作を確認してください。";
    document.getElementById("overview-action").textContent = !user ? "ログインへ" : deviceListFailed ? "設定へ" : !devices.length || !selected ? "端末一覧へ" : "ワークフローへ";
}
for (const button of dashboard.querySelectorAll("[data-page]")) {
    button.addEventListener("click", () => showPage(button.dataset.page));
}
document.getElementById("overview-action").addEventListener("click", () => {
    if (!user) document.getElementById("login").focus();
    else showPage(deviceListFailed ? "settings" : devices.length && repositoryDeviceId ? "workflow" : "devices");
});
showPage(connectionRequest.returned || connectionRequest.failed ? "settings" : "overview", false);
