use crate::PAIR_CAPTURE_JS;
use topcoat::{
    Result,
    context::Cx,
    view::{StaticStr, Unescaped, View, ViewExt, view},
};

fn overview_card(
    __cx: &Cx,
    title: &'static str,
    id: &'static str,
    initial: &'static str,
) -> impl View {
    view! {
        <article>
            <h3>(title)</h3>
            <p id=(id)>(initial)</p>
        </article>
    }
}

pub(crate) async fn home(__cx: &Cx) -> Result<impl View> {
    let workflow = crate::workflow::page(__cx).single().await?;
    let target_card = overview_card(
        __cx,
        "選択対象",
        "overview-target",
        "端末を選択してください。",
    )
    .single()
    .await?;
    let progress_card = overview_card(__cx, "ワークフロー", "overview-progress", "未取得")
        .single()
        .await?;
    Ok(view! {
        <!DOCTYPE html>

        <html lang="ja">
            <head>
                <meta charset="utf-8">
                <script>
                    (Unescaped::new_unchecked(StaticStr(PAIR_CAPTURE_JS)))
                </script>

                <meta
                    name="viewport"
                    content="width=device-width, initial-scale=1"
                >

                <title>"Oriel"</title>

                <link
                    rel="stylesheet"
                    href="https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css"
                >

                <link rel="stylesheet" href="/dashboard.css">
            </head>

            <body>
                <main id="dashboard" class="shell">
                    <nav class="sidebar" aria-label="メインナビゲーション">
                        <strong class="brand"><span class="brand-mark" aria-hidden="true">"o"</span>"Oriel"</strong>
                        <button type="button" data-page="overview" aria-current="page">"概要"</button>
                        <button type="button" data-page="workflow">"ワークフロー"</button>
                        <button type="button" data-page="codex">"Codex"</button>
                        <button type="button" data-page="devices">"端末"</button>
                        <button type="button" data-page="settings">"設定"</button>
                    </nav>
                    <div class="dashboard-content content">
                    <h1 id="page-title" tabindex="-1">"概要"</h1>
                    <p id="account">"ログイン状態を確認中…"</p>
                    <div id="anonymous-actions">
                        <button id="register" type="button">"Passkeyでアカウントを作成"</button>
                        <button id="login" type="button">"Passkeyでログイン"</button>
                    </div>
                    <div id="session-actions" hidden="" data-region="settings">
                        <button id="backup" type="button">"予備のPasskeyを追加"</button>
                        <button id="logout" type="button">"ログアウト"</button>
                        <button id="refresh" type="button">"アカウントと端末を更新"</button>
                    </div>
                    <p id="status" role="status"></p>
                    <section data-region="overview" aria-labelledby="overview-heading">
                        <h2 id="overview-heading">"現在の状況"</h2>
                        <div class="overview-grid">
                            (target_card)
                            (progress_card)
                            <article><h3>"次の操作"</h3><p id="overview-next">"Passkeyでログインしてください。"</p><button id="overview-action" type="button">"ログインへ"</button></article>
                        </div>
                    </section>
                    <section id="pairing" hidden="">
                        <h2>"端末をペアリング"</h2>
                        <p id="pair-details"></p>
                        <p id="pair-status" role="status"></p>
                        <button id="approve-pair" type="button" hidden="">"この端末を承認"</button>
                    </section>
                    <section id="integration" hidden="" data-region="settings">
                        <h2>"外部サービス連携"</h2>
                        <p>"連携設定は同じアカウントの端末で共有されます。連携先を選択して保存してください。"</p>
                        <p id="integration-status" role="status"></p>
                        <div id="integration-actions" hidden="">
                            <section aria-labelledby="github-heading">
                                <h3 id="github-heading">"GitHub"</h3>
                                <p id="github-details"></p>
                                <p id="github-authorization" role="status" hidden=""></p>
                                <button id="github-connect" type="button">"GitHubと連携"</button>
                                <button id="github-disconnect" type="button">"GitHub連携を解除"</button>
                                <p>"解除すると新しいアクセスを停止します。発行済みのGitHubトークンは最長1時間有効です。"</p>
                                <div id="github-selection" hidden="">
                                    <label for="github-target">"GitHubリポジトリ"</label>
                                    <select id="github-target"></select>
                                    <button id="github-save" type="button">"リポジトリを保存"</button>
                                </div>
                                <ul id="github-issues" aria-label="最近のGitHub Issue"></ul>
                            </section>
                            <section aria-labelledby="linear-heading">
                                <h3 id="linear-heading">"Linear"</h3>
                                <p id="linear-details"></p>
                                <p id="linear-authorization" role="status" hidden=""></p>
                                <button id="linear-connect" type="button">"Linearと連携"</button>
                                <button id="linear-disconnect" type="button">"Linear連携を解除"</button>
                                <div id="linear-selection" hidden="">
                                    <label for="linear-target">"Linearチーム"</label>
                                    <select id="linear-target"></select>
                                    <button id="linear-save" type="button">"チームを保存"</button>
                                </div>
                                <ul id="linear-issues" aria-label="最近のLinear Issue"></ul>
                            </section>
                            <button id="refresh-issues" type="button">"最近のIssueを更新"</button>
                            <p id="issues-status" role="status"></p>
                        </div>
                    </section>
                    <section data-region="devices">
                        <h2>"端末一覧"</h2>
                        <p>"切断中の入力は再送されません。ホスト再起動後は端末プロセスを復元できません。接続可能になったら端末を開き直してください。"</p>
                        <p id="device-summary">"ログインすると端末を確認できます。"</p>
                        <p id="workflow-progress-status" role="status" aria-live="polite" aria-atomic="true">"ログインすると実行状況を確認できます。"</p>
                        <ul id="devices"></ul>
                    </section>
                    (workflow)
                    <section data-region="codex" aria-labelledby="codex-heading">
                        <h2 id="codex-heading">"Codexを操作"</h2>
                        <p>"端末で orield codex または orield workflow を実行してください。相談とレビューは読み取り専用です。ワークフローの実装にはHOWの承認が必要です。"</p>
                        <label for="codex-device">"接続する端末"</label>
                        <select id="codex-device"></select>
                        <button id="codex-connect" type="button">"接続"</button>
                        <p id="codex-status" role="status" aria-live="polite">"ログインするとCodexを操作できます。"</p>
                        <label for="codex-engine">"操作するCodex"</label>
                        <select id="codex-engine"></select>
                        <div class="codex-controls">
                            <button id="codex-pause" type="button">"自動ワークフローを一時停止"</button>
                            <button id="codex-resume" type="button">"自動ワークフローを再開"</button>
                        </div>
                        <div id="codex-requests" aria-label="承認待ち・質問"></div>
                        <fieldset>
                            <legend>"モデル"</legend>
                            <label for="codex-model">"使用するモデル"</label>
                            <select id="codex-model"><option value="">"端末の既定モデル"</option></select>
                            <label for="codex-effort">"推論量"</label>
                            <select id="codex-effort"><option value="">"既定の推論量"</option></select>
                            <button id="codex-workflow-model" type="button">"次回の実装にこのモデルを使う"</button>
                        </fieldset>
                        <div class="codex-grid">
                            <section aria-labelledby="codex-conversations-heading">
                                <h3 id="codex-conversations-heading">"会話"</h3>
                                <button id="codex-new" type="button">"新しい会話"</button>
                                <button id="codex-refresh" type="button">"会話を更新"</button>
                                <label><input id="codex-archived" type="checkbox" />"保管した会話を表示"</label>
                                <ul id="codex-threads"></ul>
                            </section>
                            <section aria-labelledby="codex-current-heading">
                                <h3 id="codex-current-heading">"選択した会話"</h3>
                                <label for="codex-name">"会話の名前"</label>
                                <input id="codex-name" type="text" maxlength="300" />
                                <button id="codex-rename" type="button">"名前を保存"</button>
                                <button id="codex-fork" type="button">"この会話から分岐"</button>
                                <button id="codex-archive" type="button">"保管・復元"</button>
                                <div id="codex-output" role="log" aria-label="Codexの回答と実行結果"></div>
                                <details><summary>"変更差分"</summary><pre id="codex-diff"></pre></details>
                                <form id="codex-form">
                                    <label for="codex-input">"Codexへの指示"</label>
                                    <textarea id="codex-input" rows="4" required="" maxlength="32000"></textarea>
                                    <button id="codex-send" type="submit">"送信"</button>
                                    <button id="codex-steer" type="button">"実行中の作業に追記"</button>
                                    <button id="codex-interrupt" type="button">"中断"</button>
                                </form>
                                <fieldset>
                                    <legend>"コードレビュー"</legend>
                                    <label for="codex-review-kind">"レビューする変更"</label>
                                    <select id="codex-review-kind">
                                        <option value="uncommittedChanges">"未コミットの変更"</option>
                                        <option value="baseBranch">"比較するブランチ"</option>
                                        <option value="commit">"コミット"</option>
                                        <option value="custom">"レビューの指示"</option>
                                    </select>
                                    <label for="codex-review-target">"ブランチ・コミット番号・指示"</label>
                                    <input id="codex-review-target" type="text" />
                                    <button id="codex-review" type="button">"レビューを開始"</button>
                                </fieldset>
                            </section>
                        </div>
                        <details>
                            <summary>"スキルと外部サービス"</summary>
                            <p>"スキルを選ぶと指示欄に追加します。外部サービスはHTTPSのMCP接続先を設定できます。"</p>
                            <button id="codex-skills" type="button">"利用できる機能を更新"</button>
                            <h3>"スキル"</h3><ul id="codex-skill-list"></ul>
                            <h3>"外部サービス"</h3><ul id="codex-mcp-list"></ul>
                            <form id="codex-mcp-form">
                                <label for="codex-mcp-name">"接続名"</label>
                                <input id="codex-mcp-name" type="text" required="" pattern="[A-Za-z0-9_-]{1,64}" />
                                <label for="codex-mcp-url">"MCP接続先URL"</label>
                                <input id="codex-mcp-url" type="url" required="" placeholder="https://example.com/mcp" />
                                <button type="submit">"接続先を保存"</button>
                            </form>
                        </details>
                    </section>
                    </div>
                </main>
                <section id="terminal-view" hidden="">
                    <div id="terminal-toolbar">
                        <span id="terminal-title"></span>
                        <button id="close-terminal" type="button">"端末を閉じる"</button>
                    </div>
                    <div id="terminal"></div>
                </section>

                <script
                    type="module"
                    src="/terminal.js"
                ></script>
            </body>
        </html>
    })
}
