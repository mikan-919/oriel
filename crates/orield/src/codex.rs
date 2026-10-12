//! App-server RPC over the paired device's authenticated Relay connection.
use crate::{DeviceIdentity, random_hex, workflow, workflow_git as git};
use anyhow::{Context, Result, anyhow, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{broadcast, mpsc, oneshot, watch},
    task::JoinHandle,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
use url::Url;

const MAX_MESSAGE: usize = 512 * 1024;
static HUB: OnceLock<Hub> = OnceLock::new();
#[derive(Clone)]
pub(super) struct Hub {
    engines: Arc<Mutex<HashMap<String, (Client, Value)>>>,
    events: broadcast::Sender<Value>,
    paused: Arc<AtomicBool>,
    model: Arc<Mutex<Value>>,
}
pub(super) fn paused() -> bool {
    HUB.get()
        .is_some_and(|hub| hub.paused.load(Ordering::SeqCst))
}
pub(super) fn pause() {
    if let Some(hub) = HUB.get() {
        hub.paused.store(true, Ordering::SeqCst);
    }
}
impl Hub {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            engines: Arc::new(Mutex::new(HashMap::new())),
            events,
            paused: Arc::new(AtomicBool::new(false)),
            model: Arc::new(Mutex::new(json!({}))),
        }
    }
    fn state(&self) -> Value {
        let engines: Vec<_> = self
            .engines
            .lock()
            .unwrap()
            .values()
            .map(|(client, meta)| {
                let mut meta = meta.clone();
                meta["requests"] =
                    json!(client.pending.lock().unwrap().values().collect::<Vec<_>>());
                meta
            })
            .collect();
        json!({"type":"state","engines":engines,"workflowPaused":self.paused.load(Ordering::SeqCst),"workflowModel":*self.model.lock().unwrap()})
    }
    fn changed(&self) {
        let _ = self.events.send(self.state());
    }
    async fn dispatch(&self, message: &Value) -> Result<Value> {
        let method = message["method"].as_str().context("missing Codex method")?;
        if method == "engines/list" {
            return Ok(self.state());
        }
        if matches!(method, "workflow/pause" | "workflow/resume") {
            self.paused
                .store(method == "workflow/pause", Ordering::SeqCst);
            self.changed();
            return Ok(json!({}));
        }
        if method == "workflow/model" {
            let params = &message["params"];
            ensure!(
                params["model"].as_str().is_some_and(|m| m.len() <= 100)
                    && params.as_object().is_some_and(|p| p
                        .keys()
                        .all(|key| ["model", "effort"].contains(&key.as_str()))),
                "invalid model selection"
            );
            ensure!(
                params["effort"].is_null()
                    || params["effort"].as_str().is_some_and(|e| [
                        "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"
                    ]
                    .contains(&e)),
                "invalid reasoning effort"
            );
            let mut selection = params.clone();
            if selection["model"] == "" {
                selection["model"] = Value::Null;
            }
            *self.model.lock().unwrap() = selection;
            self.changed();
            return Ok(json!({}));
        }
        let id = message["engine"].as_str().context("missing engine")?;
        let client = self
            .engines
            .lock()
            .unwrap()
            .get(id)
            .map(|(client, _)| client.clone())
            .context("Codex execution ended")?;
        client.remote(method, message["params"].clone()).await
    }
}

