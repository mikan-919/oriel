use std::{fs, path::Path};

use topcoat::{
    Result,
    context::Cx,
    view::{StaticStr, Unescaped, View, ViewExt, view},
};

const STYLE: &str = r#"
html,
body {
    width: 100%;
    height: 100%;
    margin: 0;
    background: #0c0c0c;
    color: #eee;
    font-family: sans-serif;
}

#dashboard {
    box-sizing: border-box;
    max-width: 44rem;
    padding: 1rem;
}

button {
    font: inherit;
    padding: 0.5rem;
    margin: 0.25rem;
}

button:disabled {
    color: #bdbdbd;
    background: #333;
    border-color: #666;
    cursor: not-allowed;
}

select,
input,
textarea {
    box-sizing: border-box;
    max-width: 100%;
    font: inherit;
    padding: 0.5rem;
}

input,
textarea {
    display: block;
    width: 100%;
}

fieldset {
    min-width: 0;
    margin-block: 1rem;
}

label {
    display: block;
    margin-top: 0.5rem;
}

p,
li {
    overflow-wrap: anywhere;
}

a {
    color: #8ab4f8;
}

#devices {
    padding: 0;
    list-style: none;
}

#devices > li {
    border: 1px solid #666;
    border-radius: 0.5rem;
    padding: 0.75rem;
    margin-block: 0.75rem;
    min-width: 0;
}

#devices h3 {
    margin-block: 0 0.5rem;
    overflow-wrap: anywhere;
}

.execution-card {
    border-top: 1px solid #666;
    margin-top: 0.75rem;
}

.execution-card p {
    margin-block: 0.5rem;
}

.execution-state {
    font-weight: bold;
}

#repository-issues .how-description {
    white-space: pre-wrap;
}

#terminal-view {
    display: flex;
    flex-direction: column;
    height: 100%;
}

#terminal-toolbar {
    padding: 0.5rem;
}

#terminal {
    flex: 1;
    min-height: 0;
    width: 100%;
}

[hidden] {
    display: none !important;
}
"#;

// Capture before external modules; pairing secrets never enter storage.
const PAIR_CAPTURE_JS: &str = r#"
(() => {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const token = fragment.get("pair");
    window.orielPairing = {
        token: /^[0-9a-f]{64}$/.test(token ?? "") ? token : null,
        invalid: fragment.has("pair") && !/^[0-9a-f]{64}$/.test(token ?? ""),
    };
    window.orielConnection = {
        returned: ["github", "linear"].includes(fragment.get("connected")) ? fragment.get("connected") : null,
        failed: fragment.has("connection-error"),
    };
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
})();
"#;

const TERMINAL_JS: &str = r#"
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
    ? `${providerNames[connectionRequest.returned]} authorization succeeded. Choose a repository or team below and save the target to finish connecting.`
    : connectionRequest.failed
        ? "Service authorization failed or was declined. Try connecting again below."
        : "";
const terminalView = document.getElementById("terminal-view");
const terminalTitle = document.getElementById("terminal-title");
const container = document.getElementById("terminal");
let user = null;
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
    idle: "Idle", discovering: "Discovering", preparing: "Preparing",
    planning: "Planning", implementing: "Implementing", reviewing: "Reviewing",
    verifying: "Verifying", integrating: "Integrating", pushing: "Pushing",
    publishing: "Publishing", reconciling: "Reconciling", paused: "Paused",
};
const encoder = new TextEncoder();

