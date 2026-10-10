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
                <main id="dashboard">
                    <nav aria-label="メインナビゲーション">
                        <strong>"Oriel"</strong>
                        <button type="button" data-page="overview" aria-current="page">"概要"</button>
                        <button type="button" data-page="workflow">"ワークフロー"</button>
                        <button type="button" data-page="devices">"端末"</button>
                        <button type="button" data-page="settings">"設定"</button>
                    </nav>
                    <div class="dashboard-content">
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
                    <section id="repository-work" hidden="" data-region="workflow">
                        <h2>"開発ワークフロー"</h2>
                        <details><summary>"ワークフローの進め方"</summary>
                            <p>"GitHub IssueがWHAT、LinearがHOW、PRがDOです。端末のチェックアウトで orield workflow を実行してください。runnerの接続と端末の接続は別です。"</p>
                            <p>"LinearでHOWを確認し、Todoへの移動で実装を承認します。GitHubでPRをレビューし、マージしてください。この画面には承認・マージ操作はありません。コード実行には .oriel.yaml の明示的な設定と検証コマンドが必要です。"</p>
                        </details>
                        <p id="repository-details"></p>
                        <button id="refresh-repository" type="button">"ワークフローを更新"</button>
                        <p id="repository-status" role="status"></p>
                        <form id="what-form">
                            <fieldset id="what-fields" disabled="">
                                <legend>"GitHub WHATを作成"</legend>
                                <label for="what-title">"WHATのタイトル"</label>
                                <input id="what-title" type="text" required="" />
                                <label for="what-body">"WHATの本文"</label>
                                <textarea id="what-body" rows="6"></textarea>
                                <button type="submit">"GitHub Issueを作成"</button>
                            </fieldset>
                        </form>
                        <ul id="repository-issues" aria-label="Issue・Linear・PRのワークフロー"></ul>
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
