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

select {
    box-sizing: border-box;
    max-width: 100%;
    font: inherit;
    padding: 0.5rem;
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
let pairTimer;
let terminal;
let fit;
let socket;
const encoder = new TextEncoder();

function render() {
    account.textContent = user ? `Signed in as ${user.display_name} (${user.id})` : "Not signed in.";
    anonymousActions.hidden = !!user;
    sessionActions.hidden = !user;
    for (const button of dashboard.querySelectorAll("button")) button.disabled = busy;
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
                : `Connected to ${target.team_name} (team ${target.team_id}, workspace ${target.workspace_id}).`
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
        clearTimeout(pairTimer);
        accountEpoch++;
        integrationsRequest++;
        issuesRequest++;
        repositoryRequest++;
        repositoryDeviceId = null;
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
    render();
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

async function refreshDevices() {
    if (!user) return;
    const epoch = accountEpoch;
    const result = await api("/api/devices");
    if (!currentAccount(epoch)) return;
    devices = result.devices;
    deviceList.replaceChildren();
    repositoryRequest++;
    repositoryIssues.replaceChildren();
    if (!devices.some((device) => device.device_id === repositoryDeviceId)) {
        repositoryDeviceId = devices.length === 1 ? devices[0].device_id : null;
    }
    const selected = devices.find((device) => device.device_id === repositoryDeviceId);
    repositoryDetails.textContent = selected ? `${selected.name} (${selected.device_id})` : "";
    repositoryStatus.textContent = selected
        ? "Refresh linked issues to read this device's reported repository."
        : "Choose a device to read its repository-linked Linear work.";
    deviceSummary.textContent = devices.length ? "Open an owned device:" : "No paired devices yet.";
    for (const device of devices) {
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = `${device.name} (${device.device_id}) `;
        const open = document.createElement("button");
        open.type = "button";
        open.textContent = "Open terminal";
        open.disabled = busy;
        open.addEventListener("click", () => perform(() => openTerminal(device)));
        const repository = document.createElement("p");
        repository.id = `repository-${device.device_id}`;
        repository.textContent = device.repository
            ? `Last reported repository: ${device.repository.owner}/${device.repository.name}`
            : "No GitHub repository reported. Start the updated orield from a GitHub checkout.";
        const work = document.createElement("button");
        work.type = "button";
        work.textContent = "Linked Linear issues";
        work.disabled = busy;
        work.addEventListener("click", () => perform(async () => {
            repositoryDeviceId = device.device_id;
            await refreshRepositoryIssues();
        }));
        item.append(label, repository, open, work);
        deviceList.append(item);
    }
    if (pairClaimed && pairInfo && devices.some((device) => device.device_id === pairInfo.device_id)) {
        pairing.token = null;
        clearTimeout(pairTimer);
        pairStatus.textContent = "Device paired after local approval. You can now open its terminal.";
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
    clearTimeout(pairTimer);
    if (!user || !pairing.token || !pairClaimed) return;
    if (user.id !== pairOwner.id) {
        pairStatus.textContent = `This pairing was approved for ${pairOwner.display_name} (${pairOwner.id}). Sign in to that account or restart pairing on the device.`;
        return;
    }
    pairStatus.textContent = "Waiting for approval on the device. Confirm the account name and ID on its local terminal. Keep this tab open.";
    try {
        await refreshDevices();
        if (!pairing.token) return;
        if (Date.now() >= pairInfo.expires_at * 1000) {
            pairing.token = null;
            pairStatus.textContent = "Pairing was not confirmed before expiry or was cancelled locally. Restart pairing on the device.";
            return;
        }
        pairTimer = setTimeout(waitForPair, 2000);
    } catch (error) {
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
    await refreshRepositoryIssues();
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
        if (currentAccount(epoch)) await refreshRepositoryIssues();
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
        if (currentAccount(epoch)) await refreshRepositoryIssues();
    }
}

function clearProviderSelection(provider) {
    integrations.choices[provider] = [];
    providerControls[provider].select.replaceChildren();
    providerControls[provider].issues.replaceChildren();
    issuesRequest++;
    if (provider === "linear") {
        repositoryRequest++;
        repositoryIssues.replaceChildren();
        repositoryStatus.textContent = "Refresh linked issues to read the current Linear team.";
    }
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

async function refreshRepositoryIssues() {
    const device = devices.find((device) => device.device_id === repositoryDeviceId);
    if (!user || !device) return;
    const epoch = accountEpoch;
    const request = ++repositoryRequest;
    repositoryDetails.textContent = `${device.name} (${device.device_id})`;
    repositoryIssues.replaceChildren();
    repositoryStatus.textContent = "Loading repository-linked Linear issues…";
    try {
        const result = await integrationApi(`/api/integrations/${device.device_id}/linear/issues`);
        if (!currentAccount(epoch) || request !== repositoryRequest || repositoryDeviceId !== device.device_id) return;
        device.repository = result.repository;
        const label = result.repository
            ? `${result.repository.owner}/${result.repository.name}`
            : null;
        document.getElementById(`repository-${device.device_id}`).textContent = label
            ? `Last reported repository: ${label}`
            : "No GitHub repository reported. Start the updated orield from a GitHub checkout.";
        if (!label) {
            repositoryStatus.textContent = "No GitHub repository reported. Start the updated orield in a checkout with a GitHub origin, then refresh linked issues.";
            return;
        }
        repositoryDetails.textContent += ` — ${label}`;
        if (!result.linear) {
            repositoryStatus.textContent = "Connect Linear and save a team above to read linked work.";
            return;
        }
        const items = document.createDocumentFragment();
        for (const issue of result.linear.issues) {
            const item = document.createElement("li");
            const title = document.createElement("p");
            title.append(issueLink(issue.identifier, issue.url, "linear.app"), `: ${issue.title}`);
            const state = document.createElement("p");
            state.textContent = `Linear state: ${issue.state.name} (${issue.state.type})`;
            const links = document.createElement("p");
            links.append("GitHub WHAT: ");
            for (const [index, reference] of issue.github_issues.entries()) {
                if (index) links.append(", ");
                links.append(issueLink(`#${reference.number}`, reference.url, "github.com"));
            }
            const how = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = "HOW (Linear description)";
            const description = document.createElement("p");
            description.className = "how-description";
            description.textContent = issue.description || "No HOW description.";
            how.append(summary, description);
            item.append(title, state, links, how);
            items.append(item);
        }
        repositoryIssues.replaceChildren(items);
        repositoryStatus.textContent = result.linear.issues.length
            ? `${result.linear.team.team_name}: ${result.linear.issues.length} linked Linear issues for ${label}.`
            : `No Linear issues in ${result.linear.team.team_name} are linked to GitHub Issues in ${label}. Add the corresponding GitHub Issue URL as a link attachment in Linear; matching titles alone are not links.`;
    } catch (error) {
        if (error.sessionExpired) throw error;
        if (!currentAccount(epoch) || request !== repositoryRequest || repositoryDeviceId !== device.device_id) return;
        repositoryIssues.replaceChildren();
        repositoryStatus.textContent = `Could not load linked Linear issues: ${errorText(error)}`;
        throw error;
    }
}

function sendResize() {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(`resize:${terminal.cols}:${terminal.rows}`);
    }
}

async function openTerminal(device) {
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
            : `Disconnected (code ${event.code}). Open the device again to reconnect.`;
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
    await api("/api/auth/logout", {});
    setUser(null);
    status.textContent = "Signed out.";
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
refreshRepositoryButton.addEventListener("click", () => perform(refreshRepositoryIssues));
document.getElementById("close-terminal").addEventListener("click", () => {
    disconnect();
    status.textContent = "Terminal closed. The device remains paired.";
});

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
                        <p id="device-summary">"Sign in to see your devices."</p>
                        <ul id="devices"></ul>
                    </section>
                    <section id="repository-work" hidden="">
                        <h2>"Repository-linked work"</h2>
                        <p>"Only Linear issues with a GitHub Issue link attachment in this device's reported repository are shown. Titles and descriptions are not used to guess links. This view is read-only; execution approval stays in Linear."</p>
                        <p id="repository-details"></p>
                        <button id="refresh-repository" type="button">"Refresh linked issues"</button>
                        <p id="repository-status" role="status"></p>
                        <ul id="repository-issues" aria-label="Repository-linked Linear issues"></ul>
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