function render() {
    account.textContent = user ? `Signed in as ${user.display_name} (${user.id})` : "Not signed in.";
    anonymousActions.hidden = !!user;
    sessionActions.hidden = !user;
    for (const button of dashboard.querySelectorAll("button")) button.disabled = busy;
    for (const row of deviceRows.values()) row.open.disabled = busy || deviceListFailed || row.device.terminal_status !== "online";
    approvePair.disabled = busy || !user || !pairInfo || pairClaimed;
    pairSection.hidden = !pairing.token && !pairing.invalid && !pairInfo;
    if (pairing.invalid) {
        pairStatus.textContent = "Invalid pairing link. Restart pairing on the device.";
    } else if (pairing.token && !user) {
        pairStatus.textContent = "Sign in or create an account to review this device. Keep this tab open; reloading discards the pairing link.";
    }
    integrationSection.hidden = !user && !integrationNotice;
    integrationActions.hidden = !user;
    integrationStatus.textContent = integrationNotice + (!user && integrationNotice ? " Sign in to manage your account connections." : "");
    for (const provider of providers) {
        const controls = providerControls[provider];
        const target = integrations?.[provider];
        const choices = integrations?.choices?.[provider] ?? [];
        const attempt = integrations?.authorization?.[provider];
        let explanation = "";
        if (attempt?.status === "failed") {
            const code = attempt.error;
            if (code === "incorrect_client_credentials" || code === "invalid_client") {
                explanation = `${providerNames[provider]} rejected the app credentials. Check the Client ID and its matching Client secret in Relay.`;
            } else if (code === "app_actor_required") {
                explanation = "Reconnect Linear and authorize the Oriel app as a workspace administrator.";
            } else if (attempt.step === "targets") {
                explanation = `${providerNames[provider]} authorization succeeded, but reading available targets failed (${code || "details unavailable"}).`;
            } else {
                explanation = `${providerNames[provider]} authorization failed${attempt.step ? ` during ${attempt.step}` : ""}${code ? ` (${code})` : ""}.`;
            }
        } else if (attempt?.status === "ready" && !target) {
            explanation = choices.length
                ? `Authorization succeeded. Choose a ${provider === "github" ? "repository" : "team"} below and save the target.`
                : provider === "github"
                    ? "Authorization succeeded, but no repository is available to this GitHub account for the configured App. Check that account's access to the installed App."
                    : "Authorization succeeded, but no team is available to this Linear account.";
        } else if (attempt?.status === "interrupted") {
            explanation = "Authorization was interrupted. Connect again to restart it.";
        } else if (attempt && !target) {
            explanation = "Authorization has not completed. Connect again to restart it.";
        }
        controls.authorization.textContent = explanation;
        controls.authorization.hidden = !explanation;
        controls.details.textContent = target
            ? provider === "github"
                ? `Connected to ${target.owner}/${target.name} (repository ${target.repository_id}, installation ${target.installation_id}).`
                : `Connected to ${target.team_name} (team ${target.team_id}, workspace ${target.workspace_id}). ` +
                    (target.agent ? `In Linear Triage comments, type @ and choose ${target.agent.name} to discuss the HOW.`
                        : "Reconnect Linear to enable Oriel in the mention picker; workspace administrator approval is required.")
            : integrations ? "No target connected." : busy ? "Loading connection…" : "Connection status unavailable. Refresh account to try again.";
        controls.connect.textContent = target ? `Reconnect ${providerNames[provider]}` : `Connect ${providerNames[provider]}`;
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
    const connection = socket;
    socket = undefined;
    connection?.close();
    terminalView.hidden = true;
    dashboard.hidden = false;
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
        deviceSummary.textContent = next ? "Loading owned devices…" : "Sign in to see your devices.";
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
            throw Object.assign(new Error("Your session expired or is not signed in. Sign in again."), {sessionExpired});
        }
        throw new Error(data.error || data.message || `Request rejected (${response.status}).`);
    }
    return data;
}

function errorText(error) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") {
        return "Passkey request cancelled, timed out, or not allowed. No sign-in or registration was completed.";
    }
    if (error.name === "InvalidStateError") {
        return "This Passkey is already registered. Choose a different authenticator for a backup.";
    }
    return error.message || "The request failed.";
}

