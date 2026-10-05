use worker::*;

const HOST_TAG: &str = "host";
const CLIENT_TAG: &str = "client";

#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    if req.method() != Method::Get {
        return Response::error("Method Not Allowed", 405);
    }

    let upgrade = req.headers().get("Upgrade")?;

    if !upgrade
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
    {
        return Response::error("Expected WebSocket", 426);
    }

    let path = req.path();

    let Some((device_id, role)) = parse_route(&path) else {
        return Response::error(
            "Expected /device/:device_id/host or /device/:device_id/client",
            404,
        );
    };

    let namespace = env.durable_object("RELAY")?;

    let stub = namespace.id_from_name(device_id)?.get_stub()?;

    let _ = role;

    stub.fetch_with_request(req).await
}

fn parse_route(path: &str) -> Option<(&str, &str)> {
    let mut segments = path.trim_matches('/').split('/');

    if segments.next()? != "device" {
        return None;
    }

    let device_id = segments.next()?;
    let role = segments.next()?;

    if segments.next().is_some() {
        return None;
    }

    if device_id.is_empty() {
        return None;
    }

    if role != HOST_TAG && role != CLIENT_TAG {
        return None;
    }

    Some((device_id, role))
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
