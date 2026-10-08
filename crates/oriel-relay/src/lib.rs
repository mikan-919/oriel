use worker::*;

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

const PING: &str = "\u{1e}oriel-heartbeat:";
const ACK: &str = "\u{1e}oriel-heartbeat-ack:";
const CONTROL: &str = "\u{1e}oriel-";
const HEARTBEAT_MS: u64 = 10_000;
const TIMEOUT_MS: u64 = 30_000;
const GRACE_MS: u64 = 5_000;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Presence {
    generation: u64,
    status: String,
    last_response: Option<u64>,
    deadline: Option<u64>,
    next_ping: u64,
    sequence: u64,
    pending: Option<String>,
}
impl Presence {
    fn absent() -> Self {
        Self {
            generation: 0,
            status: "offline".into(),
            last_response: None,
            deadline: None,
            next_ping: 0,
            sequence: 0,
            pending: None,
        }
    }
    fn reevaluate(&mut self, now: u64) -> bool {
        if self.status == "online"
            && self
                .last_response
                .is_some_and(|last| now >= last + TIMEOUT_MS)
        {
            self.status = "grace".into();
            self.deadline = self.last_response.map(|last| last + TIMEOUT_MS + GRACE_MS);
        }
        if self.status == "grace" && self.deadline.is_some_and(|deadline| now >= deadline) {
            self.status = "offline".into();
            self.deadline = None;
            self.pending = None;
            return true;
        }
        false
    }
    fn disconnected(&mut self, now: u64) {
        if self.status != "offline" && self.status != "grace" {
            self.status = "grace".into();
            self.deadline = Some(now + GRACE_MS);
        }
    }
}

