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
// Local completion notifications repeat the entire command output. The Relay's
// frame limit must not terminate the app-server when that output is large.
const MAX_APP_SERVER_MESSAGE: usize = 16 * 1024 * 1024;
const COMMAND_OUTPUT_TAIL: usize = 64 * 1024;
const KEEPALIVE_PING: &str = "oriel:ping";
const KEEPALIVE_PONG: &str = "oriel:pong";
static HUB: OnceLock<Hub> = OnceLock::new();
static WORKFLOW_CHANGED: tokio::sync::Notify = tokio::sync::Notify::const_new();
pub(super) async fn workflow_changed() {
    WORKFLOW_CHANGED.notified().await;
}
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
        WORKFLOW_CHANGED.notify_one();
        hub.changed();
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
            WORKFLOW_CHANGED.notify_one();
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

fn trim_command_output(value: &mut Value) {
    if value["type"] == "commandExecution"
        && let Some(output) = value["aggregatedOutput"].as_str()
        && output.len() > COMMAND_OUTPUT_TAIL
    {
        let mut start = output.len() - COMMAND_OUTPUT_TAIL;
        while !output.is_char_boundary(start) {
            start += 1;
        }
        value["aggregatedOutput"] = json!(format!(
            "[Oriel: earlier command output omitted; full output in private transcript]\n{}",
            &output[start..]
        ));
    }
    match value {
        Value::Object(fields) => fields.values_mut().for_each(trim_command_output),
        Value::Array(items) => items.iter_mut().for_each(trim_command_output),
        _ => {}
    }
}

#[derive(Clone, Debug)]
enum EngineEnd {
    Stopped,
    Eof,
    Failed(String),
}

impl std::fmt::Display for EngineEnd {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stopped => f.write_str("Codex engine explicitly stopped"),
            Self::Eof => f.write_str("Codex app-server closed stdout"),
            Self::Failed(error) => write!(f, "Codex app-server protocol failed: {error}"),
        }
    }
}

