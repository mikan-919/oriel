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

const CONTROL: &str = "oriel-heartbeat:";
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Presence {
    generation: u64,
    #[serde(default)]
    next_heartbeat: Option<u64>,
    last_reply: Option<u64>,
    deadline: Option<u64>,
    challenge: String,
    offline: bool,
    #[serde(default)]
    disconnected: bool,
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
}
impl RelayDevice {
    async fn presence(&self) -> Result<Presence> {
        Ok(self
            .state
            .storage()
            .get("presence")
            .await?
            .unwrap_or_default())
    }
    fn current(&self, socket: &WebSocket, p: &Presence) -> bool {
        socket.deserialize_attachment::<u64>().ok().flatten() == Some(p.generation)
            && self
                .state
                .get_tags(socket)
                .iter()
                .any(|tag| tag == HOST_TAG)
    }
    async fn save(&self, p: &Presence) -> Result<()> {
        self.state.storage().put("presence", p).await?;
        let now = Date::now().as_millis();
        let next = p.deadline.or(p.last_reply.map(|r| r + 30_000));
        let heartbeat = p.next_heartbeat.unwrap_or(now + 10_000);
        let due = next.map_or(heartbeat, |deadline| deadline.min(heartbeat));
        let delay = due.saturating_sub(now).max(1);
        if !p.offline {
            self.state.storage().set_alarm(delay as i64).await?;
        }
        Ok(())
    }
    async fn evaluate(&self) -> Result<Presence> {
        let mut p = self.presence().await?;
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
        self.save(&p).await?;
        Ok(p)
    }
    async fn disconnected(&self, socket: WebSocket) -> Result<()> {
        let mut p = self.presence().await?;
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
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }
    async fn fetch(&self, req: Request) -> Result<Response> {
        if req.path() == "/internal/terminal-status" {
            let p = self.evaluate().await?;
            return Response::ok(p.status(Date::now().as_millis()));
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
        for socket in self.state.get_websockets_with_tag(role) {
            let _ = socket.close(Some(1000), Some("Replaced by a newer connection"));
        }
        let pair = WebSocketPair::new()?;
        self.state.accept_websocket_with_tags(&pair.server, &[role]);
        if role == HOST_TAG {
            p.generation += 1;
            p.next_heartbeat = Some(Date::now().as_millis() + 10_000);
            p.last_reply = None;
            if p.offline {
                p.deadline = None;
            }
            p.offline = false;
            p.disconnected = false;
            p.challenge = format!("{}:{}", p.generation, Date::now().as_millis());
            pair.server.serialize_attachment(p.generation)?;
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
        let mut p = self.presence().await?;
        let host = self.current(&socket, &p);
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
                p.challenge.clear();
                p.last_reply = Some(Date::now().as_millis());
                p.deadline = None;
                self.save(&p).await?;
            }
            return Ok(());
        }
        if p.status(Date::now().as_millis()) != "online" {
            return Ok(());
        }
        let tags = self.state.get_tags(&socket);
        let target = if host {
            CLIENT_TAG
        } else if tags.iter().any(|t| t == CLIENT_TAG) {
            HOST_TAG
        } else {
            return Ok(());
        };
        for socket in self.state.get_websockets_with_tag(target) {
            if target == HOST_TAG && !self.current(&socket, &p) {
                continue;
            }
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
            && p.next_heartbeat
                .is_none_or(|due| Date::now().as_millis() >= due)
        {
            p.next_heartbeat = Some(Date::now().as_millis() + 10_000);
            p.challenge = format!("{}:{}", p.generation, Date::now().as_millis());
            self.save(&p).await?;
            for s in self.state.get_websockets_with_tag(HOST_TAG) {
                if self.current(&s, &p) {
                    let _ = s.send_with_str(format!("{CONTROL}{}", p.challenge));
                }
            }
        }
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