enum Input {
    Rpc {
        method: String,
        params: Value,
        reply: oneshot::Sender<Result<Value>>,
    },
    Respond {
        id: Value,
        decision: String,
        answers: Value,
        reply: oneshot::Sender<Result<Value>>,
    },
}
#[derive(Clone)]
pub(super) struct Client {
    sender: mpsc::Sender<Input>,
    events: broadcast::Sender<Value>,
    cwd: PathBuf,
    automatic: bool,
    pending: Arc<Mutex<HashMap<String, Value>>>,
}
impl Client {
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Input::Rpc {
                method: method.into(),
                params,
                reply,
            })
            .await
            .context("Codex process ended")?;
        tokio::time::timeout(Duration::from_secs(90), result)
            .await
            .context("Codex request timed out")?
            .context("Codex process ended")?
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }
    async fn remote(&self, method: &str, params: Value) -> Result<Value> {
        if method == "request/respond" {
            let decision = params["decision"]
                .as_str()
                .context("missing decision")?
                .to_owned();
            ensure!(
                ["accept", "decline", "cancel", "answer"].contains(&decision.as_str()),
                "invalid decision"
            );
            let (reply, result) = oneshot::channel();
            self.sender
                .send(Input::Respond {
                    id: params["requestId"].clone(),
                    decision,
                    answers: params["answers"].clone(),
                    reply,
                })
                .await?;
            return result.await.context("Codex request ended")?;
        }
        let safe = remote_params(method, &params, &self.cwd, self.automatic)?;
        if self.automatic && method == "turn/interrupt" {
            pause();
        }
        if method == "mcp/configure" {
            let name = safe["name"].as_str().unwrap();
            self.request("config/value/write", json!({"keyPath":format!("mcp_servers.{name}.url"), "value":safe["url"], "mergeStrategy":"upsert"})).await?;
            return self.request("config/mcpServer/reload", json!({})).await;
        }
        self.request(method, safe).await
    }
}

fn remote_params(method: &str, params: &Value, cwd: &Path, automatic: bool) -> Result<Value> {
    ensure!(params.is_object(), "invalid Codex arguments");
    let keys: &[&str] = match method {
        "model/list" => &["cursor", "limit"],
        "thread/list" => &["cursor", "limit", "archived"],
        "thread/read" => &["threadId", "includeTurns"],
        "thread/start" | "thread/resume" | "thread/fork" if !automatic => &["threadId", "model"],
        "thread/archive" | "thread/unarchive" | "thread/name/set" if !automatic => {
            &["threadId", "name"]
        }
        "turn/start" if !automatic => &["threadId", "input", "model", "effort"],
        "turn/steer" => &["threadId", "expectedTurnId", "input"],
        "turn/interrupt" => &["threadId", "turnId"],
        "review/start" if !automatic => &["threadId", "target"],
        "skills/list" | "mcpServerStatus/list" => &["cursor", "limit"],
        "mcpServer/oauth/login" if !automatic => &["name"],
        "mcp/configure" if !automatic => &["name", "url"],
        _ => bail!("This Codex operation is not available"),
    };
    ensure!(
        params
            .as_object()
            .unwrap()
            .keys()
            .all(|key| keys.contains(&key.as_str())),
        "Codex security configuration cannot be changed from a request"
    );
    let mut result = params.clone();
    if method.starts_with("thread/")
        && ["threadId", "name", "model"]
            .iter()
            .any(|key| params[*key].is_string())
    {
        for key in ["threadId", "name", "model"] {
            if let Some(value) = params[key].as_str() {
                ensure!(
                    value.len() <= 300 && !value.chars().any(char::is_control),
                    "invalid Codex identifier"
                );
            }
        }
    }
    if matches!(method, "thread/start" | "thread/resume" | "thread/fork") {
        result["cwd"] = json!(cwd);
        result["sandbox"] = json!("read-only");
        result["approvalPolicy"] = json!("on-request");
        result["approvalsReviewer"] = json!("user");
    }
    if method == "thread/list" {
        result["cwd"] = json!(cwd);
    }
    if method == "skills/list" {
        result["cwds"] = json!([cwd]);
    }
    if matches!(method, "turn/start" | "turn/steer") {
        let input = params["input"].as_array().context("missing message")?;
        ensure!(!input.is_empty() && input.len() <= 8, "invalid message");
        for item in input {
            ensure!(
                item["type"] == "text"
                    && item["text"]
                        .as_str()
                        .is_some_and(|text| !text.trim().is_empty() && text.len() <= 32000)
                    && item.as_object().is_some_and(|item| item
                        .keys()
                        .all(|key| ["type", "text"].contains(&key.as_str()))),
                "Only text input is accepted"
            );
        }
    }
    if method == "review/start" {
        let kind = params["target"]["type"].as_str().unwrap_or("");
        ensure!(
            ["uncommittedChanges", "baseBranch", "commit", "custom"].contains(&kind),
            "invalid review target"
        );
    }
    if method == "mcp/configure" {
        let name = params["name"].as_str().context("missing MCP name")?;
        ensure!(
            !name.is_empty()
                && name.len() <= 64
                && name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
            "invalid MCP name"
        );
        let url = Url::parse(params["url"].as_str().context("missing MCP URL")?)?;
        ensure!(
            url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none(),
            "MCP requires an HTTPS URL without credentials"
        );
    }
    Ok(result)
}