pub(super) struct Engine {
    pub client: Client,
    cancel: watch::Sender<bool>,
    ended: watch::Receiver<Option<EngineEnd>>,
    task: Option<JoinHandle<Result<()>>>,
    stop_error: Option<String>,
    hub: Hub,
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
    }
}
impl Engine {
    pub async fn run(&self, prompt: &str, schema: Value, read_only: bool) -> Result<String> {
        let mut events = self.client.subscribe();
        let model = self.hub.model.lock().unwrap().clone();
        let thread = self.client.request("thread/start", json!({"cwd":self.client.cwd,"model":model["model"],
            "sandbox":if read_only { Some("read-only") } else { None }, "approvalPolicy":"on-request",
            "approvalsReviewer":if read_only { "user" } else { "auto_review" },"developerInstructions":prompt})).await?;
        let thread_id = thread["thread"]["id"]
            .as_str()
            .context("Codex returned no thread")?;
        self.client.request("turn/start", json!({"threadId":thread_id,"effort":model["effort"],"input":[{"type":"text","text":"Carry out the task in the developer instructions and return the required structured result."}],"outputSchema":schema})).await?;
        let mut text = String::new();
        loop {
            let event = events.recv().await.map_err(|error| {
                if matches!(error, broadcast::error::RecvError::Lagged(_)) {
                    anyhow!(workflow::Stop::Uncertain)
                        .context("Codex progress buffer overflowed; local work preserved for retry")
                } else {
                    anyhow!(error).context("Codex progress ended")
                }
            })?;
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
    pub async fn stop(&mut self) -> Result<()> {
        let _ = self.cancel.send(true);
        if let Some(task) = self.task.take() {
            let result = task
                .await
                .context("Codex task could not be collected")
                .and_then(|result| result);
            if let Err(error) = result {
                self.stop_error = Some(format!("{error:#}"));
            }
        }
        match &self.stop_error {
            Some(error) => bail!("{error}"),
            None => Ok(()),
        }
    }
    pub async fn spawn(
        command: Command,
        cwd: &Path,
        title: &str,
        automatic: bool,
        allow_edits: bool,
        transcript: &Path,
    ) -> Result<Self> {
        Self::spawn_with_hub(
            command,
            cwd,
            title,
            automatic,
            allow_edits,
            transcript,
            HUB.get().cloned().unwrap_or_else(Hub::new),
        )
        .await
    }

    async fn spawn_with_hub(
        mut command: Command,
        cwd: &Path,
        title: &str,
        automatic: bool,
        allow_edits: bool,
        transcript: &Path,
        hub: Hub,
    ) -> Result<Self> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        command.as_std_mut().process_group(0);
        // Complete fallible local setup before acquiring the process group.
        let mut log = fs::OpenOptions::new().write(true).open(transcript)?;
        let id = random_hex::<16>()?;
        let mut child = command
            .spawn()
            .context("codex app-server could not start")?;
        let pid = child.id().context("Codex process has no ID")?;
        let mut stdin = child.stdin.take().context("Codex input missing")?;
        let stdout = child.stdout.take().context("Codex output missing")?;
        let mut lines = BufReader::new(stdout).lines();
        let engine_id = id.clone();
        let (sender, mut input) = mpsc::channel(32);
        let (events, _) = broadcast::channel(256);
        let (cancel, mut cancelled) = watch::channel(false);
        let (ended_tx, ended) = watch::channel(None);
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
                        next = lines.next_line() => {
                            let Some(line) = next? else { return Ok::<(), anyhow::Error>(()); };
                            ensure!(line.len() <= MAX_APP_SERVER_MESSAGE, "Codex output exceeds local size limit");
                            writeln!(log, "{line}")?;
                            let mut message: Value = serde_json::from_str(&line)?;
                            // Preserve raw output above, including in thread/read replies;
                            // subscribers only need a bounded display tail.
                            trim_command_output(&mut message);
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
                                // Completion waits can pause during provider checks. Keep
                                // streaming deltas on Web/transcript, out of their bounded queue.
                                if !message["method"].as_str().is_some_and(|method| method.ends_with("Delta") || method.ends_with("/delta")) {
                                    let _ = events.send(message.clone());
                                }
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
            };
            // Dropping the complete protocol future interrupts every stdin write.
            // A partially written connection is never reused.
            let (reason, process) = tokio::select! {
                biased;
                _ = cancelled.changed() => (EngineEnd::Stopped, Ok(())),
                result = process => {
                    let reason = match &result {
                        Ok(()) => EngineEnd::Eof,
                        Err(error) => EngineEnd::Failed(format!("{error:#}")),
                    };
                    (reason, result)
                },
            };
            ended_tx.send_replace(Some(reason));
            let killed = git::stop_group(pid);
            let reaped = child
                .wait()
                .await
                .context("Codex child could not be reaped");
            input.close();
            requests.lock().unwrap().clear();
            if !matches!(*ended_tx.borrow(), Some(EngineEnd::Stopped)) {
                let error = process
                    .err()
                    .unwrap_or_else(|| anyhow!("Codex process ended"));
                let _ = writeln!(
                    log,
                    "{}",
                    json!({"method":"oriel/engineEnded","params":{"error":format!("{error:#}")}})
                );
                let _ = events.send(json!({"method":"oriel/engineEnded","params":{"error":"Codex process ended; local work preserved"}}));
            }
            for (_, (_, reply)) in calls {
                let _ = reply.send(Err(anyhow!("Codex process ended")));
            }
            // Dropping queued inputs also resolves their oneshot waiters.
            drop(input);
            process_hub.engines.lock().unwrap().remove(&engine_id);
            process_hub.changed();
            let cleanup = match (killed, reaped) {
                (Err(kill), Err(wait)) => {
                    Err(kill.context(format!("Codex reap also failed: {wait:#}")))
                }
                (Err(error), _) => Err(error.context("Codex process group could not be stopped")),
                (_, Err(error)) => Err(error),
                (Ok(()), Ok(_)) => Ok(()),
            };
            if let Err(error) = &cleanup {
                // Drop cannot await or return the task result; retain diagnostics there too.
                tracing::error!("Codex cleanup failed: {error:#}");
            }
            cleanup
        });
        let mut engine = Self {
            client,
            cancel,
            ended,
            task: Some(task),
            stop_error: None,
            hub,
        };
        if let Err(error) = engine.client.request("initialize", json!({"clientInfo":{"name":"oriel","title":"Oriel","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await {
            return match engine.stop().await {
                Ok(()) => Err(error),
                Err(stop) => Err(error.context(format!("Codex cleanup failed: {stop:#}"))),
            };
        }
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

// A watch value retains termination even if it happened before Control began waiting.
async fn wait_engine_end(ended: &mut watch::Receiver<Option<EngineEnd>>) {
    if ended.borrow().is_some() {
        return;
    }
    let _ = ended.changed().await;
}

pub(super) struct Control {
    shutdown: watch::Sender<bool>,
    pub task: JoinHandle<Result<()>>,
}
impl Control {
    pub async fn stop(&mut self) -> Result<()> {
        let _ = self.shutdown.send(true);
        (&mut self.task)
            .await
            .context("Codex control task failed")?
    }
}
impl Drop for Control {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}

fn batchable_output(event: &Value) -> bool {
    event["type"] == "event"
        && event["message"].get("id").is_none()
        && matches!(
            event["message"]["method"].as_str(),
            Some(
                "item/agentMessage/delta"
                    | "item/commandExecution/outputDelta"
                    | "item/fileChange/outputDelta"
                    | "item/reasoning/textDelta"
                    | "item/reasoning/summaryTextDelta"
            )
        )
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
    let (shutdown, stopping) = watch::channel(false);
    let task = tokio::spawn(async move {
        let home = git::state_root().and_then(|root| {
            let path = root
                .join("codex")
                .join(&identity.device_id)
                .join(random_hex::<8>()?);
            git::private_directory(&path)?;
            Ok(path)
        })?;
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
        prepared?;
        let auth = workflow::ModelAuth(stable.join(".codex/auth.json"));
        let transcript = home.join("transcript.jsonl");
        let stderr = home.join("stderr.log");
        git::private_file(&transcript, b"")?;
        git::private_file(&stderr, b"")?;
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
            .stderr(fs::OpenOptions::new().write(true).open(&stderr)?);
        if let Some(key) = std::env::var_os("OPENAI_API_KEY") {
            command.env("OPENAI_API_KEY", key);
        }
        let engine =
            Engine::spawn(command, &cwd, "相談・レビュー", false, false, &transcript).await?;
        let endpoint = origin.join(&format!("/api/codex/{}/host", identity.device_id))?;
        let result = control_engine(engine, hub, endpoint, identity.host_token, stopping).await;
        drop(auth);
        result
    });
    Ok(Control { shutdown, task })
}

async fn control_engine(
    mut engine: Engine,
    hub: Hub,
    endpoint: Url,
    host_token: String,
    mut stopping: watch::Receiver<bool>,
) -> Result<()> {
    let mut ended = engine.ended.clone();
    let mut events = hub.events.subscribe();
    loop {
        if *stopping.borrow() {
            break;
        }
        let mut opened = None;
        let mut last_reply = None;
        let connected = async {
            let mut url = endpoint.clone();
            url.set_scheme(if endpoint.scheme() == "https" {
                "wss"
            } else {
                "ws"
            })
            .map_err(|_| anyhow!("invalid Relay URL"))?;
            let mut request = url.as_str().into_client_request()?;
            let mut token = tokio_tungstenite::tungstenite::http::HeaderValue::from_str(&format!(
                "Bearer {}",
                host_token
            ))?;
            token.set_sensitive(true);
            request.headers_mut().insert("Authorization", token);
            let (mut socket, response) =
                tokio::time::timeout(Duration::from_secs(12), connect_async(request)).await??;
            let batching = response
                .headers()
                .get("x-oriel-output-batch")
                .is_some_and(|value| value == "200");
            let mut pending = Vec::<Value>::new();
            let mut pending_bytes = 0;
            let mut flush = tokio::time::interval(Duration::from_millis(200));
            flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            opened = Some(tokio::time::Instant::now());
            socket
                .send(Message::Text(hub.state().to_string().into()))
                .await?;
            let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
            let mut deadline = tokio::time::Instant::now() + Duration::from_secs(45);
            loop {
                tokio::select! {
                    _ = flush.tick(), if !pending.is_empty() => {
                        socket.send(Message::Text(json!({"type":"events", "events":std::mem::take(&mut pending)}).to_string().into())).await?;
                        pending_bytes = 0;
                    },
                    _ = heartbeat.tick() => { socket.send(Message::Text(KEEPALIVE_PING.into())).await?; },
                    _ = tokio::time::sleep_until(deadline) => bail!("Codex Relay keepalive timed out"),
                    event = events.recv() => { match event {
                        Ok(event) => {
                            let output = batching && batchable_output(&event);
                            let size = event.to_string().len();
                            if !pending.is_empty() && (!output || pending.len() >= 128 || pending_bytes + size > 256 * 1024) {
                                socket.send(Message::Text(json!({"type":"events", "events":std::mem::take(&mut pending)}).to_string().into())).await?;
                                pending_bytes = 0;
                            }
                            if output && size <= 256 * 1024 {
                                pending_bytes += size;
                                pending.push(event);
                            } else { socket.send(Message::Text(event.to_string().into())).await?; }
                        },
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            if !pending.is_empty() {
                                socket.send(Message::Text(json!({"type":"events", "events":std::mem::take(&mut pending)}).to_string().into())).await?;
                                pending_bytes = 0;
                            }
                            socket.send(Message::Text(hub.state().to_string().into())).await?;
                        },
                        Err(_) => break,
                    } },
                    frame = socket.next() => {
                        match frame.context("Codex Relay ended")?? {
                            Message::Text(text) => {
                                last_reply = Some(tokio::time::Instant::now());
                                deadline = tokio::time::Instant::now() + Duration::from_secs(45);
                                if text.as_str() == KEEPALIVE_PONG { continue; }
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
                            Message::Close(frame) => {
                                // Receiving Close queues its reply; send it before dropping TCP.
                                let _ = socket.flush().await;
                                return Err(crate::relay_closed(frame));
                            },
                            _ => {},
                        }
                    }
                }
            }
            Ok::<(), anyhow::Error>(())
        };
        let connected = tokio::select! {
            biased;
            _ = stopping.changed() => break,
            _ = wait_engine_end(&mut ended) => break,
            result = connected => result,
        };
        if let Err(error) = connected {
            if let Some(opened) = opened {
                let silence = last_reply.unwrap_or(opened).elapsed().as_secs();
                tracing::warn!(
                    "Codex Web connection interrupted: {error:#}; connected for {}s, no Relay reply for {silence}s; retrying in 15s",
                    opened.elapsed().as_secs()
                );
            } else {
                tracing::warn!("Codex Web connection unavailable: {error:#}; retrying in 15s");
            }
        }
        tokio::select! { biased; _ = stopping.changed() => break, _ = wait_engine_end(&mut ended) => break, _ = tokio::time::sleep(Duration::from_secs(15)) => {} }
    }
    let reason = ended.borrow().clone();
    let cleanup = engine.stop().await;
    if let Some(reason) = reason {
        let error = anyhow!("{reason}; restart `orield codex` to restore the consultation service");
        return match cleanup {
            Ok(()) => Err(error),
            Err(cleanup) => Err(error.context(format!("Codex cleanup failed: {cleanup:#}"))),
        };
    }
    cleanup
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn resume_notifies_a_waiting_workflow_without_provider_polling() {
        let hub = super::Hub::new();
        let notified = super::workflow_changed();
        tokio::pin!(notified);
        hub.dispatch(&serde_json::json!({"method":"workflow/pause"}))
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), &mut notified)
            .await
            .unwrap();
        assert!(hub.paused.load(std::sync::atomic::Ordering::SeqCst));
        let notified = super::workflow_changed();
        hub.dispatch(&serde_json::json!({"method":"workflow/resume"}))
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), notified)
            .await
            .unwrap();
        assert!(!hub.paused.load(std::sync::atomic::Ordering::SeqCst));
    }
    use super::*;