async function perform(action) {
    if (busy) return;
    busy = true;
    status.textContent = "";
    render();
    try {
        await action();
    } catch (error) {
        status.textContent = errorText(error);
    } finally {
        busy = false;
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
        throw new Error("Passkeys require a supported browser on HTTPS (or loopback HTTP).");
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
    if (!credential) throw new Error("No Passkey was selected. Nothing was completed.");
    const result = await api(`/api/auth/${kind}/verify`, {credential: credentialJSON(credential)});
    setUser(result.user);
    status.textContent = backup ? "Backup Passkey added to this account." : "Signed in.";
    await refreshAccountData();
}

function setProgressStream(state) {
    progressStream = state;
    const message = {
        "signed-out": "Sign in to see live execution.",
        connecting: "Connecting to live execution… Execution is not yet confirmed.",
        live: "Live execution connected. This is read-only; Todo approval and PR merge remain human decisions.",
        stale: "Live execution stream is stale or unavailable. Last reported activity is not confirmed; reconnecting while signed in.",
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
    for (const [id, row] of deviceRows) {
        const progress = progressSnapshot.get(id);
        const stale = progressStream !== "live";
        const stage = progressStages[progress?.stage] || progress?.stage || "Stage unavailable";
        const state = progress ? `${progress.state[0].toUpperCase()}${progress.state.slice(1)}` : "Waiting for snapshot";
        const detail = progress?.state === "offline" ? " — workflow runner not connected; run orield workflow on this device to resume approved work"
            : progress?.state === "idle" ? " — waiting for work"
            : progress ? ` — ${stage}` : "";
        const label = stale ? `Stale stream — ${progress ? `last reported ${state}${detail}; execution not confirmed` : "execution not confirmed"}`
            : `${state}${detail}`;
        row.card.dataset.state = stale ? "stale" : progress?.state || "unknown";
        if (row.state.textContent !== label) row.state.textContent = label;
        const task = progress?.task;
        updateProgressLink(row.whatLink, task ? `#${task.issue_number}: ${task.title}` : "", task?.url, "github.com");
        row.whatEmpty.textContent = task ? (row.whatLink.hidden ? `#${task.issue_number}: ${task.title} (link unavailable)` : "")
            : "None reported.";
        updateProgressLink(row.howLink, task?.how_identifier || "Open Linear HOW", task?.how_url, "linear.app");
        row.howEmpty.textContent = row.howLink.hidden ? task?.how_identifier || "None reported." : "";
        const repository = task?.repository || (row.device.repository
            ? `${row.device.repository.owner}/${row.device.repository.name}` : "Not reported.");
        row.progressRepository.textContent = `Repository: ${repository}`;
        const updated = progress?.updated_at ? new Date(progress.updated_at) : null;
        if (updated && !Number.isNaN(updated.getTime())) {
            row.updated.dateTime = updated.toISOString();
            row.updated.textContent = updated.toLocaleString();
        } else {
            row.updated.removeAttribute("datetime");
            row.updated.textContent = "Not reported.";
        }
    }
}

function createDeviceRow(device) {
    const item = document.createElement("li");
    item.id = `device-${device.device_id}`;
    const label = document.createElement("h3");
    const repository = document.createElement("p");
    repository.id = `repository-${device.device_id}`;
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open terminal";
    open.title = "Disconnected input is not replayed. PTYs are not restored after host restart.";
    const work = document.createElement("button");
    work.type = "button";
    work.textContent = "Open workflow";
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
    updatedLine.append("Updated: ", updated);
    card.append(state, what, how, progressRepository, updatedLine);
    item.append(label, repository, open, work, card);
    const row = {device, item, label, repository, open, work, card, state, whatLink, whatEmpty, howLink, howEmpty, progressRepository, updated};
    open.addEventListener("click", () => perform(() => openTerminal(row.device)));
    work.addEventListener("click", () => perform(async () => {
        repositoryDeviceId = row.device.device_id;
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
            ? "Refresh the workflow to read this device's reported repository."
            : "Choose a device to view its Issue → Linear → PR workflow.";
    }
    deviceSummary.textContent = devices.length ? "Open an owned device:" : "No paired devices yet.";
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
            ? `Last reported repository: ${device.repository.owner}/${device.repository.name}`
            : "No GitHub repository reported. Start the updated orield from a GitHub checkout.";
        row.open.disabled = busy || deviceListFailed || device.terminal_status !== "online";
        row.work.disabled = busy;
    }
    renderProgressCards();
    if (pairClaimed && pairInfo && pairOwner?.id === user.id && devices.some((device) => device.device_id === pairInfo.device_id)) {
        pairing.token = null;
        pairStatus.textContent = "Device paired after local approval. Terminal availability is shown in the device list.";
    } else if (pairClaimed && pairInfo && pairing.token && pairOwner?.id === user.id && Date.now() >= pairInfo.expires_at * 1000) {
        pairing.token = null;
        pairStatus.textContent = "Pairing was not confirmed before expiry or was cancelled locally. Restart pairing on the device.";
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
    pairStatus.textContent = "Only approve a device you recognize. Approval here asks the device to confirm your account locally; it does not yet grant terminal access.";
    approvePair.hidden = false;
    render();
}

async function claimPair() {
    const owner = user;
    await api("/api/pair/claim", {token: pairing.token});
    pairClaimed = true;
    pairOwner = owner;
    approvePair.hidden = true;
    pairStatus.textContent = "Waiting for approval on the device. Confirm the account name and ID on its local terminal. Keep this tab open.";
    await waitForPair();
}

async function waitForPair() {
    if (!user || !pairing.token || !pairClaimed) return;
    if (user.id !== pairOwner.id) {
        pairStatus.textContent = `This pairing was approved for ${pairOwner.display_name} (${pairOwner.id}). Sign in to that account or restart pairing on the device.`;
        return;
    }
    pairStatus.textContent = "Waiting for approval on the device. Confirm the account name and ID on its local terminal. Keep this tab open.";
    const epoch = accountEpoch;
    try {
        await refreshDevices();
        // The shared device refresh loop checks registration and pairing expiry.
    } catch (error) {
        if (!currentAccount(epoch)) return;
        pairStatus.textContent = errorText(error) + " Use Refresh devices to check again.";
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
        placeholder.textContent = provider === "github" ? "Choose a repository" : "Choose a team";
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
        ? "Loading recent issues…"
        : "Save a repository or team target to read its recent issues.";
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
        throw new Error("The service returned an unexpected authorization address.");
    }
    location.assign(url.href);
}

async function saveTarget(provider) {
    const value = providerControls[provider].select.value;
    const target = value === "" ? null : integrations?.choices?.[provider]?.[Number(value)];
    if (!target) throw new Error("Choose an available target before saving.");
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
    repositoryStatus.textContent = "Refresh the workflow to read the current connected targets.";
    issuesStatus.textContent = "Refresh recent issues to load the current targets.";
    render();
}

async function refreshIssues() {
    if (!user || (!integrations?.github && !integrations?.linear)) return;
    const epoch = accountEpoch;
    const request = ++issuesRequest;
    for (const controls of Object.values(providerControls)) controls.issues.replaceChildren();
    issuesStatus.textContent = "Loading recent issues…";
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
                ? `Recent issues in ${target.owner}/${target.name}:`
                : `Recent issues in ${target.team_name}:`;
            list.append(heading);
            for (const issue of connection.issues) {
                const item = document.createElement("li");
                item.textContent = `${provider === "github" ? '#' + issue.number : issue.identifier}: ${issue.title}`;
                list.append(item);
            }
            if (!connection.issues.length) {
                const item = document.createElement("li");
                item.textContent = "No recent issues.";
                list.append(item);
            }
        }
        issuesStatus.textContent = "Recent issues loaded (up to 20 per service; GitHub pull requests excluded).";
    } catch (error) {
        if (error.sessionExpired) throw error;
        if (!currentAccount(epoch) || request !== issuesRequest) return;
        issuesStatus.textContent = `Could not load recent issues: ${errorText(error)}`;
        throw error;
    }
}

function issueLink(label, address, host) {
    const url = new URL(address);
    if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password || url.port) {
        throw new Error("The service returned an unexpected issue address.");
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
    description.textContent = text || "No description.";
    details.append(summary, description);
    item.append(details);
}

async function refreshWorkflow() {
    const device = devices.find((device) => device.device_id === repositoryDeviceId);
    if (!user || !device) return;
    const epoch = accountEpoch;
    const request = ++repositoryRequest;
    repositoryDetails.textContent = `${device.name} (${device.device_id})`;
    repositoryStatus.textContent = "Loading current Issue → Linear → PR state…";
    try {
        const result = await integrationApi(`/api/workflows/${device.device_id}`);
        if (!currentAccount(epoch) || request !== repositoryRequest || repositoryDeviceId !== device.device_id) return;
        workflowSnapshot = result;
        device.repository = result.repository;
        const label = `${result.repository.owner}/${result.repository.name}`;
        document.getElementById(`repository-${device.device_id}`).textContent = `Last reported repository: ${label}`;
        repositoryDetails.textContent += ` — ${label} → ${result.team.team_name}`;
        const items = document.createDocumentFragment();
        const phases = {
            "waiting-how": "To request HOW planning, a human GitHub user must post a comment containing only /oriel how. Implementation requires later approval in Linear Todo.",
            "needs-how": "Waiting for the daemon to propose HOW in Linear Triage.",
            triage: "Review or edit HOW in Linear. Move it to Todo to approve execution.",
            approved: "Human-approved; waiting for the daemon to begin implementation.",
            running: "In Progress. The daemon resumes only the matching approved branch.",
            review: "Review the PR on GitHub. Human merge is the final approval.",
            merged: "PR merged; waiting for the daemon to reflect Linear Done.",
            done: "PR merged and Linear Done confirmed.",
            closed: "Closed without a confirmed managed merge; no autonomous execution.",
            blocked: "Workflow blocked.",
        };
        const progress = progressSnapshot.get(device.device_id);
        const runnerDisconnected = progressStream === "live" && (!progress || progress.state === "offline");
        const progressUnavailable = progressStream !== "live";
        for (const row of result.workflows) {
            const item = document.createElement("li");
            const title = document.createElement("p");
            title.append(issueLink(`#${row.issue.number}`, row.issue.url, "github.com"), `: ${row.issue.title}`);
            const phase = document.createElement("p");
            phase.textContent = `${phases[row.phase]}${row.blocked_reason ? ` ${row.blocked_reason}` : ""}`;
            item.append(title, phase);
            if (runnerDisconnected && ["approved", "running"].includes(row.phase)) {
                const recovery = document.createElement("p");
                recovery.textContent = "The workflow runner is not connected. Run orield workflow in this device's checkout to resume; it rechecks the current approval before continuing the matching branch.";
                item.append(recovery);
            } else if (progressUnavailable && ["approved", "running"].includes(row.phase)) {
                const recovery = document.createElement("p");
                recovery.textContent = "Live progress is unavailable, so this page cannot confirm whether the workflow runner is connected. The runner rechecks approval before continuing work.";
                item.append(recovery);
            }
            appendDescription(item, "WHAT (GitHub issue description)", row.issue.body);
            if (row.linear) {
                const how = document.createElement("p");
                how.append("Linear HOW: ", issueLink(row.linear.identifier, row.linear.url, "linear.app"),
                    `: ${row.linear.title} — ${row.linear.state.name} (${row.linear.state.type})`);
                item.append(how);
                appendDescription(item, "HOW (Linear description)", row.linear.description);
            }
            if (row.branch) {
                const branch = document.createElement("p");
                branch.textContent = `Canonical branch: ${row.branch}`;
                item.append(branch);
            }
            if (row.pull_request) {
                const pull = document.createElement("p");
                pull.append(issueLink(`PR #${row.pull_request.number}`, row.pull_request.url, "github.com"),
                    row.pull_request.merged ? " — merged" : ` — ${row.pull_request.state}${row.pull_request.draft ? " (draft)" : ""}`);
                item.append(pull);
            }
            if (row.how_feedback) appendDescription(item, "HOW refinement request", row.how_feedback.body);
            if (row.feedback) {
                const feedback = [row.feedback.body, ...row.feedback.comments.map((comment) =>
                    `${comment.path ? `${comment.path}${comment.line == null ? "" : `:${comment.line}`}: ` : ""}${comment.body}`)];
                appendDescription(item, `PR feedback (${row.feedback.kind})`, feedback.join("\n\n"));
            }
            items.append(item);
        }
        repositoryIssues.replaceChildren(items);
        const configuration = result.configuration;
        const gate = configuration.error
            ? `Code execution blocked: ${configuration.error} Read-only HOW planning may still run.`
            : configuration.autonomous
                ? `Code execution requires human Todo and ${configuration.verification.length} configured verification commands.`
                : "Code execution blocked: the target branch has not opted in with autonomous: true.";
        repositoryStatus.textContent = `${result.workflows.length ? `${result.workflows.length} workflows.` : "No workflows yet. Create a GitHub WHAT below or open an issue on GitHub."} ${gate}`;
        render();
    } catch (error) {
        if (error.sessionExpired) throw error;
        if (!currentAccount(epoch) || request !== repositoryRequest || repositoryDeviceId !== device.device_id) return;
        workflowSnapshot = null;
        repositoryIssues.replaceChildren();
        const message = errorText(error);
        repositoryStatus.textContent = message.includes("provider state could not be confirmed")
            ? `Could not confirm current provider state. This request did not authorize a workflow action. Retry later; reconnect only if Integrations reports an expired connection. ${message}`
            : `Could not load workflow: ${message}`;
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
    if (!title) throw new Error("A WHAT title is required.");
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
    status.textContent = `Created GitHub WHAT #${result.issue.number}. Run orield workflow in this checkout to propose HOW.`;
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
    if (!currentAccount(epoch) || deviceListFailed || devices.find(d => d.device_id === device.device_id)?.terminal_status !== "online") throw new Error("Terminal host unavailable or not confirmed");
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    if (location.protocol !== "https:" && !(location.protocol === "http:" && loopback)) {
        throw new Error("Terminal connections require HTTPS (or loopback HTTP).");
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
    status.textContent = `Connecting to ${device.name}…`;
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
            ? "Connection failed. The device may be offline, your session may have expired, or access was rejected."
            : `Disconnected (code ${event.code}): ${event.reason || "Open the device again to reconnect."}`;
        const ownerId = user?.id;
        try {
            const result = await api("/api/session");
            if (!socket && user?.id === ownerId) {
                setUser(result.user);
                if (!result.user) status.textContent = "Your session expired. Sign in again.";
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
    progressStatus.textContent = "Signing out…";
    try {
        await api("/api/auth/logout", {});
        setUser(null);
        status.textContent = "Signed out.";
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
    status.textContent = "Terminal closed. The device remains paired.";
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
    setUser((await api("/api/session")).user);
    await refreshAccountData();
});
"#;

// Build once; Cloudflare Workers Static Assets serves the generated files.
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let output = Path::new(env!("CARGO_MANIFEST_DIR")).join("build");
    let cx = Cx::default();
    let html = home(&cx).await?.single().await?.render(&cx);
    fs::create_dir_all(&output)?;
    fs::write(output.join("index.html"), html)?;
    fs::write(output.join("terminal.js"), TERMINAL_JS)?;
    println!("oriel-web assets: {}", output.display());
    Ok(())
}

async fn home(__cx: &Cx) -> Result<impl View> {
    Ok(view! {
        <!DOCTYPE html>

        <html lang="en">
            <head>
                <meta charset="utf-8">
                <script>
                    (Unescaped::new_unchecked(StaticStr(PAIR_CAPTURE_JS)))
                </script>

                <meta
                    name="viewport"
                    content="width=device-width, initial-scale=1"
                >

                <title>"Oriel"</title>

                <link
                    rel="stylesheet"
                    href="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css"
                >

                <style>
                    (Unescaped::new_unchecked(StaticStr(STYLE)))
                </style>
            </head>

            <body>
                <main id="dashboard">
                    <h1>"Oriel"</h1>
                    <p id="account">"Checking session…"</p>
                    <div id="anonymous-actions">
                        <button id="register" type="button">"Create account with Passkey"</button>
                        <button id="login" type="button">"Sign in with Passkey"</button>
                    </div>
                    <div id="session-actions" hidden="">
                        <button id="backup" type="button">"Add backup Passkey"</button>
                        <button id="logout" type="button">"Sign out"</button>
                        <button id="refresh" type="button">"Refresh account and devices"</button>
                    </div>
                    <p id="status" role="status"></p>
                    <section id="pairing" hidden="">
                        <h2>"Pair device"</h2>
                        <p id="pair-details"></p>
                        <p id="pair-status" role="status"></p>
                        <button id="approve-pair" type="button" hidden="">"Approve this device"</button>
                    </section>
                    <section id="integration" hidden="">
                        <h2>"Account integrations"</h2>
                        <p>"Connections are shared by all devices paired to your Passkey account. Choose and save targets here, independently of any device."</p>
                        <p id="integration-status" role="status"></p>
                        <div id="integration-actions" hidden="">
                            <section aria-labelledby="github-heading">
                                <h3 id="github-heading">"GitHub"</h3>
                                <p id="github-details"></p>
                                <p id="github-authorization" role="status" hidden=""></p>
                                <button id="github-connect" type="button">"Connect GitHub"</button>
                                <button id="github-disconnect" type="button">"Disconnect GitHub"</button>
                                <p>"Disconnect blocks new access. Previously issued GitHub installation tokens may remain valid until expiry (up to 1 hour)."</p>
                                <div id="github-selection" hidden="">
                                    <label for="github-target">"Available GitHub repository"</label>
                                    <select id="github-target"></select>
                                    <button id="github-save" type="button">"Save GitHub target"</button>
                                </div>
                                <ul id="github-issues" aria-label="Recent GitHub issues"></ul>
                            </section>
                            <section aria-labelledby="linear-heading">
                                <h3 id="linear-heading">"Linear"</h3>
                                <p id="linear-details"></p>
                                <p id="linear-authorization" role="status" hidden=""></p>
                                <button id="linear-connect" type="button">"Connect Linear"</button>
                                <button id="linear-disconnect" type="button">"Disconnect Linear"</button>
                                <div id="linear-selection" hidden="">
                                    <label for="linear-target">"Available Linear team"</label>
                                    <select id="linear-target"></select>
                                    <button id="linear-save" type="button">"Save Linear target"</button>
                                </div>
                                <ul id="linear-issues" aria-label="Recent Linear issues"></ul>
                            </section>
                            <button id="refresh-issues" type="button">"Refresh recent issues"</button>
                            <p id="issues-status" role="status"></p>
                        </div>
                    </section>
                    <section>
                        <h2>"Your devices"</h2>
                        <p>"Disconnected input is not replayed. Terminal processes are not restored after host restart. Open the terminal again after the device becomes available."</p>
                        <p id="device-summary">"Sign in to see your devices."</p>
                        <p id="workflow-progress-status" role="status" aria-live="polite" aria-atomic="true">"Sign in to see live execution."</p>
                        <ul id="devices"></ul>
                    </section>
                    <section id="repository-work" hidden="">
                        <h2>"Development workflow"</h2>
                        <p>"GitHub Issue = WHAT → Linear = HOW → pull request = DO. Run orield workflow in the checkout to propose HOW in Triage. The workflow runner is separate from terminal access, so a paired device can show its runner as disconnected until this command is running. Review HOW in Linear and move it to Todo to approve execution. Review and merge the PR on GitHub; only a confirmed merge is reflected as Linear Done."</p>
                        <p>"Code execution also requires an explicit .oriel.yaml opt-in and verification commands on the repository's default target branch. Formal GitHub Issue link attachments identify HOW; matching titles do not. This page never approves Todo or merges a PR."</p>
                        <p id="repository-details"></p>
                        <button id="refresh-repository" type="button">"Refresh workflow"</button>
                        <p id="repository-status" role="status"></p>
                        <form id="what-form">
                            <fieldset id="what-fields" disabled="">
                                <legend>"Create GitHub WHAT"</legend>
                                <label for="what-title">"WHAT title"</label>
                                <input id="what-title" type="text" required="" />
                                <label for="what-body">"WHAT description"</label>
                                <textarea id="what-body" rows="6"></textarea>
                                <button type="submit">"Create GitHub issue"</button>
                            </fieldset>
                        </form>
                        <ul id="repository-issues" aria-label="Issue Linear PR workflows"></ul>
                    </section>
                </main>
                <section id="terminal-view" hidden="">
                    <div id="terminal-toolbar">
                        <span id="terminal-title"></span>
                        <button id="close-terminal" type="button">"Close terminal"</button>
                    </div>
                    <div id="terminal"></div>
                </section>

                <script
                    type="module"
                    src="/terminal.js"
                ></script>
            </body>
        </html>
    })
}
