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

#[durable_object]
pub struct RelayDevice {
    state: State,
}

impl DurableObject for RelayDevice {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        let upgrade = req.headers().get("Upgrade")?;

        if !upgrade
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
        {
            return Response::error("Expected WebSocket", 426);
        }

        let path = req.path();

        let Some((_device_id, role)) = parse_route(&path) else {
            return Response::error("Invalid relay route", 404);
        };

        // 現段階では1 deviceにつきhost/client各1接続。
        // 新しい接続が来たら古い同role接続を閉じる。
        for socket in self.state.get_websockets_with_tag(role) {
            let _ = socket.close(Some(1000), Some("Replaced by a newer connection"));
        }

        let pair = WebSocketPair::new()?;

        // accept()ではなくHibernation APIを使う。
        // 接続中でもDurable Object本体をメモリから退避できる。
        self.state.accept_websocket_with_tags(&pair.server, &[role]);

        Response::from_websocket(pair.client)
    }

    async fn websocket_message(
        &self,
        websocket: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let tags = self.state.get_tags(&websocket);

        let target = if tags.iter().any(|tag| tag == HOST_TAG) {
            CLIENT_TAG
        } else if tags.iter().any(|tag| tag == CLIENT_TAG) {
            HOST_TAG
        } else {
            return Ok(());
        };

        let targets = self.state.get_websockets_with_tag(target);

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
        _websocket: WebSocket,
        _code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> Result<()> {
        Ok(())
    }

    async fn websocket_error(&self, _websocket: WebSocket, _error: Error) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