    // Exercise the production connection future, including a stalled handshake.
    // Each engine owns an isolated Hub; no identity or provider files are needed.
    #[tokio::test]
    async fn consultation_exit_cancels_every_relay_phase() {
        for phase in ["handshake", "connected", "retry"] {
            for ending in ["zero", "nonzero", "eof", "protocol", "shutdown"] {
                let path = std::env::temp_dir()
                    .join(format!("oriel-control-{}", random_hex::<8>().unwrap()));
                git::private_directory(&path).unwrap();
                let transcript = path.join("transcript");
                git::private_file(&transcript, b"").unwrap();
                let mut command = Command::new("node");
                command.args(["-e", r#"
                    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
                        const m=JSON.parse(line);
                        if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\n');
                        if(m.method==='end'){
                            switch(process.argv[1]){
                                case 'zero':process.exit(0);break;
                                case 'nonzero':process.exit(7);break;
                                // stdout.end() leaves Node's stdout descriptor open.
                                // Close only stdout, keeping the process alive to test EOF.
                                case 'eof':require('node:fs').closeSync(1);break;
                                case 'protocol':process.stdout.write('invalid json\n');break;
                            }
                        }
                    });
                "#, ending]);
                let engine = Engine::spawn_with_hub(
                    command,
                    &path,
                    "consultation",
                    false,
                    true,
                    &transcript,
                    Hub::new(),
                )
                .await
                .unwrap();
                let client = engine.client.clone();
                let ended = engine.ended.clone();
                let hub = engine.hub.clone();
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let endpoint =
                    Url::parse(&format!("http://{}/host", listener.local_addr().unwrap())).unwrap();
                let (ready, waiting) = oneshot::channel();
                let relay = tokio::spawn(async move {
                    let (stream, _) = listener.accept().await.unwrap();
                    if phase == "handshake" {
                        ready.send(()).unwrap();
                        let mut stream = stream;
                        let mut bytes = [0; 1024];
                        use tokio::io::AsyncReadExt;
                        while stream.read(&mut bytes).await.unwrap() != 0 {}
                    } else {
                        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                        socket.next().await.unwrap().unwrap(); // initial state
                        if phase == "retry" {
                            socket.close(None).await.unwrap();
                        }
                        ready.send(()).unwrap();
                        while let Some(Ok(_)) = socket.next().await {}
                    }
                });
                let (shutdown, stopping) = watch::channel(false);
                let control = tokio::spawn(control_engine(
                    engine,
                    hub.clone(),
                    endpoint,
                    "fixture".into(),
                    stopping,
                ));
                tokio::time::timeout(Duration::from_secs(5), waiting)
                    .await
                    .unwrap()
                    .unwrap();
                if phase == "retry" {
                    // Allow the close frame to move Control into its 15 second delay.
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                assert!(
                    ended.borrow().is_none(),
                    "Relay disconnection must preserve the engine"
                );
                if ending == "shutdown" {
                    shutdown.send(true).unwrap();
                    tokio::time::timeout(Duration::from_secs(5), control)
                        .await
                        .unwrap()
                        .unwrap()
                        .unwrap();
                    tokio::time::timeout(Duration::from_secs(5), relay)
                        .await
                        .unwrap()
                        .unwrap();
                    assert!(hub.engines.lock().unwrap().is_empty());
                    fs::remove_dir_all(path).unwrap();
                    continue;
                }
                let ending_request =
                    tokio::spawn(async move { client.request("end", json!({})).await });
                let error = tokio::time::timeout(Duration::from_secs(5), control)
                    .await
                    .unwrap_or_else(|_| {
                        panic!("Control did not stop: phase={phase}, ending={ending}")
                    })
                    .unwrap()
                    .unwrap_err();
                assert!(format!("{error:#}").contains("restart `orield codex`"));
                assert!(hub.engines.lock().unwrap().is_empty());
                assert!(ending_request.await.unwrap().is_err());
                tokio::time::timeout(Duration::from_secs(5), relay)
                    .await
                    .unwrap()
                    .unwrap();
                fs::remove_dir_all(path).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn termination_notification_is_retained_and_interrupts_pending_work() {
        for already_ended in [false, true] {
            let (sender, mut ended) = watch::channel(None);
            if already_ended {
                sender.send_replace(Some(EngineEnd::Failed("protocol ended".to_owned())));
            }
            let waiting = async {
                tokio::select! {
                    _ = wait_engine_end(&mut ended) => {},
                    _ = std::future::pending::<()>() => unreachable!(),
                }
            };
            let notify = async {
                tokio::task::yield_now().await;
                sender.send_replace(Some(EngineEnd::Failed("protocol ended".to_owned())));
            };
            tokio::time::timeout(Duration::from_secs(1), async {
                tokio::join!(waiting, notify);
            })
            .await
            .unwrap();
            assert!(ended.borrow().is_some());
        }
    }

    #[test]
    fn command_output_tails_fit_relay_frames_in_events_and_thread_replies() {
        // Control bytes expand to six bytes each in JSON; multibyte characters
        // must also survive truncation at a byte boundary.
        for output in ["\0".repeat(700 * 1024), "あ".repeat(300 * 1024)] {
            let item = json!({"id":"command","type":"commandExecution","status":"completed","aggregatedOutput":output});
            for mut message in [
                json!({"type":"event","engine":"engine","message":{"method":"item/completed","params":{"item":item}}}),
                json!({"type":"response","result":{"thread":{"turns":[{"items":[item]}]}}}),
            ] {
                trim_command_output(&mut message);
                assert!(message.to_string().len() < MAX_MESSAGE);
                let tail = message
                    .pointer("/message/params/item/aggregatedOutput")
                    .or_else(|| message.pointer("/result/thread/turns/0/items/0/aggregatedOutput"))
                    .unwrap()
                    .as_str()
                    .unwrap();
                let (_, tail) = tail.split_once('\n').unwrap();
                assert!(tail.len() <= COMMAND_OUTPUT_TAIL);
                assert!(output.ends_with(tail));
            }
        }
    }

    #[test]
    fn batching_accepts_output_only_and_keeps_approval_and_control_immediate() {
        for method in [
            "item/agentMessage/delta",
            "item/commandExecution/outputDelta",
            "item/fileChange/outputDelta",
            "item/reasoning/textDelta",
            "item/reasoning/summaryTextDelta",
        ] {
            assert!(batchable_output(
                &json!({"type":"event", "engine":"engine", "message":{"method":method,"params":{"delta":"output"}}})
            ));
            assert!(!batchable_output(
                &json!({"type":"event", "message":{"method":method,"id":"approval"}})
            ));
        }
        for event in [
            json!({"type":"response"}),
            json!({"type":"state"}),
            json!({"type":"event","message":{"method":"item/commandExecution/requestApproval","id":1}}),
            json!({"type":"event","message":{"method":"turn/completed"}}),
        ] {
            assert!(!batchable_output(&event));
        }
    }

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
            json!({"approvalsReviewer":"auto_review"}),
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

    // The child announces readiness only after it has stopped consuming stdin.
    // Large IDs make even a small valid question answer exceed pipe capacity.
    async fn blocked_engine(question: bool) -> (Engine, PathBuf, u32, u32) {
        let path =
            std::env::temp_dir().join(format!("oriel-blocked-{}", random_hex::<8>().unwrap()));
        git::private_directory(&path).unwrap();
        let transcript = path.join("transcript");
        git::private_file(&transcript, b"").unwrap();
        let script = r#"
            const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
            const lines=require('node:readline').createInterface({input:process.stdin});
            lines.on('line', line=>{
                const m=JSON.parse(line);
                if(m.method==='initialize')send({id:m.id,result:{}});
                if(m.method==='arm'){
                    lines.pause(); process.stdin.pause();
                    const child=require('node:child_process').spawn(process.execPath,
                        ['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
                    child.on('spawn',()=>{
                        send({id:m.id,result:{pid:process.pid,descendant:child.pid}});
                        if(m.params.question)send({id:'q'.repeat(2*1024*1024),
                            method:'item/tool/requestUserInput',
                            params:{questions:[{id:'choice',question:'Choose'}]}});
                        send({method:'fixture/ready'});
                    });
                }
            });
        "#;
        let mut command = Command::new("node");
        command.args(["-e", script]);
        let engine = Engine::spawn(command, &path, "blocked", false, true, &transcript)
            .await
            .unwrap();
        let mut events = engine.client.subscribe();
        let info = engine
            .client
            .request("arm", json!({"question":question}))
            .await
            .unwrap();
        loop {
            if tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .unwrap()
                .unwrap()["method"]
                == "fixture/ready"
            {
                break;
            }
        }
        (
            engine,
            path,
            info["pid"].as_u64().unwrap() as u32,
            info["descendant"].as_u64().unwrap() as u32,
        )
    }

    async fn assert_stopped(pid: u32, descendant: u32) {
        assert!(
            !Path::new(&format!("/proc/{pid}")).exists(),
            "direct child was not reaped"
        );
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let state = fs::read_to_string(format!("/proc/{descendant}/stat")).ok();
                if state
                    .as_ref()
                    .is_none_or(|s| s.rsplit_once(") ").unwrap().1.starts_with('Z'))
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn blocked_writes_stop_for_all_workflow_guard_reasons() {
        for question in [false, true] {
            for reason in [
                workflow::Stop::Changed,
                workflow::Stop::Uncertain,
                workflow::Stop::RateLimited(120),
                workflow::Stop::WebPaused,
            ] {
                let expected = reason.to_string();
                let (mut engine, path, pid, descendant) = blocked_engine(question).await;
                let client = engine.client.clone();
                let mut blocked = tokio::spawn(async move {
                    if question {
                        client
                            .remote(
                                "request/respond",
                                json!({
                                    "requestId":"q".repeat(2*1024*1024), "decision":"answer",
                                    "answers":{"choice":{"answers":["yes"]}}
                                }),
                            )
                            .await
                    } else {
                        client
                            .request("large", json!({"text":"x".repeat(2*1024*1024)}))
                            .await
                    }
                });
                // Poll the actual request: a ready fixture and an unfinished request,
                // rather than a sleep alone, establish the blocked protocol.
                assert!(
                    tokio::time::timeout(Duration::from_millis(150), &mut blocked)
                        .await
                        .is_err()
                );
                let mut queued = Vec::new();
                for _ in 0..40 {
                    let client = engine.client.clone();
                    queued.push(tokio::spawn(async move {
                        client.request("queued", json!({})).await
                    }));
                }
                let marker = path.join("follow-up");
                let outcome = tokio::time::timeout(Duration::from_secs(5), async {
                    workflow::stop_engine(&mut engine, Err(reason.into())).await?;
                    fs::write(&marker, b"credentials or publication")?;
                    Ok::<_, anyhow::Error>(())
                })
                .await
                .unwrap()
                .unwrap_err();
                assert_eq!(
                    outcome
                        .downcast_ref::<workflow::Stop>()
                        .unwrap()
                        .to_string(),
                    expected
                );
                assert!(!marker.exists());
                assert!(blocked.await.unwrap().is_err());
                for request in queued {
                    assert!(
                        tokio::time::timeout(Duration::from_secs(5), request)
                            .await
                            .unwrap()
                            .unwrap()
                            .is_err()
                    );
                }
                assert!(engine.client.pending.lock().unwrap().is_empty());
                assert!(engine.hub.engines.lock().unwrap().is_empty());
                engine.stop().await.unwrap();
                assert_stopped(pid, descendant).await;
                fs::remove_dir_all(path).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn stopping_workflow_engine_does_not_notify_consultation() {
        for unexpected in [false, true] {
            let (mut consultation, path, pid, descendant) = blocked_engine(false).await;
            let (mut workflow, work_path, work_pid, work_descendant) = blocked_engine(false).await;
            if unexpected {
                git::stop_group(work_pid).unwrap();
                tokio::time::timeout(Duration::from_secs(5), wait_engine_end(&mut workflow.ended))
                    .await
                    .unwrap();
                assert!(matches!(*workflow.ended.borrow(), Some(EngineEnd::Eof)));
            }
            workflow.stop().await.unwrap();
            assert!(consultation.ended.borrow().is_none());
            assert!(!consultation.client.sender.is_closed());
            consultation.stop().await.unwrap();
            assert!(matches!(
                *consultation.ended.borrow(),
                Some(EngineEnd::Stopped)
            ));
            assert_stopped(pid, descendant).await;
            assert_stopped(work_pid, work_descendant).await;
            fs::remove_dir_all(path).unwrap();
            fs::remove_dir_all(work_path).unwrap();
        }
    }

    #[tokio::test]
    async fn dropping_blocked_engine_reaps_the_owned_group() {
        let (engine, path, pid, descendant) = blocked_engine(false).await;
        let client = engine.client.clone();
        let hub = engine.hub.clone();
        drop(engine);
        tokio::time::timeout(Duration::from_secs(5), async {
            while !client.sender.is_closed() || !hub.engines.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_stopped(pid, descendant).await;
        fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn initialization_failure_and_natural_exit_reap_descendants() {
        for invalid in [false, true] {
            let path =
                std::env::temp_dir().join(format!("oriel-exit-{}", random_hex::<8>().unwrap()));
            git::private_directory(&path).unwrap();
            let transcript = path.join("transcript");
            git::private_file(&transcript, b"").unwrap();
            let script = r#"
                const child=require('node:child_process').spawn(process.execPath,
                    ['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
                child.on('spawn',()=>{
                    require('node:fs').writeFileSync('pids',JSON.stringify([process.pid,child.pid]));
                    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
                        const m=JSON.parse(line);
                        if(m.method==='initialize'){
                            process.stdout.write(JSON.stringify({id:m.id,
                                ...(process.argv[1]==='invalid'?{error:{message:'fixture failure'}}:{result:{}})})+'\n');
                        }
                        if(m.method==='initialized')process.exit(0);
                    });
                });
            "#;
            let mut command = Command::new("node");
            command.current_dir(&path).args([
                "-e",
                script,
                if invalid { "invalid" } else { "valid" },
            ]);
            let result = Engine::spawn(command, &path, "exit", false, true, &transcript).await;
            if invalid {
                assert!(result.is_err());
            } else {
                let mut engine = result.unwrap();
                tokio::time::timeout(Duration::from_secs(5), async {
                    while !engine.client.sender.is_closed() {
                        tokio::task::yield_now().await;
                    }
                    wait_engine_end(&mut engine.ended).await;
                    assert!(
                        engine
                            .ended
                            .borrow()
                            .as_ref()
                            .unwrap()
                            .to_string()
                            .contains("app-server closed stdout")
                    );
                    engine.stop().await.unwrap();
                })
                .await
                .unwrap();
                engine.stop().await.unwrap();
            }
            let pids: Vec<u32> =
                serde_json::from_slice(&fs::read(path.join("pids")).unwrap()).unwrap();
            assert_stopped(pids[0], pids[1]).await;
            fs::remove_dir_all(path).unwrap();
        }
    }

    #[tokio::test]
    async fn failed_stop_blocks_follow_up_and_retains_reason() {
        let (mut engine, path, pid, descendant) = blocked_engine(false).await;
        engine.stop().await.unwrap();
        // Inject a recorded shutdown failure without sending any signal to a reaped PID.
        engine.stop_error = Some("fixture wait failure".into());
        let error = workflow::stop_engine(&mut engine, Err(workflow::Stop::WebPaused.into()))
            .await
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<workflow::Stop>(),
            Some(workflow::Stop::WebPaused)
        ));
        assert!(format!("{error:#}").contains("fixture wait failure"));
        assert!(
            workflow::stop_engine(&mut engine, Ok("done".into()))
                .await
                .is_err()
        );
        assert_stopped(pid, descendant).await;
        fs::remove_dir_all(path).unwrap();
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
                if(m.params.developerInstructions==='invalid'){process.stdout.write('{invalid}\n');return;}
                if(m.params.developerInstructions){
                  const readOnly=m.params.developerInstructions==='plan';
                  if(m.params.sandbox!==(readOnly?'read-only':null) || m.params.approvalPolicy!=='on-request' || m.params.approvalsReviewer!==(readOnly?'user':'auto_review'))process.exit(3);
                }
                if(m.params.developerInstructions)for(let i=0;i<600;i++)send({method:'item/commandExecution/outputDelta',params:{delta:'compiling\n'}});
                if(m.params.developerInstructions==='overflow')for(let i=0;i<600;i++)send({method:'configWarning',params:{message:'notice'}});
                send({id:m.id,result:{thread:{id:'owned'}}});
                send({id:'approval',method:'item/fileChange/requestApproval',params:{threadId:'owned'}});return;
              }
              if(m.method==='turn/start'){
                send({id:m.id,result:{turn:{id:'turn'}}});
                send({method:'item/completed',params:{threadId:'owned',item:{id:'large-output',type:'commandExecution',status:'completed',aggregatedOutput:'x'.repeat(700*1024)}}});
                send({method:'item/completed',params:{threadId:'owned',item:{type:'agentMessage',text:'{"summary":"done"}'}}});
                send({method:'turn/completed',params:{threadId:'owned',turn:{id:'turn',status:'completed'}}});return;
              }
              if(m.method==='turn/interrupt'){send({id:m.id,result:{}});return;}
            });
        "#;
        let mut command = Command::new("node");
        command.args(["-e", script]);
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
        let output = loop {
            let event = events.try_recv().unwrap();
            if event["params"]["item"]["id"] == "large-output" {
                break event;
            }
        };
        assert_eq!(output["params"]["item"]["status"], "completed");
        assert!(output.to_string().len() < MAX_MESSAGE);
        assert!(
            fs::read_to_string(&transcript)
                .unwrap()
                .lines()
                .any(|line| {
                    let event: Value = serde_json::from_str(line).unwrap();
                    event["params"]["item"]["aggregatedOutput"]
                        .as_str()
                        .is_some_and(|output| output.len() == 700 * 1024)
                })
        );
        assert_eq!(
            engine
                .run("plan", json!({"type":"object"}), true)
                .await
                .unwrap(),
            "{\"summary\":\"done\"}"
        );
        let overflow = engine
            .run("overflow", json!({"type":"object"}), false)
            .await
            .unwrap_err();
        assert!(matches!(
            overflow.downcast_ref::<workflow::Stop>(),
            Some(workflow::Stop::Uncertain)
        ));
        assert!(
            engine
                .run("invalid", json!({"type":"object"}), false)
                .await
                .is_err()
        );
        engine.stop().await.unwrap();
        let log = fs::read_to_string(&transcript).unwrap();
        let failure: Value = serde_json::from_str(log.lines().last().unwrap()).unwrap();
        assert_eq!(failure["method"], "oriel/engineEnded");
        assert!(
            failure["params"]["error"]
                .as_str()
                .is_some_and(|error| !error.is_empty())
        );
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
