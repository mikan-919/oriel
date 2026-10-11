use std::{fs, path::Path};

use topcoat::{Result, context::Cx, view::ViewExt};

mod ui;

const STYLE: &str = include_str!("assets/dashboard.css");
// Capture before external modules; pairing secrets never enter storage.
const PAIR_CAPTURE_JS: &str = include_str!("assets/pairing.js");
const TERMINAL_JS: &str = include_str!("assets/dashboard.js");
// Build once; Cloudflare Workers Static Assets serves the generated files.
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let output = Path::new(env!("CARGO_MANIFEST_DIR")).join("build");
    let cx = Cx::default();
    let html = ui::home(&cx).await?.single().await?.render(&cx);
    fs::create_dir_all(&output)?;
    fs::write(output.join("index.html"), html)?;
    fs::write(output.join("terminal.js"), TERMINAL_JS)?;
    fs::write(output.join("dashboard.css"), STYLE)?;
    println!("oriel-web assets: {}", output.display());
    Ok(())
}
