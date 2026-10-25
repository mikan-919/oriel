export function mountCodex() {
    const get = id => document.getElementById(`codex-${id}`);
    const ui = Object.fromEntries(["device", "connect", "status", "engine", "model", "effort", "new", "refresh", "archived",
        "threads", "fork", "archive", "name", "rename", "review", "review-kind", "review-target", "form", "input", "send",
        "steer", "interrupt", "pause", "resume", "workflow-model", "output", "diff", "requests", "skills", "skill-list",
        "mcp-list", "mcp-form", "mcp-name", "mcp-url"].map(id => [id, get(id)]));
    let owner = null, devices = [], socket = null, generation = 0, engines = [], engineId = "", threadId = "", turnId = "";
    let models = [], active = false, busy = 0, requests = new Map(), answered = new Set(), calls = new Map(), retry;
    const items = new Map();
    let keepalive, expiry;
    ui.skillList = ui["skill-list"]; ui.mcpList = ui["mcp-list"]; ui.mcpForm = ui["mcp-form"];
    const node = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
    const button = (text, action) => { const element = node("button", text); element.type = "button"; element.addEventListener("click", () => attempt(action)); return element; };
    const selectedEngine = () => engines.find(engine => engine.id === engineId);
    function status(text) { ui.status.textContent = text; }
    async function attempt(action) { busy++; controls(); try { await action(); } catch (error) { status(error.message || String(error)); } finally { busy--; controls(); } }
    function controls() {
        const connected = socket?.readyState === WebSocket.OPEN && !!selectedEngine();
        const automatic = !!selectedEngine()?.automatic;
        ui.connect.disabled = !owner || !ui.device.value;
        for (const id of ["new", "refresh", "skills", "pause", "resume", "workflow-model"]) ui[id].disabled = !connected;
        ui.new.disabled ||= automatic || !!busy;
        for (const id of ["fork", "archive", "rename", "review", "send"]) ui[id].disabled = !connected || !threadId || automatic || active || !!busy;
        ui.name.disabled = !connected || automatic || active || !!busy;
        ui.input.disabled = !connected || !!busy;
        ui.model.disabled = ui.effort.disabled = !connected || !!busy;
        ui.steer.disabled = !connected || !threadId || !turnId || !active || !!busy;
        ui.interrupt.disabled = !connected || !threadId || !turnId || !active;
        ui.mcpForm.querySelector("button").disabled = !connected || automatic;
    }
    function rejectCalls(message) {
        for (const pending of calls.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
        calls.clear();
    }
    function disconnect(clear = true) {
        generation++; clearTimeout(retry);
        clearInterval(keepalive); clearTimeout(expiry);
        const previous = socket; socket = null; previous?.close();
        rejectCalls("接続が切れました。送信済みの操作を自動で再送しません。");
        engines = []; engineId = ""; threadId = ""; turnId = ""; active = false;
        requests.clear(); answered.clear(); ui.requests.replaceChildren();
        ui.engine.replaceChildren(); ui.threads.replaceChildren();
        const placeholder = node("option", "接続すると選択できます"); placeholder.value = ""; placeholder.disabled = true; ui.engine.append(placeholder);
        if (clear) { items.clear(); ui.output.replaceChildren(); ui.diff.textContent = ""; ui.diff.parentElement.hidden = true; ui.input.value = ""; ui.name.value = ""; }
        controls();
    }
    function rpc(method, params = {}, engine = engineId) {
        if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Codexに接続してください。"));
        const requestId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { calls.delete(requestId); reject(new Error("応答を確認できません。会話を更新して状態を確認してください。")); }, 95000);
            calls.set(requestId, {resolve, reject, timer});
            socket.send(JSON.stringify({type: "rpc", request_id: requestId, engine, method, params}));
        });
    }
    function modelParams() { return {...(ui.model.value ? {model: ui.model.value} : {}), ...(ui.effort.value ? {effort: ui.effort.value} : {})}; }
    function fillEfforts() {
        const selected = models.find(model => model.model === ui.model.value);
        ui.effort.replaceChildren(); const initial = node("option", "既定の推論量"); initial.value = ""; ui.effort.append(initial);
        for (const effort of selected?.supportedReasoningEfforts ?? []) { const option = node("option", effort.reasoningEffort); option.value = effort.reasoningEffort; ui.effort.append(option); }
    }
    async function loadModels() {
        const selected = ui.model.value;
        const result = await rpc("model/list", {limit: 100}); models = result.data ?? [];
        ui.model.replaceChildren(); const initial = node("option", "端末の既定モデル"); initial.value = ""; ui.model.append(initial);
        for (const model of models) { const option = node("option", model.displayName || model.model); option.value = model.model; ui.model.append(option); }
        if (models.some(model => model.model === selected)) ui.model.value = selected;
        fillEfforts();
    }
    async function connect() {
        const device = ui.device.value; disconnect();
        if (!owner || !device) return;
        const current = generation;
        status("Codexに接続中です。");
        const url = new URL(`/api/codex/${device}/browser`, location.origin); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(url);
        const connection = socket;
        const expire = () => { if (current === generation) connection.close(); };
        expiry = setTimeout(expire, 60000);
        socket.addEventListener("open", () => {
            if (current !== generation) return;
            status("端末のCodex接続を確認しています。");
            keepalive = setInterval(() => {
                if (current === generation && connection.readyState === WebSocket.OPEN) connection.send("oriel:ping");
            }, 15000);
        });
        socket.addEventListener("message", event => {
            if (current !== generation) return;
            clearTimeout(expiry); expiry = setTimeout(expire, 60000);
            if (event.data === "oriel:pong") return;
            try { receive(JSON.parse(event.data)); } catch (error) { status(error.message || "Codexの応答を読み取れません。"); }
        });
        socket.addEventListener("close", () => {
            if (current !== generation) return;
            disconnect(false); status("Codexとの接続が切れました。端末の起動状態を確認してください。");
            if (owner && devices.some(candidate => candidate.device_id === device)) retry = setTimeout(() => attempt(connect), 5000);
        });
        socket.addEventListener("error", () => { if (current === generation) status("Codexに接続できません。端末で orield codex または orield workflow を実行してください。"); });
    }
    function receive(message) {
        if (message.type === "response") {
            const pending = calls.get(message.request_id); if (!pending) return;
            calls.delete(message.request_id); clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
        } else if (message.type === "offline") {
            rejectCalls("端末のCodexが未接続です。"); engines = []; controls();
            requests.clear(); ui.requests.replaceChildren(); status("端末で orield codex または orield workflow を実行してください。");
        } else if (message.type === "state") {
            const old = engineId; engines = message.engines ?? [];
            if (!engines.some(engine => engine.id === engineId)) engineId = engines.find(engine => !engine.automatic)?.id || engines[0]?.id || "";
            ui.engine.replaceChildren();
            for (const engine of engines) { const option = node("option", engine.title); option.value = engine.id; ui.engine.append(option); }
            ui.engine.value = engineId;
            if (selectedEngine()?.automatic) { threadId = selectedEngine().threadId || ""; turnId = selectedEngine().turnId || ""; active = !!turnId; }
            const visible = new Set();
            for (const engine of engines) for (const request of engine.requests ?? []) {
                const key = `${engine.id}:${JSON.stringify(request.id)}`; visible.add(key); renderRequest(engine.id, request);
            }
            for (const [key, entry] of requests) if (!visible.has(key)) { entry.element.remove(); requests.delete(key); }
            if (old !== engineId && engineId) { if (!selectedEngine()?.automatic) { threadId = ""; turnId = ""; active = false; } attempt(async () => { await loadModels(); await refreshThreads(); }); }
            status(engines.length ? message.workflowPaused ? "接続済み。自動ワークフローは一時停止しています。" : "Codexに接続しました。" : "端末のCodexを準備しています。");
        } else if (message.type === "event") {
            const event = message.message;
            if (event.id !== undefined && event.method) renderRequest(message.engine, event);
            if (event.method === "serverRequest/resolved") {
                const key = `${message.engine}:${JSON.stringify(event.params.requestId)}`;
                answered.add(key); requests.get(key)?.element.remove(); requests.delete(key);
            }
            if (message.engine === engineId) receiveEvent(event);
        } else if (message.type === "rejected") { rejectCalls(message.error || "操作が拒否されました。"); status(message.error); }
        controls();
    }
    function outputItem(item) {
        const key = `${engineId}:${threadId}:${item.id}`;
        let element = items.get(key);
        if (element && item.type === "commandExecution" && item.aggregatedOutput == null) return;
        if (!element) { element = node("pre"); element.dataset.item = item.id; items.set(key, element); ui.output.append(element); }
        const content = item.type === "agentMessage" ? item.text : item.type === "userMessage" ? (item.content ?? []).map(part => part.text || "").join("\n")
            : item.type === "commandExecution" ? `$ ${item.command || ""}\n${item.aggregatedOutput || ""}`
            : item.type === "fileChange" ? `変更ファイル:\n${(item.changes ?? []).map(change => change.path).join("\n")}`
            : item.type === "mcpToolCall" ? `外部ツール: ${item.server || ""} / ${item.tool || ""} — ${item.status || ""}` : null;
        if (content !== null) element.textContent = content;
        if (ui.output.children.length > 200) { const first = ui.output.firstElementChild; for (const [key, value] of items) if (value === first) items.delete(key); first.remove(); }
    }
    function receiveEvent(event) {
        const params = event.params ?? {};
        if (params.threadId && threadId && params.threadId !== threadId) return;
        if (event.method === "thread/started" && selectedEngine()?.automatic) threadId = params.thread?.id || threadId;
        if (event.method === "turn/started") { threadId = params.threadId || threadId; turnId = params.turn?.id || ""; active = true; status("実行中です。"); }
        if (event.method === "turn/completed") { active = false; turnId = ""; status(params.turn?.status === "completed" ? "作業が完了しました。" : params.turn?.status === "interrupted" ? "作業を中断しました。" : params.turn?.error?.message || "実行が失敗しました。"); }
        if (["item/started", "item/completed"].includes(event.method) && params.item) outputItem(params.item);
        if (["item/agentMessage/delta", "item/commandExecution/outputDelta"].includes(event.method)) {
            const id = params.itemId; const key = `${engineId}:${threadId}:${id}`;
            if (!items.has(key)) outputItem({id, type: "agentMessage", text: ""});
            const element = items.get(key); element.textContent = (element.textContent + (params.delta || "")).slice(-100000);
        }
        if (event.method === "turn/diff/updated") { ui.diff.textContent = params.diff || ""; ui.diff.parentElement.hidden = !params.diff; }
        if (event.method === "error") status(params.error?.message || "Codexでエラーが発生しました。");
        if (event.method === "oriel/engineEnded") { active = false; status("Codexの実行が終了しました。保存済みの作業は残っています。"); }
        controls();
    }
    async function refreshThreads() {
        const result = await rpc("thread/list", {limit: 50, archived: ui.archived.checked});
        ui.threads.replaceChildren();
        for (const thread of result.data ?? []) {
            const item = node("li"); item.append(button(thread.name || thread.preview || thread.id, () => openThread(thread.id)));
            const detail = node("span", thread.status?.type === "active" ? "実行中" : ""); item.append(detail); ui.threads.append(item);
        }
        if (!ui.threads.children.length) ui.threads.append(node("li", "保存された会話はありません。"));
    }
    async function openThread(id) {
        if (!selectedEngine()?.automatic) await rpc("thread/resume", {threadId: id});
        const result = await rpc("thread/read", {threadId: id, includeTurns: true});
        showThread(result.thread);
    }
    function showThread(thread) {
        threadId = thread.id; ui.name.value = thread.name || ""; turnId = ""; active = false;
        items.clear(); ui.output.replaceChildren(); ui.diff.textContent = ""; ui.diff.parentElement.hidden = true;
        for (const turn of thread.turns ?? []) { for (const item of turn.items ?? []) outputItem(item); if (turn.status === "inProgress") { active = true; turnId = turn.id; } }
        status("会話を開きました。"); controls();
    }
    async function respond(engine, request, decision, answers = null) {
        await rpc("request/respond", {requestId: request.id, decision, answers}, engine);
        const key = `${engine}:${JSON.stringify(request.id)}`; answered.add(key); requests.get(key)?.element.remove(); requests.delete(key);
        status(decision === "decline" ? "要求を拒否しました。" : "回答を送りました。");
    }
    function renderRequest(engine, request) {
        const key = `${engine}:${JSON.stringify(request.id)}`; if (requests.has(key) || answered.has(key)) return;
        const card = node("article"); const params = request.params ?? {};
        card.append(node("h3", engines.find(item => item.id === engine)?.title || "Codexからの要求"));
        if (["item/tool/requestUserInput", "tool/requestUserInput"].includes(request.method)) {
            card.append(node("p", "質問に回答してください。")); const form = node("form");
            const fields = [];
            for (const question of params.questions ?? []) {
                const field = node("fieldset"); field.append(node("legend", question.question));
                const input = node("input"); input.type = question.isSecret ? "password" : "text"; input.required = true;
                const label = node("label", "回答"); label.append(input);
                for (const option of question.options ?? []) field.append(button(option.label, () => { input.value = option.label; input.focus(); }));
                field.append(label); fields.push([question.id, input]); form.append(field);
            }
            const submit = node("button", "回答を送信"); submit.type = "submit"; form.append(submit);
            form.addEventListener("submit", event => { event.preventDefault(); attempt(() => respond(engine, request, "answer", Object.fromEntries(fields.map(([id, input]) => [id, {answers: [input.value]}])))); }); card.append(form);
        } else if (request.method === "mcpServer/elicitation/request") {
            card.append(node("p", params.message || "外部サービスからの確認です。"));
            if (params.url) {
                try { const url = new URL(params.url); if (url.protocol === "https:" && !url.username && !url.password) { const link = node("a", "認可画面を開く"); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; card.append(link); } } catch { /* Invalid provider link is not executable. */ }
            }
            const input = node("textarea"); input.setAttribute("aria-label", "外部サービスへの回答（JSON）"); input.value = "{}";
            if (params.requestedSchema) { card.append(node("pre", JSON.stringify(params.requestedSchema, null, 2)), input); }
            card.append(button("確認して許可", () => respond(engine, request, "accept", params.requestedSchema ? JSON.parse(input.value) : null)), button("拒否", () => respond(engine, request, "decline")));
        } else {
            card.append(node("p", params.reason || "この操作には承認が必要です。"));
            const description = params.command || (params.networkApprovalContext ? `接続先: ${params.networkApprovalContext.host}` : params.grantRoot ? `対象: ${params.grantRoot}` : JSON.stringify(params.permissions || {}, null, 2));
            card.append(node("pre", description));
            card.append(button("今回だけ許可", () => respond(engine, request, "accept")), button("拒否", () => respond(engine, request, "decline")));
        }
        requests.set(key, {element: card}); ui.requests.append(card);
    }
    async function loadTools() {
        const skills = await rpc("skills/list", {}); ui.skillList.replaceChildren();
        for (const group of skills.data ?? []) for (const skill of group.skills ?? []) {
            if (skill.enabled === false) continue;
            const item = node("li"); item.append(button(skill.name, () => { ui.input.value = `$${skill.name} ${ui.input.value}`; ui.input.focus(); }), node("span", ` ${skill.description || ""}`)); ui.skillList.append(item);
        }
        if (!ui.skillList.children.length) ui.skillList.append(node("li", "利用できるスキルはありません。"));
        const servers = await rpc("mcpServerStatus/list", {}); ui.mcpList.replaceChildren();
        for (const server of servers.data ?? []) { const item = node("li", `${server.name} — ${server.authStatus || "接続設定済み"}`); item.append(button("認可する", async () => {
            const result = await rpc("mcpServer/oauth/login", {name: server.name}); const url = new URL(result.authorizationUrl);
            if (url.protocol !== "https:" || url.username || url.password) throw Error("サービスの認可URLが無効です。");
            const link = node("a", "認可画面を開く"); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; item.append(link);
        })); ui.mcpList.append(item); }
        if (!ui.mcpList.children.length) ui.mcpList.append(node("li", "外部サービスは未設定です。"));
    }
    ui.connect.addEventListener("click", () => attempt(connect));
    ui.device.addEventListener("change", () => { disconnect(); status("接続する端末を選び、接続を押してください。"); });
    ui.engine.addEventListener("change", () => { engineId = ui.engine.value; threadId = selectedEngine()?.automatic ? selectedEngine().threadId || "" : ""; turnId = selectedEngine()?.automatic ? selectedEngine().turnId || "" : ""; active = !!turnId; items.clear(); ui.output.replaceChildren(); ui.diff.textContent = ""; controls(); attempt(async () => { await refreshThreads(); if (threadId) await openThread(threadId); }); });
    ui.model.addEventListener("change", fillEfforts);
    ui.new.addEventListener("click", () => attempt(async () => { const {effort, ...params} = modelParams(); const result = await rpc("thread/start", params); showThread(result.thread); await refreshThreads(); }));
    ui.refresh.addEventListener("click", () => attempt(async () => { await refreshThreads(); if (threadId) await openThread(threadId); }));
    ui.archived.addEventListener("change", () => attempt(refreshThreads));
    ui.fork.addEventListener("click", () => attempt(async () => { const result = await rpc("thread/fork", {threadId}); showThread(result.thread); await refreshThreads(); }));
    ui.archive.addEventListener("click", () => attempt(async () => { await rpc(ui.archived.checked ? "thread/unarchive" : "thread/archive", {threadId}); threadId = ""; await refreshThreads(); }));
    ui.rename.addEventListener("click", () => attempt(async () => { await rpc("thread/name/set", {threadId, name: ui.name.value}); await refreshThreads(); }));
    ui.review.addEventListener("click", () => attempt(async () => {
        const type = ui["review-kind"].value, value = ui["review-target"].value;
        const target = {type, ...(type === "baseBranch" ? {branch: value} : type === "commit" ? {sha: value} : type === "custom" ? {instructions: value} : {})};
        const result = await rpc("review/start", {threadId, target}); active = true; turnId = result.turn?.id || "";
    }));
    ui.form.addEventListener("submit", event => { event.preventDefault(); attempt(async () => { const result = await rpc("turn/start", {threadId, input: [{type: "text", text: ui.input.value}], ...modelParams()}); turnId = result.turn?.id || ""; active = true; ui.input.value = ""; }); });
    ui.steer.addEventListener("click", () => attempt(async () => { await rpc("turn/steer", {threadId, expectedTurnId: turnId, input: [{type: "text", text: ui.input.value}]}); ui.input.value = ""; }));
    ui.interrupt.addEventListener("click", () => attempt(() => rpc("turn/interrupt", {threadId, turnId})));
    ui.pause.addEventListener("click", () => attempt(() => rpc("workflow/pause")));
    ui.resume.addEventListener("click", () => attempt(() => rpc("workflow/resume")));
    ui["workflow-model"].addEventListener("click", () => attempt(async () => { await rpc("workflow/model", {model: ui.model.value, ...(ui.effort.value ? {effort: ui.effort.value} : {})}); status("次回の実装に使用するモデルを設定しました。"); }));
    ui.skills.addEventListener("click", () => attempt(loadTools));
    ui["mcp-form"].addEventListener("submit", event => { event.preventDefault(); attempt(async () => { await rpc("mcp/configure", {name: ui["mcp-name"].value, url: ui["mcp-url"].value}); await loadTools(); }); });
    controls();
    return {setContext(next, list) {
        if (owner?.id !== next?.id) { disconnect(); status(next ? "接続する端末を選んでください。" : "ログインするとCodexを操作できます。"); }
        owner = next; devices = list;
        const selected = ui.device.value; ui.device.replaceChildren();
        for (const device of devices) { const option = node("option", `${device.name}${device.repository ? ` — ${device.repository.owner}/${device.repository.name}` : ""}`); option.value = device.device_id; ui.device.append(option); }
        if (devices.some(device => device.device_id === selected)) ui.device.value = selected;
        else if (socket) disconnect();
        controls();
    }};
}
