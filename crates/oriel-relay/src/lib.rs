use std::collections::BTreeMap;

use serde::Deserialize;
use subtle::ConstantTimeEq;
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

    let secret = match env.secret("ORIEL_DEVICE_CREDENTIALS") {
        Ok(secret) => secret.to_string(),
        Err(_) => return Response::error("Relay credentials unavailable", 503),
    };
    let authorization = req.headers().get("Authorization")?;
    let protocols = req.headers().get("Sec-WebSocket-Protocol")?;
    if let Err(status) = authenticate(
        &secret,
        device_id,
        role,
        authorization.as_deref(),
        protocols.as_deref(),
    ) {
        return Response::error("Relay authentication failed", status);
    }
    if req.url()?.query().is_some() {
        return Response::error("Query parameters are not allowed", 400);
    }

    // Only this authenticated ingress can obtain a DO stub. Strip credentials:
    // the object owns sockets and frames, never authentication material.
    let mut forwarded = req.clone_mut()?;
    forwarded.headers_mut()?.delete("Authorization")?;
    forwarded.headers_mut()?.delete("Sec-WebSocket-Protocol")?;
    let namespace = env.durable_object("RELAY")?;
    let stub = namespace.id_from_name(device_id)?.get_stub()?;
    let mut response = stub.fetch_with_request(forwarded).await?;
    if role == CLIENT_TAG && response.status_code() == 101 {
        // A fetched response has immutable headers; copy only the headers,
        // retaining ownership of the WebSocket instead of cloning it.
        let headers = response.headers().clone();
        headers.set("Sec-WebSocket-Protocol", "oriel-client")?;
        response = response.with_headers(headers);
    }
    Ok(response)
}

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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Credentials {
    host_token: String,
    client_token: String,
}

