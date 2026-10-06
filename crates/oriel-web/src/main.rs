use std::{fs, path::Path};

use topcoat::{
    Result,
    context::Cx,
    view::{View, ViewExt, view},
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

#terminal {
    width: 100%;
    height: 100%;
}

#connection {
    box-sizing: border-box;
    width: min(100%, 32rem);
    padding: 1rem;
}

#connection label,
#connection input {
    display: block;
    box-sizing: border-box;
    width: 100%;
    margin-bottom: 0.5rem;
}

#connection input,
#connection button {
    font: inherit;
    padding: 0.5rem;
}

[hidden] {
    display: none !important;
}
"#;

const TERMINAL_JS: &str = r#"
import { Terminal } from "https://esm.sh/@xterm/xterm@6.0.0";
import { FitAddon } from "https://esm.sh/@xterm/addon-fit@0.11.0";

const container = document.getElementById("terminal");

if (!container) {
    throw new Error("\#terminal was not found");
}

const terminal = new Terminal({
    cursorBlink: true,
    convertEol: false,
    scrollback: 10000,
    fontFamily:
        '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace',
    fontSize: 14,
});

const fit = new FitAddon();

terminal.loadAddon(fit);
terminal.open(container);
fit.fit();
let socket;
const form = document.getElementById("connection");
const status = document.getElementById("connection-status");
const connectButton = document.getElementById("connect");

form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
        const relay = new URL(document.getElementById("relay-url").value);
        const deviceId = document.getElementById("device-id").value.trim();
        const tokenInput = document.getElementById("client-token");
        const token = tokenInput.value.trim();
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(relay.hostname);
        if ((relay.protocol !== "wss:" && !(relay.protocol === "ws:" && loopback))
            || relay.username || relay.password || relay.search || relay.hash
            || relay.pathname !== "/") {
            throw new Error("Use a wss:// Relay origin (ws:// is allowed only on loopback).");
        }
        if (!/^[0-9a-f]{32}$/.test(deviceId) || !/^[0-9a-f]{64}$/.test(token)) {
            throw new Error("Enter the Device ID and client token from orield --print-client-config.");
        }
        relay.pathname = `/device/${deviceId}/client`;
        socket = new WebSocket(relay, ["oriel-client", `oriel-auth.${token}`]);
        socket.binaryType = "arraybuffer";
        tokenInput.value = "";
        connectButton.disabled = true;
        status.textContent = "Connecting…";
        attachSocket(socket);
    } catch (error) {
        status.textContent = error.message;
    }
});

const encoder = new TextEncoder();

function sendResize() {
    if (socket?.readyState !== WebSocket.OPEN) {
        return;
    }

    socket.send(`resize:${terminal.cols}:${terminal.rows}`);
}

function attachSocket(connection) {
    connection.addEventListener("open", () => {
        form.hidden = true;
        container.hidden = false;
        status.textContent = "";
        fit.fit();
        sendResize();
        terminal.focus();
    });

    connection.addEventListener("message", async (event) => {
        if (event.data instanceof ArrayBuffer) {
            terminal.write(new Uint8Array(event.data));
            return;
        }

        if (event.data instanceof Blob) {
            terminal.write(new Uint8Array(await event.data.arrayBuffer()));
            return;
        }

        if (typeof event.data === "string") {
            terminal.write(event.data);
        }
    });

    connection.addEventListener("close", () => {
        form.hidden = false;
        container.hidden = true;
        connectButton.disabled = false;
        status.textContent = "Disconnected. Check credentials and enter the client token to reconnect.";
        terminal.write("\r\n\x1b[31m[relay disconnected]\x1b[0m\r\n");
    });

    connection.addEventListener("error", () => {
        status.textContent = "Connection failed. Check the Relay URL, Device ID and client token.";
    });
}

terminal.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(encoder.encode(data));
    }
});

const resizeObserver = new ResizeObserver(() => {
    fit.fit();
    sendResize();
});

resizeObserver.observe(container);
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
                    (STYLE)
                </style>
            </head>

            <body>
                <form id="connection">
                    <h1>"Connect to Oriel"</h1>
                    <label for="relay-url">"Relay URL"</label>
                    <input id="relay-url" type="url" value="wss://oriel-relay.mikan-919.workers.dev" required="">
                    <label for="device-id">"Device ID"</label>
                    <input id="device-id" autocomplete="off" spellcheck="false" pattern="[0-9a-f]{32}" required="">
                    <label for="client-token">"Client token"</label>
                    <input id="client-token" type="password" autocomplete="off" pattern="[0-9a-f]{64}" required="">
                    <button id="connect" type="submit">"Connect"</button>
                    <p id="connection-status" role="status"></p>
                </form>
                <div id="terminal" hidden=""></div>

                <script
                    type="module"
                    src="/terminal.js"
                ></script>
            </body>
        </html>
    })
}