fn rpc_error(message: &Value) -> anyhow::Error {
    let text = message["error"]["message"]
        .as_str()
        .unwrap_or("Codex request failed");
    if text == "Selected model is at capacity. Please try a different model." {
        workflow::Stop::ModelCapacity.into()
    } else {
        anyhow!("{text}")
    }
}

pub(super) struct Engine {
    pub client: Client,
    cancel: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
    id: String,
    hub: Hub,
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
        self.hub.engines.lock().unwrap().remove(&self.id);
        self.hub.changed();
    }
}
impl Engine {
    pub async fn run(&self, prompt: &str, schema: Value, read_only: bool) -> Result<String> {
        let mut events = self.client.subscribe();
        let model = self.hub.model.lock().unwrap().clone();
        let thread = self.client.request("thread/start", json!({"cwd":self.client.cwd,"model":model["model"],
            "sandbox":if read_only { Some("read-only") } else { None }, "approvalPolicy":"on-request",
            "approvalsReviewer":"user","developerInstructions":prompt})).await?;
        let thread_id = thread["thread"]["id"]
            .as_str()
            .context("Codex returned no thread")?;
        self.client.request("turn/start", json!({"threadId":thread_id,"effort":model["effort"],"input":[{"type":"text","text":"Carry out the task in the developer instructions and return the required structured result."}],"outputSchema":schema})).await?;
        let mut text = String::new();
        loop {
            let event = events.recv().await.context("Codex progress ended")?;
            if event["method"] == "item/completed"
                && event["params"]["item"]["type"] == "agentMessage"
                && let Some(value) = event["params"]["item"]["text"].as_str()
            {
                text = value.to_owned();
            }
            if event["method"] == "turn/completed" && event["params"]["threadId"] == thread_id {
                match event["params"]["turn"]["status"].as_str() {
                    Some("completed") => {
                        ensure!(!text.trim().is_empty(), "Codex returned no final output");
                        return Ok(text);
                    }
                    Some("interrupted") => {
                        pause();
                        return Err(workflow::Stop::WebPaused.into());
                    }
                    _ if event["params"]["turn"]["error"]["message"]
                        == "Selected model is at capacity. Please try a different model." =>
                    {
                        return Err(workflow::Stop::ModelCapacity.into());
                    }
                    _ => bail!("Codex turn failed; private transcript retained"),
                }
            }
            if event["method"] == "oriel/engineEnded" {
                bail!("Codex process ended; private transcript retained");
            }
        }
    }
    pub async fn stop(&mut self) {
        let _ = self.cancel.send(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
    pub async fn spawn(
        mut command: Command,
        cwd: &Path,
        title: &str,
        automatic: bool,
        allow_edits: bool,
        transcript: &Path,
    ) -> Result<Self> {
        let hub = HUB.get().cloned().unwrap_or_else(Hub::new);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .context("codex app-server could not start")?;
        let pid = child.id().context("Codex process has no ID")?;
        let mut stdin = child.stdin.take().context("Codex input missing")?;
        let stdout = child.stdout.take().context("Codex output missing")?;
        let mut lines = BufReader::new(stdout).lines();
        let mut log = fs::OpenOptions::new().write(true).open(transcript)?;
        let id = random_hex::<16>()?;
        let engine_id = id.clone();
        let (sender, mut input) = mpsc::channel(32);
        let (events, _) = broadcast::channel(256);
        let (cancel, mut cancelled) = watch::channel(false);
        let requests = Arc::new(Mutex::new(HashMap::<String, Value>::new()));
        let client = Client {
            sender,
            events: events.clone(),
            cwd: cwd.into(),
            automatic,
            pending: requests.clone(),
        };
        hub.engines.lock().unwrap().insert(
            id.clone(),
            (
                client.clone(),
                json!({"id":id,"title":title,"automatic":automatic,"readOnly":!allow_edits}),
            ),
        );
        hub.changed();
        let outgoing = hub.events.clone();
        let process_hub = hub.clone();
        let task = tokio::spawn(async move {
            let mut sequence = 0_u64;
            let mut calls: HashMap<u64, (String, oneshot::Sender<Result<Value>>)> = HashMap::new();
            let mut threads = Vec::<String>::new();
            let process = async {
                loop {
                    tokio::select! {
                        _ = cancelled.changed() => break,
                        next = lines.next_line() => {
                            let line = next?.context("Codex process ended")?;
                            ensure!(line.len() <= MAX_MESSAGE, "Codex output exceeds size limit");
                            writeln!(log, "{line}")?;
                            let message: Value = serde_json::from_str(&line)?;
                            if let Some(id) = message["id"].as_u64() && message["method"].is_null() {
                                if let Some((method, reply)) = calls.remove(&id) {
                                    if let Some(thread) = message["result"]["thread"]["id"].as_str() && !threads.iter().any(|id| id == thread) {
                                        threads.push(thread.into());
                                        if automatic {
                                            if let Some((_, meta)) = process_hub.engines.lock().unwrap().get_mut(&engine_id) { meta["threadId"] = json!(thread); }
                                            process_hub.changed();
                                        }
                                    }
                                    let result = if message.get("error").is_some() { Err(rpc_error(&message)) } else { Ok(message["result"].clone()) };
                                    if method == "initialize" && result.is_ok() { stdin.write_all(b"{\"method\":\"initialized\"}\n").await?; }
                                    let _ = reply.send(result);
                                }
                            } else if !message["method"].is_null() {
                                if message.get("id").is_some() {
                                    let method = message["method"].as_str().unwrap_or("");
                                    if !["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "tool/requestUserInput", "mcpServer/elicitation/request"].contains(&method) || requests.lock().unwrap().len() >= 32 {
                                        stdin.write_all(format!("{}\n", json!({"id":message["id"],"error":{"code":-32601,"message":"This request is not supported"}})).as_bytes()).await?;
                                        continue;
                                    }
                                    requests.lock().unwrap().insert(message["id"].to_string(), message.clone());
                                }
                                if message["method"] == "serverRequest/resolved" { requests.lock().unwrap().remove(&message["params"]["requestId"].to_string()); }
                                if automatic && ["turn/started", "turn/completed"].iter().any(|method| message["method"] == *method) {
                                    if let Some((_, meta)) = process_hub.engines.lock().unwrap().get_mut(&engine_id) {
                                        meta["turnId"] = if message["method"] == "turn/started" { message["params"]["turn"]["id"].clone() } else { Value::Null };
                                    }
                                    process_hub.changed();
                                }
                                let _ = events.send(message.clone());
                                if !message["method"].as_str().is_some_and(|m| m.starts_with("account/") || m.starts_with("item/reasoning/")) {
                                    let _ = outgoing.send(json!({"type":"event","engine":engine_id,"message":message}));
                                }
                            }
                        },
                        next = input.recv() => {
                            match next.context("Codex input ended")? {
                                Input::Rpc { method, params, reply } => {
                                    if automatic && method != "initialize" && method != "thread/start" && params.get("threadId").is_some()
                                        && !params["threadId"].as_str().is_some_and(|id| threads.iter().any(|thread| thread == id)) {
                                        let _ = reply.send(Err(anyhow!("Thread does not belong to this execution"))); continue;
                                    }
                                    sequence += 1;
                                    let bytes = format!("{}\n", json!({"id":sequence,"method":method,"params":params}));
                                    calls.insert(sequence, (method, reply)); stdin.write_all(bytes.as_bytes()).await?;
                                },
                                Input::Respond { id, decision, answers, reply } => {
                                    let key = id.to_string();
                                    let request = requests.lock().unwrap().get(&key).cloned();
                                    let Some(request) = request else { let _ = reply.send(Err(anyhow!("This request has expired or was answered"))); continue; };
                                    match response_for(&request, &decision, &answers, allow_edits) {
                                        Ok(result) => {
                                            stdin.write_all(format!("{}\n", json!({"id":id,"result":result})).as_bytes()).await?;
                                            requests.lock().unwrap().remove(&key);
                                            let _ = outgoing.send(json!({"type":"event","engine":engine_id,"message":{"method":"serverRequest/resolved","params":{"requestId":id}}}));
                                            let _ = reply.send(Ok(json!({"accepted":true})));
                                        },
                                        Err(error) => { let _ = reply.send(Err(error)); }
                                    }
                                }
                            }
                        }
                    }
                }
                Ok::<(), anyhow::Error>(())
            }.await;
            let _ = git::stop_group(pid);
            let _ = child.wait().await;
            process_hub.engines.lock().unwrap().remove(&engine_id);
            process_hub.changed();
            if process.is_err() {
                let _ = events.send(json!({"method":"oriel/engineEnded","params":{"error":"Codex process ended; local work preserved"}}));
            }
            for (_, (_, reply)) in calls {
                let _ = reply.send(Err(anyhow!("Codex process ended")));
            }
        });
        let engine = Self {
            client,
            cancel,
            task: Some(task),
            id,
            hub,
        };
        engine.client.request("initialize", json!({"clientInfo":{"name":"oriel","title":"Oriel","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await?;
        Ok(engine)
    }
}

fn response_for(
    request: &Value,
    decision: &str,
    answers: &Value,
    allow_edits: bool,
) -> Result<Value> {
    let method = request["method"].as_str().unwrap_or("");
    let params = &request["params"];
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            ensure!(
                ["accept", "decline", "cancel"].contains(&decision),
                "invalid approval response"
            );
            if !allow_edits && decision == "accept" {
                ensure!(
                    method != "item/fileChange/requestApproval",
                    "Source edits require an approved HOW"
                );
                let actions = params["commandActions"]
                    .as_array()
                    .context("This command cannot be approved in a read-only conversation")?;
                ensure!(
                    !actions.is_empty()
                        && actions.iter().all(|a| ["read", "listFiles", "search"]
                            .contains(&a["type"].as_str().unwrap_or(""))),
                    "This command requires an approved HOW"
                );
            }
            Ok(json!({"decision":decision}))
        }
        "item/permissions/requestApproval" => {
            ensure!(
                ["accept", "decline", "cancel"].contains(&decision),
                "invalid permission response"
            );
            let permissions = if decision == "accept" {
                params["permissions"].clone()
            } else {
                json!({})
            };
            if !allow_edits {
                ensure!(
                    permissions["fileSystem"].is_null() && permissions["filesystem"].is_null(),
                    "Filesystem permission expansion requires an approved HOW"
                );
            }
            Ok(json!({"permissions":permissions,"scope":"turn"}))
        }
        "item/tool/requestUserInput" | "tool/requestUserInput" => {
            ensure!(
                decision == "answer" && answers.is_object() && answers.to_string().len() <= 32000,
                "invalid question response"
            );
            let questions = params["questions"]
                .as_array()
                .context("invalid questions")?;
            ensure!(
                answers
                    .as_object()
                    .unwrap()
                    .keys()
                    .all(|id| questions.iter().any(|q| q["id"] == *id)),
                "unknown question"
            );
            for q in questions {
                ensure!(
                    answers[q["id"].as_str().context("invalid question")?]["answers"]
                        .as_array()
                        .is_some_and(|a| !a.is_empty() && a.iter().all(Value::is_string)),
                    "answer every question"
                );
            }
            Ok(json!({"answers":answers}))
        }
        "mcpServer/elicitation/request" => {
            ensure!(
                ["accept", "decline", "cancel"].contains(&decision),
                "invalid MCP response"
            );
            Ok(
                json!({"action":decision,"content":if decision == "accept" { answers.clone() } else { Value::Null }}),
            )
        }
        _ => bail!("unsupported request"),
    }
}

pub(super) struct Control {
    shutdown: watch::Sender<bool>,
    pub task: JoinHandle<()>,
}
impl Control {
    pub async fn stop(&mut self) {
        let _ = self.shutdown.send(true);
        let _ = (&mut self.task).await;
    }
}
impl Drop for Control {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}

pub(super) async fn start(origin: &Url, identity: &DeviceIdentity, cwd: &Path) -> Result<Control> {
    let hub = Hub::new();
    ensure!(
        HUB.set(hub.clone()).is_ok(),
        "Codex control already started"
    );
    let origin = origin.clone();
    let identity = DeviceIdentity {
        device_id: identity.device_id.clone(),
        host_token: identity.host_token.clone(),
    };
    let cwd = cwd.to_owned();
    let (shutdown, mut stopping) = watch::channel(false);
    let task = tokio::spawn(async move {
        let home = match git::state_root().and_then(|root| {
            let path = root
                .join("codex")
                .join(&identity.device_id)
                .join(random_hex::<8>()?);
            git::private_directory(&path)?;
            Ok(path)
        }) {
            Ok(path) => path,
            Err(error) => {
                eprintln!("Codex control unavailable: {error}");
                return;
            }
        };
        // Conversation files use a stable device/project home; credentials are copied only for this process.
        let stable = home.parent().unwrap().join(format!(
            "project-{}",
            cwd.to_string_lossy().bytes().fold(0_u64, |hash, byte| hash
                .wrapping_mul(31)
                .wrapping_add(byte as u64))
        ));
        let prepared = (|| -> Result<()> {
            git::private_directory(&stable.join(".codex"))?;
            let auth = stable.join(".codex/auth.json");
            if auth.exists() {
                ensure!(
                    fs::symlink_metadata(&auth)?.is_file(),
                    "invalid model auth file"
                );
                fs::remove_file(&auth)?;
            }
            workflow::copy_model_auth(&stable.join(".codex"))?;
            Ok(())
        })();
        if let Err(error) = prepared {
            eprintln!("Codex control unavailable: {error}");
            return;
        }
        let auth = workflow::ModelAuth(stable.join(".codex/auth.json"));
        let transcript = home.join("transcript.jsonl");
        let stderr = home.join("stderr.log");
        if git::private_file(&transcript, b"").is_err() || git::private_file(&stderr, b"").is_err()
        {
            return;
        }
        let mut command = Command::new("codex");
        command
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &stable)
            .env("CODEX_HOME", stable.join(".codex"))
            .env("LANG", "C.UTF-8")
            .args([
                "app-server",
                "--listen",
                "stdio://",
                "-c",
                "features.hooks=false",
                "-c",
                "web_search=\"disabled\"",
                "-c",
                "approvals_reviewer=\"user\"",
            ])
            .current_dir(&cwd)
            .stderr(fs::OpenOptions::new().write(true).open(&stderr).unwrap());
        if let Some(key) = std::env::var_os("OPENAI_API_KEY") {
            command.env("OPENAI_API_KEY", key);
        }
        command.as_std_mut().process_group(0);
        let mut engine =
            match Engine::spawn(command, &cwd, "相談・レビュー", false, false, &transcript).await
            {
                Ok(engine) => engine,
                Err(error) => {
                    eprintln!("Codex control unavailable: {error}");
                    return;
                }
            };
        let mut events = hub.events.subscribe();
        loop {
            let connected = async {
                let mut url = origin.join(&format!("/api/codex/{}/host", identity.device_id))?;
                url.set_scheme(if origin.scheme() == "https" { "wss" } else { "ws" }).map_err(|_| anyhow!("invalid Relay URL"))?;
                let mut request = url.as_str().into_client_request()?;
                let mut token = tokio_tungstenite::tungstenite::http::HeaderValue::from_str(&format!("Bearer {}", identity.host_token))?;
                token.set_sensitive(true); request.headers_mut().insert("Authorization", token);
                let (mut socket, _) = tokio::time::timeout(Duration::from_secs(12), connect_async(request)).await??;
                socket.send(Message::Text(hub.state().to_string().into())).await?;
                let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
                loop {
                    tokio::select! {
                        _ = stopping.changed() => return Ok(()),
                        _ = heartbeat.tick() => { socket.send(Message::Text(json!({"type":"heartbeat"}).to_string().into())).await?; socket.send(Message::Text(hub.state().to_string().into())).await?; },
                        event = events.recv() => { match event {
                            Ok(event) => socket.send(Message::Text(event.to_string().into())).await?,
                            Err(broadcast::error::RecvError::Lagged(_)) => socket.send(Message::Text(hub.state().to_string().into())).await?,
                            Err(_) => break,
                        } },
                        frame = socket.next() => {
                            match frame.context("Codex Relay ended")?? {
                                Message::Text(text) => {
                                    ensure!(text.len() <= MAX_MESSAGE, "Relay message too large");
                                    let message: Value = serde_json::from_str(&text)?;
                                    if message["type"] == "snapshot" {
                                        socket.send(Message::Text(hub.state().to_string().into())).await?;
                                    }
                                    if message["type"] == "request" {
                                        let hub = hub.clone();
                                        tokio::spawn(async move {
                                            let result = hub.dispatch(&message).await;
                                            let response = match result { Ok(value) => json!({"result":value}), Err(error) => json!({"error":format!("{error:#}")}) };
                                            let mut response = response;
                                            response["type"] = json!("response"); response["client"] = message["client"].clone(); response["request_id"] = message["request_id"].clone();
                                            let _ = hub.events.send(response);
                                        });
                                    }
                                },
                                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await?,
                                Message::Close(_) => break,
                                _ => {},
                            }
                        }
                    }
                }
                Ok::<(), anyhow::Error>(())
            }.await;
            if *stopping.borrow() || engine.client.sender.is_closed() {
                break;
            }
            if connected.is_err() {
                eprintln!("Codex Web connection interrupted; retrying in 15s");
            }
            tokio::select! { _ = tokio::time::sleep(Duration::from_secs(15)) => {}, _ = stopping.changed() => break }
        }
        engine.stop().await;
        drop(auth);
    });
    Ok(Control { shutdown, task })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_before_turn_start_keeps_native_approval() {
        let error = rpc_error(
            &json!({"error":{"message":"Selected model is at capacity. Please try a different model."}}),
        );
        assert!(matches!(
            error.downcast_ref::<workflow::Stop>(),
            Some(workflow::Stop::ModelCapacity)
        ));
        let error =
            rpc_error(&json!({"error":{"message":"Unrelated capacity configuration error"}}));
        assert!(error.downcast_ref::<workflow::Stop>().is_none());
    }

    #[test]
    fn web_requests_cannot_override_execution_authority() {
        let cwd = Path::new("/trusted/project");
        let start = remote_params("thread/start", &json!({"model":"test"}), cwd, false).unwrap();
        assert_eq!(start["sandbox"], "read-only");
        assert_eq!(start["cwd"], json!(cwd));
        assert_eq!(start["approvalsReviewer"], "user");
        for params in [
            json!({"sandbox":"danger-full-access"}),
            json!({"cwd":"/elsewhere"}),
            json!({"config":{}}),
            json!({"approvalPolicy":"never"}),
        ] {
            assert!(remote_params("thread/start", &params, cwd, false).is_err());
        }
        for method in [
            "thread/start",
            "thread/resume",
            "thread/fork",
            "turn/start",
            "review/start",
            "mcp/configure",
        ] {
            assert!(remote_params(method, &json!({}), cwd, true).is_err());
        }
        assert!(remote_params("command/exec", &json!({}), cwd, false).is_err());
        assert!(
            remote_params(
                "turn/steer",
                &json!({"input":[{"type":"text","text":"x","path":"/etc"}]}),
                cwd,
                false
            )
            .is_err()
        );
        for params in [
            json!({"name":"a.b","url":"https://example.com"}),
            json!({"name":"a","url":"http://example.com"}),
            json!({"name":"a","url":"https://secret@example.com"}),
        ] {
            assert!(remote_params("mcp/configure", &params, cwd, false).is_err());
        }
        assert!(
            remote_params(
                "mcp/configure",
                &json!({"name":"docs","url":"https://example.com/mcp"}),
                cwd,
                false
            )
            .is_ok()
        );
    }

    #[test]
    fn approvals_preserve_read_only_and_grant_only_requested_turn_permissions() {
        let file = json!({"method":"item/fileChange/requestApproval","params":{"networkApprovalContext":{}}});
        assert!(response_for(&file, "accept", &Value::Null, false).is_err());
        assert_eq!(
            response_for(&file, "decline", &Value::Null, false).unwrap(),
            json!({"decision":"decline"})
        );
        assert!(response_for(&file, "accept", &Value::Null, true).is_ok());
        let command = json!({"method":"item/commandExecution/requestApproval","params":{"networkApprovalContext":{},"commandActions":[{"type":"unknown"}]}});
        assert!(response_for(&command, "accept", &Value::Null, false).is_err());
        let read = json!({"method":"item/commandExecution/requestApproval","params":{"commandActions":[{"type":"read"}]}});
        assert!(response_for(&read, "accept", &Value::Null, false).is_ok());
        let permissions = json!({"method":"item/permissions/requestApproval","params":{"permissions":{"fileSystem":{"write":["/trusted/project"]}}}});
        assert!(response_for(&permissions, "accept", &Value::Null, false).is_err());
        assert_eq!(
            response_for(
                &permissions,
                "accept",
                &json!({"fileSystem":{"write":["/"]}}),
                true
            )
            .unwrap(),
            json!({"permissions":permissions["params"]["permissions"],"scope":"turn"})
        );
        assert!(response_for(&permissions, "answer", &Value::Null, true).is_err());
    }

    #[test]
    fn question_responses_require_every_requested_answer() {
        let question =
            json!({"method":"item/tool/requestUserInput","params":{"questions":[{"id":"choice"}]}});
        for answers in [
            json!({}),
            json!({"choice":{"answers":[]}}),
            json!({"choice":{"answers":["a"]},"other":{"answers":["b"]}}),
        ] {
            assert!(response_for(&question, "answer", &answers, false).is_err());
        }
        let answers = json!({"choice":{"answers":["a"]}});
        assert_eq!(
            response_for(&question, "answer", &answers, false).unwrap(),
            json!({"answers":answers})
        );
    }

    #[tokio::test]
    async fn app_server_handshake_requests_replies_and_shutdown() {
        let path =
            std::env::temp_dir().join(format!("oriel-codex-test-{}", random_hex::<8>().unwrap()));
        git::private_directory(&path).unwrap();
        let transcript = path.join("transcript.jsonl");
        git::private_file(&transcript, b"").unwrap();
        let script = r#"
            let initialized=false;
            const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
            require('node:readline').createInterface({input:process.stdin}).on('line', line=>{
              const m=JSON.parse(line);
              if(m.method==='initialized'){initialized=true;return;}
              if(m.method==='initialize'){send({id:m.id,result:{}});return;}
              if(!initialized)process.exit(2);
              if(m.method==='model/list'){send({id:m.id,result:{initialized}});return;}
              if(m.method==='thread/start'){
                if(m.params.developerInstructions && m.params.sandbox!==null)process.exit(3);
                send({id:m.id,result:{thread:{id:'owned'}}});
                send({id:'approval',method:'item/fileChange/requestApproval',params:{threadId:'owned'}});return;
              }
              if(m.method==='turn/start'){
                send({id:m.id,result:{turn:{id:'turn'}}});
                send({method:'item/completed',params:{threadId:'owned',item:{type:'agentMessage',text:'{"summary":"done"}'}}});
                send({method:'turn/completed',params:{threadId:'owned',turn:{id:'turn',status:'completed'}}});return;
              }
              if(m.method==='turn/interrupt'){send({id:m.id,result:{}});return;}
            });
        "#;
        let mut command = Command::new("node");
        command.args(["-e", script]);
        command.as_std_mut().process_group(0);
        let mut engine = Engine::spawn(command, &path, "test", true, true, &transcript)
            .await
            .unwrap();
        assert_eq!(
            engine.client.remote("model/list", json!({})).await.unwrap()["initialized"],
            true
        );
        let mut events = engine.client.subscribe();
        engine
            .client
            .request("thread/start", json!({}))
            .await
            .unwrap();
        let approval = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(approval["id"], "approval");
        assert!(
            engine
                .client
                .remote(
                    "turn/interrupt",
                    json!({"threadId":"unowned","turnId":"turn"})
                )
                .await
                .is_err()
        );
        let response = json!({"requestId":"approval","decision":"accept"});
        assert!(
            engine
                .client
                .remote("request/respond", response.clone())
                .await
                .is_ok()
        );
        assert!(
            engine
                .client
                .remote("request/respond", response)
                .await
                .is_err()
        );
        assert_eq!(
            engine
                .run("task", json!({"type":"object"}), false)
                .await
                .unwrap(),
            "{\"summary\":\"done\"}"
        );
        engine.stop().await;
        assert!(engine.hub.engines.lock().unwrap().is_empty());
        assert!(
            engine
                .client
                .request("model/list", json!({}))
                .await
                .is_err()
        );
        fs::remove_dir_all(path).unwrap();
    }
}
