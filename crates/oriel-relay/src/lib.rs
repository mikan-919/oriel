use std::{cell::RefCell, collections::HashMap, rc::Rc};
use worker::{wasm_bindgen::JsCast, *};

const HOST_TAG: &str = "host";
const CLIENT_TAG: &str = "client";

fn parse_route(path: &str) -> Option<(&str, &str)> {
    let mut segments = path.strip_prefix('/')?.split('/');

    if segments.next()? != "device" {
        return None;
    }

    let device_id = segments.next()?;
    let role = segments.next()?;

    if segments.next().is_some() {
        return None;
    }

    if !is_lower_hex(device_id, 32) {
        return None;
    }

    if role != HOST_TAG && role != CLIENT_TAG {
        return None;
    }

    Some((device_id, role))
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct TerminalSession {
    connection_id: String,
    session_hash: String,
    user_id: String,
    device_id: String,
    expires_at: u64,
    #[serde(default)]
    revoked: bool,
}

#[derive(Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum TerminalExit {
    Exited { code: u32, signal: Option<String> },
    WaitFailed,
}
const EXIT: &str = "oriel-terminal-exit:";
const CONTROL: &str = "oriel-heartbeat:";
#[derive(Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
struct Presence {
    generation: u64,
    #[serde(default)]
    terminal_exit: Option<TerminalExit>,
    #[serde(default)]
    next_heartbeat: Option<u64>,
    last_reply: Option<u64>,
    deadline: Option<u64>,
    challenge: String,
    offline: bool,
    #[serde(default)]
    disconnected: bool,
    #[serde(default)]
    automatic: bool,
}
impl Presence {
    fn status(&self, now: u64) -> &'static str {
        if self.offline
            || self.deadline.is_some_and(|d| now >= d)
            || self.last_reply.is_some_and(|r| now >= r + 35_000)
        {
            "offline"
        } else if self.deadline.is_some() || self.last_reply.is_some_and(|r| now >= r + 30_000) {
            "grace"
        } else if self.last_reply.is_some() {
            "online"
        } else {
            "unknown"
        }
    }
}
#[durable_object]
pub struct RelayDevice {
    state: State,
    env: Env,
    cached: Rc<RefCell<Presence>>,
    revoked: RefCell<HashMap<String, u64>>,
}
impl RelayDevice {
    fn live(&self, socket: &WebSocket) -> Option<TerminalSession> {
        let grant = socket
            .deserialize_attachment::<TerminalSession>()
            .ok()
            .flatten()?;
        let open = js_sys::Reflect::get(socket.as_ref(), &"readyState".into())
            .ok()
            .and_then(|v| v.as_f64())
            == Some(1.0);
        if !open || grant.revoked || Date::now().as_millis() >= grant.expires_at {
            return None;
        }
        Some(grant)
    }
    fn close_client(&self, socket: &WebSocket) {
        if let Ok(Some(mut grant)) = socket.deserialize_attachment::<TerminalSession>() {
            if !grant.revoked {
                self.release(&grant);
            }
            grant.revoked = true;
            let _ = socket.serialize_attachment(&grant);
        }
        let _ = socket.close(Some(4003), Some("Terminal session expired or revoked"));
    }
    fn release(&self, grant: &TerminalSession) {
        let env = self.env.clone();
        let grant = grant.clone();
        self.state.wait_until(async move {
            let release = async {
                let request = Request::new_with_init(
                    "https://internal/terminal-release",
                    RequestInit::new()
                        .with_method(Method::Post)
                        .with_body(Some(serde_json::to_string(&grant)?.into())),
                )?;
                env.durable_object("ACCOUNTS")?
                    .id_from_name("accounts")?
                    .get_stub()?
                    .fetch_with_request(request)
                    .await?;
                Result::<()>::Ok(())
            };
            // Failed cleanup is harmless: logout can still notify this device,
            // and the account removes expired registrations later.
            let _ = release.await;
        });
    }
    async fn authorized(&self, grant: &TerminalSession) -> bool {
        if self.revoked.borrow().contains_key(&grant.session_hash) {
            return false;
        }
        let check = async {
            let request = Request::new_with_init(
                "https://internal/terminal-session",
                RequestInit::new()
                    .with_method(Method::Post)
                    .with_body(Some(serde_json::to_string(grant)?.into())),
            )?;
            let response = self
                .env
                .durable_object("ACCOUNTS")?
                .id_from_name("accounts")?
                .get_stub()?
                .fetch_with_request(request)
                .await?;
            Result::<bool>::Ok(response.status_code() == 200)
        };
        let valid = check.await.unwrap_or(false);
        valid && !self.revoked.borrow().contains_key(&grant.session_hash)
    }
    fn notify(&self) {
        let Some(device_id) = self.state.id().name() else {
            return;
        };
        let env = self.env.clone();
        self.state.wait_until(async move {
            let send = async {
                let namespace = env.durable_object("ACCOUNTS")?;
                let request = Request::new_with_init(
                    "https://internal/terminal-change",
                    RequestInit::new()
                        .with_method(Method::Post)
                        .with_body(Some(format!("{{\"device_id\":\"{device_id}\"}}").into())),
                )?;
                namespace
                    .id_from_name("accounts")?
                    .get_stub()?
                    .fetch_with_request(request)
                    .await?;
                Result::<()>::Ok(())
            };
            if send.await.is_err() {
                console_warn!("Terminal state notification unavailable");
            }
        });
    }
    fn presence(&self) -> Result<Presence> {
        let mut p = self.cached.borrow().clone();
        for socket in self.state.get_websockets_with_tag(HOST_TAG) {
            if !self.current(&socket, &p) {
                continue;
            }
            if !p.disconnected && !p.offline {
                if let Ok(Some(saved)) = socket.deserialize_attachment::<Presence>() {
                    p = saved;
                }
                let method = js_sys::Reflect::get(
                    self.state.as_raw().as_ref(),
                    &"getWebSocketAutoResponseTimestamp".into(),
                )?
                .dyn_into::<js_sys::Function>()?;
                let timestamp = method.call1(self.state.as_raw().as_ref(), socket.as_ref())?;
                if !timestamp.is_null() && !timestamp.is_undefined() {
                    let millis = js_sys::Date::from(timestamp).get_time() as u64;
                    p.last_reply = Some(p.last_reply.unwrap_or(0).max(millis));
                    p.automatic = true;
                    p.deadline = None;
                }
            }
        }
        Ok(p)
    }
    fn remember(&self, p: &Presence) -> Result<()> {
        *self.cached.borrow_mut() = p.clone();
        for socket in self.state.get_websockets_with_tag(HOST_TAG) {
            if self.current(&socket, p) {
                socket.serialize_attachment(p)?;
            }
        }
        Ok(())
    }
    async fn schedule(&self, p: &Presence) -> Result<()> {
        let now = Date::now().as_millis();
        let next = p.deadline.or(p.last_reply.map(|r| r + 30_000));
        let due = if p.automatic {
            // Keep a thirty-second cadence even when a ten-second ping and
            // the alarm coincide. Never schedule beyond the offline deadline.
            p.deadline.unwrap_or_else(|| {
                (now + 30_000).min(p.last_reply.map_or(now + 30_000, |r| r + 35_000))
            })
        } else {
            next.map_or(p.next_heartbeat.unwrap_or(now + 10_000), |deadline| {
                deadline.min(p.next_heartbeat.unwrap_or(now + 10_000))
            })
        };
        let browser_due = self
            .state
            .get_websockets_with_tag(CLIENT_TAG)
            .iter()
            .filter_map(|s| self.live(s).map(|g| g.expires_at))
            .min();
        let due = match (p.offline, browser_due) {
            (true, None) => return Ok(()),
            (true, Some(expiry)) => expiry,
            (false, Some(expiry)) => due.min(expiry),
            (false, None) => due,
        };
        self.state
            .storage()
            .set_alarm(due.saturating_sub(now).max(1) as i64)
            .await?;
        Ok(())
    }
    fn current(&self, socket: &WebSocket, p: &Presence) -> bool {
        (socket
            .deserialize_attachment::<Presence>()
            .ok()
            .flatten()
            .map(|saved| saved.generation)
            .or_else(|| socket.deserialize_attachment::<u64>().ok().flatten()))
            == Some(p.generation)
            && self
                .state
                .get_tags(socket)
                .iter()
                .any(|tag| tag == HOST_TAG)
    }
    async fn save(&self, p: &Presence) -> Result<()> {
        self.remember(p)?;
        self.state.storage().put("presence", p).await?;
        self.notify();
        self.schedule(p).await
    }
    async fn evaluate(&self) -> Result<Presence> {
        for socket in self.state.get_websockets_with_tag(CLIENT_TAG) {
            if self.live(&socket).is_none() {
                self.close_client(&socket);
            }
        }
        let mut p = self.presence()?;
        let previous = p.clone();
        let now = Date::now().as_millis();
        let hosts = self.state.get_websockets_with_tag(HOST_TAG);
        if (hosts.is_empty()
            || (p.generation > 0 && !hosts.iter().any(|socket| self.current(socket, &p))))
            && p.deadline.is_none()
        {
            p.offline = true;
        }
        if p.deadline.is_none() && p.last_reply.is_some_and(|r| now >= r + 30_000) {
            p.deadline = p.last_reply.map(|r| r + 35_000);
        }
        if p.deadline.is_some_and(|d| now >= d) {
            p.offline = true;
            for s in hosts
                .into_iter()
                .chain(self.state.get_websockets_with_tag(CLIENT_TAG))
            {
                let _ = s.close(Some(4001), Some("Terminal host unavailable"));
            }
        }
        if p.offline != previous.offline {
            self.save(&p).await?;
        } else {
            self.remember(&p)?;
        }
        Ok(p)
    }
    async fn disconnected(&self, socket: WebSocket) -> Result<()> {
        if self
            .state
            .get_tags(&socket)
            .iter()
            .any(|tag| tag == CLIENT_TAG)
        {
            self.close_client(&socket);
            return Ok(());
        }
        let mut p = self.presence()?;
        if self.current(&socket, &p) && !p.offline {
            p.disconnected = true;
            if p.deadline.is_none() {
                p.deadline = Some(Date::now().as_millis() + 5_000);
            }
            self.save(&p).await?;
        }
        Ok(())
    }
}
impl DurableObject for RelayDevice {
    fn new(state: State, env: Env) -> Self {
        let cached = Rc::new(RefCell::new(Presence::default()));
        // Hibernation keeps attachments. A connected host needs no KV read
        // on wake; storage is only the fallback for a disconnect or migration.
        let attached = state
            .get_websockets_with_tag(HOST_TAG)
            .into_iter()
            .filter(|socket| {
                js_sys::Reflect::get(socket.as_ref(), &"readyState".into())
                    .ok()
                    .and_then(|value| value.as_f64())
                    == Some(1.0)
            })
            .filter_map(|socket| socket.deserialize_attachment::<Presence>().ok().flatten())
            .filter(|p| !p.disconnected && !p.offline)
            .max_by_key(|p| p.generation);
        let (slot, storage) = (cached.clone(), state.storage());
        let _init = state.block_concurrency_while(async move {
            *slot.borrow_mut() = match attached {
                Some(p) => p,
                None => storage.get("presence").await?.unwrap_or_default(),
            };
            Ok(())
        });
        state.set_websocket_auto_response(
            &worker_sys::WebSocketRequestResponsePair::new("oriel:ping", "oriel:pong").unwrap(),
        );
        let relay = Self {
            state,
            env,
            cached,
            revoked: RefCell::new(HashMap::new()),
        };
        for socket in relay.state.get_websockets_with_tag(CLIENT_TAG) {
            if relay.live(&socket).is_none() {
                relay.close_client(&socket);
            }
        }
        relay
    }
    async fn fetch(&self, mut req: Request) -> Result<Response> {
        if req.path() == "/internal/revoke" && req.method() == Method::Post {
            #[derive(serde::Deserialize)]
            struct Revocation {
                session_hash: String,
                expires_at: u64,
            }
            let revocation: Revocation = req.json().await?;
            let hash = revocation.session_hash;
            self.revoked
                .borrow_mut()
                .retain(|_, expiry| *expiry > Date::now().as_millis());
            self.revoked
                .borrow_mut()
                .insert(hash.clone(), revocation.expires_at);
            for socket in self.state.get_websockets_with_tag(CLIENT_TAG) {
                if socket
                    .deserialize_attachment::<TerminalSession>()
                    .ok()
                    .flatten()
                    .is_some_and(|g| g.session_hash == hash)
                {
                    self.close_client(&socket);
                }
            }
            return Response::ok("OK");
        }
        if req.path() == "/internal/terminal-status" {
            let p = self.evaluate().await?;
            return Response::from_json(&serde_json::json!({
                "terminal_status": p.status(Date::now().as_millis()),
                "terminal_exit": p.terminal_exit,
            }));
        }
        let path = req.path();
        let Some((_, role)) = parse_route(&path) else {
            return Response::error("Invalid relay route", 404);
        };
        if !req
            .headers()
            .get("Upgrade")?
            .as_deref()
            .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
        {
            return Response::error("Expected WebSocket", 426);
        }
        let mut p = self.evaluate().await?;
        if role == CLIENT_TAG && p.status(Date::now().as_millis()) != "online" {
            return Response::error("Terminal host unavailable or not confirmed", 409);
        }
        let grant = if role == CLIENT_TAG {
            let grant = req
                .headers()
                .get("X-Oriel-Terminal")?
                .and_then(|v| serde_json::from_str::<TerminalSession>(&v).ok());
            let Some(grant) = grant else {
                return Response::error("Session required", 403);
            };
            if grant.device_id != parse_route(&path).unwrap().0
                || grant.revoked
                || Date::now().as_millis() >= grant.expires_at
                || !self.authorized(&grant).await
                || Date::now().as_millis() >= grant.expires_at
            {
                return Response::error("Session revoked", 403);
            }
            // No await between this check and attachment installation. A logout
            // that deletes the session after this check will revoke this socket.
            Some(grant)
        } else {
            None
        };
        let latest = self.presence()?;
        if role == CLIENT_TAG
            && (latest.generation != p.generation
                || latest.status(Date::now().as_millis()) != "online")
        {
            return Response::error("Terminal host changed", 409);
        }
        for socket in self.state.get_websockets_with_tag(role) {
            if role == CLIENT_TAG {
                self.close_client(&socket);
            } else {
                let _ = socket.close(Some(1000), Some("Replaced by a newer connection"));
            }
        }
        let pair = WebSocketPair::new()?;
        self.state.accept_websocket_with_tags(&pair.server, &[role]);
        if let Some(grant) = grant {
            pair.server.serialize_attachment(&grant)?;
            self.schedule(&p).await?;
        }
        if role == HOST_TAG {
            p.generation += 1;
            p.terminal_exit = None;
            p.next_heartbeat = Some(Date::now().as_millis() + 10_000);
            p.last_reply = None;
            if p.offline {
                p.deadline = None;
            }
            p.offline = false;
            p.disconnected = false;
            p.automatic = false;
            p.challenge = format!("{}:{}", p.generation, Date::now().as_millis());
            pair.server.serialize_attachment(&p)?;
            pair.server
                .send_with_str(format!("{CONTROL}{}", p.challenge))?;
            self.save(&p).await?;
        }
        Response::from_websocket(pair.client)
    }
    async fn websocket_message(
        &self,
        socket: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let mut p = self.presence()?;
        let host = self.current(&socket, &p);
        if let WebSocketIncomingMessage::String(text) = &message
            && let Some(payload) = text.strip_prefix(EXIT)
        {
            if host
                && !p.offline
                && let Ok(exit) = serde_json::from_str::<TerminalExit>(payload)
            {
                p.terminal_exit = Some(exit);
                p.offline = true;
                p.challenge.clear();
                p.deadline = None;
                self.remember(&p)?;
                for client in self.state.get_websockets_with_tag(CLIENT_TAG) {
                    let _ = client.send_with_str(text);
                    self.close_client(&client);
                }
                self.save(&p).await?;
                let _ = socket.close(Some(1000), Some("Terminal exited"));
            }
            return Ok(());
        }
        if let WebSocketIncomingMessage::String(text) = &message
            && let Some(reply) = text.strip_prefix(CONTROL)
        {
            if host
                && !p.disconnected
                && !p.challenge.is_empty()
                && reply == p.challenge
                && p.status(Date::now().as_millis()) != "offline"
            {
                // A replayed reply must not extend the host's liveness deadline.
                let already_online = self.cached.borrow().last_reply.is_some()
                    && p.status(Date::now().as_millis()) == "online";
                p.challenge.clear();
                p.last_reply = Some(Date::now().as_millis());
                p.deadline = None;
                self.remember(&p)?;
                self.schedule(&p).await?;
                if !already_online {
                    self.notify();
                }
            }
            return Ok(());
        }
        if p.status(Date::now().as_millis()) != "online" {
            return Ok(());
        }
        let clients = if host {
            self.state.get_websockets_with_tag(CLIENT_TAG)
        } else if self.state.get_tags(&socket).iter().any(|t| t == CLIENT_TAG) {
            vec![socket.clone()]
        } else {
            return Ok(());
        };
        for client in clients {
            let Some(grant) = self.live(&client) else {
                self.close_client(&client);
                continue;
            };
            if !self.authorized(&grant).await {
                self.close_client(&client);
                continue;
            }
            let latest = self.presence()?;
            if self.live(&client).is_none()
                || latest.generation != p.generation
                || latest.status(Date::now().as_millis()) != "online"
                || (host && !self.current(&socket, &latest))
            {
                continue;
            }
            let targets = if host {
                vec![client]
            } else {
                self.state
                    .get_websockets_with_tag(HOST_TAG)
                    .into_iter()
                    .filter(|s| self.current(s, &latest))
                    .collect()
            };
            for target in targets {
                match &message {
                    WebSocketIncomingMessage::String(text) => {
                        let _ = target.send_with_str(text);
                    }
                    WebSocketIncomingMessage::Binary(bytes) => {
                        let _ = target.send_with_bytes(bytes);
                    }
                }
            }
        }
        Ok(())
    }
    async fn websocket_close(
        &self,
        socket: WebSocket,
        _code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> Result<()> {
        self.disconnected(socket).await
    }
    async fn websocket_error(&self, socket: WebSocket, _error: Error) -> Result<()> {
        self.disconnected(socket).await
    }
    async fn alarm(&self) -> Result<Response> {
        let mut p = self.evaluate().await?;
        if !p.offline
            && !p.automatic
            && p.next_heartbeat
                .is_none_or(|due| Date::now().as_millis() >= due)
        {
            p.next_heartbeat = Some(Date::now().as_millis() + 10_000);
            p.challenge = format!("{}:{}", p.generation, Date::now().as_millis());
            self.remember(&p)?;
            for s in self.state.get_websockets_with_tag(HOST_TAG) {
                if self.current(&s, &p) {
                    let _ = s.send_with_str(format!("{CONTROL}{}", p.challenge));
                }
            }
        }
        self.schedule(&p).await?;
        Response::ok("OK")
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_deadlines_and_unknown_hosts() {
        let mut p = Presence::default();
        assert_eq!(p.status(100_000), "unknown");
        p.last_reply = Some(10_000);
        assert_eq!(p.status(39_999), "online");
        assert_eq!(p.status(40_000), "grace");
        assert_eq!(p.status(44_999), "grace");
        assert_eq!(p.status(45_000), "offline");
        p.deadline = Some(45_000);
        assert_eq!(p.status(44_999), "grace");
        assert_eq!(p.status(45_000), "offline");
        p.deadline = Some(12_000);
        assert_eq!(p.status(11_999), "grace");
        assert_eq!(p.status(12_000), "offline");
        p.deadline = None;
        p.last_reply = Some(46_000);
        assert_eq!(p.status(46_000), "online");
        p.offline = true;
        assert_eq!(p.status(46_000), "offline");
    }

    const DEVICE: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn routes_require_exact_ids_and_roles() {
        for role in [HOST_TAG, CLIENT_TAG] {
            let path = format!("/device/{DEVICE}/{role}");
            assert_eq!(parse_route(&path), Some((DEVICE, role)));
        }
        for path in [
            "/device/dev/host".to_string(),
            format!("/device/{}/host", "a".repeat(31)),
            format!("/device/{}/host", "a".repeat(33)),
            format!("/device/{}/host", "A".repeat(32)),
            format!("/device/{}/host", "g".repeat(32)),
            format!("device/{DEVICE}/host"),
            format!("//device/{DEVICE}/host"),
            format!("/device/{DEVICE}/host/"),
            format!("/device/{DEVICE}/host/extra"),
            format!("/device/{DEVICE}/other"),
            format!("/device/{DEVICE}/host?token=ignored"),
        ] {
            assert_eq!(parse_route(&path), None, "{path}");
        }
    }
}