#[durable_object]
pub struct RelayDevice {
    state: State,
}
impl RelayDevice {
    fn hosts(&self, presence: &Presence) -> Vec<WebSocket> {
        self.state
            .get_websockets_with_tag(HOST_TAG)
            .into_iter()
            .filter(|socket| {
                socket.deserialize_attachment::<u64>().ok().flatten() == Some(presence.generation)
            })
            .collect()
    }
    fn close_all(&self) {
        for socket in self.state.get_websockets() {
            let _ = socket.close(
                Some(1013),
                Some("Terminal host unavailable; reopen after reconnecting"),
            );
        }
    }
    async fn save(&self, presence: &Presence) -> Result<()> {
        self.state.storage().put("presence", presence).await?;
        if presence.status != "offline" {
            let mut due = presence.next_ping;
            if presence.status == "online"
                && let Some(last) = presence.last_response
            {
                due = due.min(last + TIMEOUT_MS);
            }
            if let Some(deadline) = presence.deadline {
                due = due.min(deadline);
            }
            // worker 0.8.7 integer alarms are offsets, not absolute timestamps.
            self.state
                .storage()
                .set_alarm(due.saturating_sub(Date::now().as_millis()).max(1) as i64)
                .await?;
        }
        Ok(())
    }
    async fn current(&self) -> Result<Presence> {
        let stored = self.state.storage().get::<Presence>("presence").await?;
        let now = Date::now().as_millis();
        let mut presence = stored.unwrap_or_else(Presence::absent);
        // Migrate pre-heartbeat hibernated sockets without assuming support.
        if presence.generation == 0 && !self.state.get_websockets_with_tag(HOST_TAG).is_empty() {
            presence.generation = 1;
            presence.status = "unknown".into();
            presence.next_ping = now;
            for socket in self.state.get_websockets_with_tag(HOST_TAG) {
                socket.serialize_attachment(presence.generation)?;
            }
        }
        if presence.reevaluate(now) {
            self.close_all();
        }
        // A restored object can observe a missing socket without receiving its
        // close callback. Keep the same grace period as an explicit disconnect.
        if presence.status != "offline" && self.hosts(&presence).is_empty() {
            presence.disconnected(now);
        }
        if presence.status != "offline" && now >= presence.next_ping {
            presence.sequence += 1;
            let challenge = format!("{}:{}", presence.generation, presence.sequence);
            presence.pending = Some(challenge.clone());
            presence.next_ping = now + HEARTBEAT_MS;
            for host in self.hosts(&presence) {
                if host.send_with_str(format!("{PING}{challenge}")).is_err() {
                    presence.disconnected(now);
                }
            }
        }
        self.save(&presence).await?;
        Ok(presence)
    }
    async fn lost(&self, socket: WebSocket) -> Result<()> {
        let mut presence = self.current().await?;
        if self
            .state
            .get_tags(&socket)
            .iter()
            .any(|tag| tag == HOST_TAG)
            && socket.deserialize_attachment::<u64>()? == Some(presence.generation)
        {
            presence.disconnected(Date::now().as_millis());
            self.save(&presence).await?;
        }
        Ok(())
    }
}
impl DurableObject for RelayDevice {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }
    async fn fetch(&self, req: Request) -> Result<Response> {
        if req.method() == Method::Get && req.path() == "/internal/terminal-status" {
            let presence = self.current().await?;
            return Response::from_json(&serde_json::json!({ "terminal_status": presence.status }));
        }
        let path = req.path();
        let Some((_device_id, role)) = parse_route(&path) else {
            return Response::error("Invalid relay route", 404);
        };
        if !req
            .headers()
            .get("Upgrade")?
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
        {
            return Response::error("Expected WebSocket", 426);
        }
        let mut presence = self.current().await?;
        if role == CLIENT_TAG && (presence.status != "online" || self.hosts(&presence).is_empty()) {
            return Response::error(format!("Terminal unavailable: {}", presence.status), 409);
        }
        for socket in self.state.get_websockets_with_tag(role) {
            let _ = socket.close(Some(1000), Some("Replaced by a newer connection"));
        }
        let pair = WebSocketPair::new()?;
        self.state.accept_websocket_with_tags(&pair.server, &[role]);
        if role == HOST_TAG {
            presence.generation += 1;
            if presence.status != "grace" {
                presence.status = "unknown".into();
                presence.deadline = None;
            }
            presence.last_response = None;
            presence.sequence = 1;
            let challenge = format!("{}:{}", presence.generation, presence.sequence);
            presence.pending = Some(challenge.clone());
            presence.next_ping = Date::now().as_millis() + HEARTBEAT_MS;
            pair.server.serialize_attachment(presence.generation)?;
            self.save(&presence).await?;
            pair.server.send_with_str(format!("{PING}{challenge}"))?;
        }
        Response::from_websocket(pair.client)
    }
    async fn websocket_message(
        &self,
        websocket: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let mut presence = self.current().await?;
        let tags = self.state.get_tags(&websocket);
        let host = tags.iter().any(|tag| tag == HOST_TAG);
        if host && websocket.deserialize_attachment::<u64>()? != Some(presence.generation) {
            return Ok(());
        }
        if let WebSocketIncomingMessage::String(text) = &message
            && text.starts_with(CONTROL)
        {
            if host
                && presence.status != "offline"
                && text.strip_prefix(ACK) == presence.pending.as_deref()
            {
                presence.status = "online".into();
                presence.last_response = Some(Date::now().as_millis());
                presence.deadline = None;
                presence.pending = None;
                self.save(&presence).await?;
            }
            return Ok(());
        }
        if presence.status != "online" {
            return Ok(());
        }
        let targets = if host {
            self.state.get_websockets_with_tag(CLIENT_TAG)
        } else if tags.iter().any(|tag| tag == CLIENT_TAG) {
            self.hosts(&presence)
        } else {
            return Ok(());
        };
        for socket in targets {
            match &message {
                WebSocketIncomingMessage::String(text) => {
                    let _ = socket.send_with_str(text);
                }
                WebSocketIncomingMessage::Binary(bytes) => {
                    let _ = socket.send_with_bytes(bytes);
                }
            }
        }
        Ok(())
    }
    async fn websocket_close(
        &self,
        websocket: WebSocket,
        _code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> Result<()> {
        self.lost(websocket).await
    }
    async fn websocket_error(&self, websocket: WebSocket, _error: Error) -> Result<()> {
        self.lost(websocket).await
    }
    async fn alarm(&self) -> Result<Response> {
        self.current().await?;
        Response::ok("OK")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEVICE: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn silence_has_thirty_seconds_then_five_seconds_grace() {
        let mut presence = Presence::absent();
        presence.status = "online".into();
        presence.last_response = Some(1000);
        assert!(!presence.reevaluate(30_999));
        assert_eq!(presence.status, "online");
        assert!(!presence.reevaluate(31_000));
        assert_eq!(presence.status, "grace");
        assert!(!presence.reevaluate(35_999));
        assert!(presence.reevaluate(36_000));
        assert_eq!(presence.status, "offline");
    }

    #[test]
    fn unsupported_host_stays_unknown_and_close_gets_grace() {
        let mut presence = Presence::absent();
        presence.status = "unknown".into();
        assert!(!presence.reevaluate(100_000));
        assert_eq!(presence.status, "unknown");
        presence.disconnected(100_000);
        assert!(!presence.reevaluate(104_999));
        assert!(presence.reevaluate(105_000));
    }

    #[test]
    fn repeated_missing_socket_observations_do_not_extend_grace() {
        let mut presence = Presence::absent();
        presence.status = "online".into();
        presence.disconnected(1000);
        presence.disconnected(4999);
        assert_eq!(presence.deadline, Some(6000));
        assert!(!presence.reevaluate(5999));
        assert!(presence.reevaluate(6000));
        presence.disconnected(7000);
        assert_eq!(presence.status, "offline");
    }

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