fn authenticate(
    secret: &str,
    device_id: &str,
    role: &str,
    authorization: Option<&str>,
    protocols: Option<&str>,
) -> std::result::Result<(), u16> {
    let devices: BTreeMap<String, Credentials> =
        serde_json::from_str(secret).map_err(|_| 503u16)?;
    if devices.iter().any(|(id, credentials)| {
        !is_lower_hex(id, 32)
            || !is_lower_hex(&credentials.host_token, 64)
            || !is_lower_hex(&credentials.client_token, 64)
            || bool::from(
                credentials
                    .host_token
                    .as_bytes()
                    .ct_eq(credentials.client_token.as_bytes()),
            )
    }) {
        return Err(503);
    }
    let credentials = devices.get(device_id).ok_or(403u16)?;
    let (provided, expected) = match role {
        HOST_TAG => {
            if protocols.is_some() {
                return Err(403);
            }
            let token = authorization
                .and_then(|header| header.strip_prefix("Bearer "))
                .ok_or(401u16)?;
            (token, credentials.host_token.as_str())
        }
        CLIENT_TAG => {
            if authorization.is_some() {
                return Err(403);
            }
            let mut values = protocols.ok_or(401u16)?.split(',').map(str::trim);
            let first = values.next().ok_or(401u16)?;
            let second = values.next().ok_or(401u16)?;
            if values.next().is_some() {
                return Err(403);
            }
            let token = if first == "oriel-client" {
                second.strip_prefix("oriel-auth.")
            } else if second == "oriel-client" {
                first.strip_prefix("oriel-auth.")
            } else {
                None
            }
            .ok_or(403u16)?;
            (token, credentials.client_token.as_str())
        }
        _ => return Err(403),
    };
    if !is_lower_hex(provided, 64)
        || !bool::from(provided.as_bytes().ct_eq(expected.as_bytes()))
    {
        return Err(403);
    }
    Ok(())
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

    fn secret(host: &str, client: &str) -> String {
        serde_json::json!({
            DEVICE: { "host_token": host, "client_token": client }
        })
        .to_string()
    }

    #[test]
    fn credentials_are_required_and_role_specific() {
        let host = "a".repeat(64);
        let client = "b".repeat(64);
        let config = secret(&host, &client);
        let host_header = format!("Bearer {host}");
        let client_header = format!("Bearer {client}");
        let host_protocol = format!("oriel-client, oriel-auth.{host}");
        let client_protocol = format!("oriel-client, oriel-auth.{client}");
        assert_eq!(authenticate(&config, DEVICE, HOST_TAG, None, None), Err(401));
        assert_eq!(authenticate(&config, DEVICE, CLIENT_TAG, None, None), Err(401));
        assert_eq!(
            authenticate(&config, DEVICE, HOST_TAG, Some(&host_header), None),
            Ok(())
        );
        assert_eq!(
            authenticate(&config, DEVICE, CLIENT_TAG, None, Some(&client_protocol)),
            Ok(())
        );
        assert_eq!(
            authenticate(&config, DEVICE, HOST_TAG, Some(&client_header), None),
            Err(403)
        );
        assert_eq!(
            authenticate(&config, DEVICE, CLIENT_TAG, None, Some(&host_protocol)),
            Err(403)
        );
        assert_eq!(
            authenticate(&config, DEVICE, CLIENT_TAG, Some(&client_header), None),
            Err(403)
        );
        assert_eq!(
            authenticate(&config, DEVICE, HOST_TAG, None, Some(&host_protocol)),
            Err(403)
        );
        let wrong = format!("Bearer {}c", "a".repeat(63));
        assert_eq!(
            authenticate(&config, DEVICE, HOST_TAG, Some(&wrong), None),
            Err(403)
        );
    }

    #[test]
    fn authentication_headers_have_strict_boundaries() {
        let config = secret(&"a".repeat(64), &"b".repeat(64));
        for header in [
            format!("Bearer {}", "a".repeat(63)),
            format!("Bearer {} ", "a".repeat(64)),
            format!("Bearer {}", "A".repeat(64)),
            format!("Basic {}", "a".repeat(64)),
        ] {
            assert!(authenticate(&config, DEVICE, HOST_TAG, Some(&header), None).is_err());
        }
        for protocols in [
            format!("oriel-auth.{}", "b".repeat(64)),
            "oriel-client".to_string(),
            format!("oriel-client, oriel-auth.{}, extra", "b".repeat(64)),
            format!("oriel-client, oriel-auth.{}", "b".repeat(63)),
            format!("oriel-client, oriel-auth.{}", "B".repeat(64)),
            "oriel-client, oriel-client".to_string(),
        ] {
            assert!(authenticate(&config, DEVICE, CLIENT_TAG, None, Some(&protocols)).is_err());
        }
        let reversed = format!("oriel-auth.{}, oriel-client", "b".repeat(64));
        assert_eq!(
            authenticate(&config, DEVICE, CLIENT_TAG, None, Some(&reversed)),
            Ok(())
        );
        assert_eq!(
            authenticate(&config, &"0".repeat(32), HOST_TAG, None, None),
            Err(403)
        );
    }

    #[test]
    fn malformed_configuration_fails_closed() {
        let host = "a".repeat(64);
        let client = "b".repeat(64);
        let mut invalid_other_device: serde_json::Value =
            serde_json::from_str(&secret(&host, &client)).unwrap();
        invalid_other_device["not-a-device"] =
            serde_json::json!({ "host_token": host, "client_token": client });
        for config in [
            String::new(),
            "null".to_string(),
            "[]".to_string(),
            format!(r#"{{"{DEVICE}":{{"host_token":"{host}"}}}}"#),
            secret(&host, &host),
            secret(&"A".repeat(64), &client),
            secret(&host, &"b".repeat(63)),
            invalid_other_device.to_string(),
        ] {
            assert_eq!(
                authenticate(&config, DEVICE, HOST_TAG, None, None),
                Err(503)
            );
        }
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
