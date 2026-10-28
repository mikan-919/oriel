use topcoat::{
    context::Cx,
    view::{View, view},
};

pub(crate) fn page(__cx: &Cx) -> impl View {
    view! {
        <section id="workflow-onboarding" data-region="workflow">
            <h2>"作業を始める"</h2>
            <p>"ログインし、端末とGitHub・Linearを連携すると作業を確認できます。"</p>
            <button type="button" data-go="devices">"端末を確認"</button>
            <button type="button" data-go="settings">"連携を設定"</button>
        </section>
        <section id="repository-work" hidden="" data-region="workflow" aria-label="開発ワークフロー">
            <div class="page-head">
                <div><p class="subtitle">"作業の進み具合と、次に必要な操作を確認できます。"</p><p id="repository-details"></p></div>
                <button class="btn primary" id="workflow-create" type="button">"＋ 作業を作成"</button>
            </div>
            <div class="workflow-command">
                <div class="workflow-target"><label for="workflow-device">"実行端末"</label><select id="workflow-device"></select><p id="workflow-connection" role="status">"接続状態は未確認です。"</p></div>
                <div class="workflow-tools"><div class="board-heading"><h2 class="section-title" id="workflow-list-heading">"作業ボード "<span class="count" id="workflow-total"></span></h2><button class="btn small" id="refresh-repository" type="button" aria-label="ワークフローを更新">"↻"</button></div><label class="search"><span aria-hidden="true">"⌕"</span><input id="workflow-search" type="search" placeholder="タイトル・番号で検索" aria-label="作業を検索" /></label></div>
            </div>
            <div class="filters workflow-filters" role="group" aria-label="工程の絞り込み"><button type="button" data-work-filter="all" aria-pressed="true">"すべて"</button><button type="button" data-work-filter="plan" aria-pressed="false">"計画"</button><button type="button" data-work-filter="active" aria-pressed="false">"実行・検証"</button><button type="button" data-work-filter="review" aria-pressed="false">"レビュー"</button><button type="button" data-work-filter="done" aria-pressed="false">"完了"</button></div>
            <p id="repository-status" role="status" aria-live="polite"></p>
            <div id="repository-issues" class="workflow-board" aria-labelledby="workflow-list-heading">
                <section class="workflow-lane lane-plan" data-lane="plan" aria-labelledby="workflow-plan-heading">
                    <div class="lane-heading"><h3 id="workflow-plan-heading">"計画"</h3><strong id="workflow-waiting-count">"—"</strong></div><p>"WHATとHOWを整理します"</p><ul id="workflow-lane-plan" class="tasks" data-work-lane-list="" aria-label="計画中の作業"></ul><p class="lane-empty" id="workflow-lane-plan-empty">"該当する作業はありません。"</p>
                </section>
                <section class="workflow-lane lane-active" data-lane="active" aria-labelledby="workflow-active-heading">
                    <div class="lane-heading"><h3 id="workflow-active-heading">"実行・検証"</h3><strong id="workflow-running-count">"—"</strong></div><p>"承認後の実装と検証です"</p><ul id="workflow-lane-active" class="tasks" data-work-lane-list="" aria-label="実行・検証中の作業"></ul><p class="lane-empty" id="workflow-lane-active-empty">"該当する作業はありません。"</p>
                </section>
                <section class="workflow-lane lane-review" data-lane="review" aria-labelledby="workflow-review-heading">
                    <div class="lane-heading"><h3 id="workflow-review-heading">"レビュー"</h3><strong id="workflow-review-count">"—"</strong></div><p>"PRとCIを確認します"</p><ul id="workflow-lane-review" class="tasks" data-work-lane-list="" aria-label="レビュー中の作業"></ul><p class="lane-empty" id="workflow-lane-review-empty">"該当する作業はありません。"</p>
                </section>
                <section class="workflow-lane lane-done" data-lane="done" aria-labelledby="workflow-done-heading">
                    <div class="lane-heading"><h3 id="workflow-done-heading">"完了"</h3><strong id="workflow-done-count">"—"</strong></div><p>"終了した作業です"</p><ul id="workflow-lane-done" class="tasks" data-work-lane-list="" aria-label="完了した作業"></ul><p class="lane-empty" id="workflow-lane-done-empty">"該当する作業はありません。"</p>
                </section>
            </div>
            <p class="empty board-empty" id="workflow-empty">"ワークフローを取得しています。"</p>
            <section class="detail" id="workflow-detail" hidden="" aria-label="選択した作業の詳細">
                    <div class="detail-head"><div class="detail-meta"><span id="workflow-number"></span><span id="workflow-how-number"></span><span id="workflow-badge" class="badge"></span></div><h2 id="workflow-title" tabindex="-1"></h2><div class="detail-actions"><a class="btn primary small" id="workflow-primary" target="_blank" rel="noopener noreferrer"></a><button class="btn small" id="workflow-codex" type="button">"Codexを開く ↗"</button><button class="btn small" id="workflow-control" type="button">"一時停止・再開"</button></div></div>
                    <div class="detail-tabs" role="group" aria-label="作業の表示"><button type="button" data-work-panel="status" aria-pressed="true">"状況"</button><button type="button" data-work-panel="plan" aria-pressed="false">"WHAT / HOW"</button><button type="button" data-work-panel="history" aria-pressed="false">"実行履歴"</button></div>
                    <div class="detail-body" id="work-status-panel">
                        <h3 class="section-label">"現在の進み具合"</h3><ol class="steps" id="workflow-steps"></ol>
                        <div class="next-action" id="workflow-next"><strong id="workflow-next-title"></strong><p id="workflow-next-copy"></p></div>
                        <h3 class="section-label">"検証結果"</h3>
                        <div class="checks"><section class="check-group"><div class="check-title"><h3>"端末側の検証"</h3><span class="badge neutral" id="workflow-local-badge">"未取得"</span></div><div id="workflow-local-checks"></div><p class="check-note" id="workflow-local-note">"端末側の検証とGitHub CIは、確認する工程が異なります。"</p></section><section class="check-group"><div class="check-title"><h3>"GitHub CI"</h3><span class="badge neutral" id="workflow-ci-badge">"未取得"</span></div><div id="workflow-ci-checks"></div><details id="workflow-failure" hidden=""><summary>"失敗した工程の詳細"</summary><pre id="workflow-failure-body"></pre></details></section></div>
                        <div class="task-links" id="workflow-links"></div><p class="check-note" id="workflow-evidence-note"></p>
                    </div>
                    <div class="detail-body prose" id="work-plan-panel" hidden=""><section><h3>"WHAT — 達成したいこと"</h3><p class="how-description" id="workflow-what-body"></p></section><section><h3 id="workflow-how-heading">"HOW — 作業の進め方"</h3><p class="how-description" id="workflow-how-body"></p></section><section><h3>"相談とフィードバック"</h3><div id="workflow-discussion"></div></section></div>
                    <div class="detail-body" id="work-history-panel" hidden=""><h3 class="section-label">"実行履歴"</h3><p class="check-note" id="workflow-history-status" role="status"></p><button id="workflow-history-refresh" type="button">"履歴を更新"</button><ol class="timeline" id="workflow-history"></ol></div>
            </section>
            <details class="workflow-help"><summary>"ワークフローの進め方"</summary><p>"GitHub IssueがWHAT、LinearがHOW、PRが変更のレビューです。HOWを確認し、LinearでTodoに移すと実装を承認します。PRのレビューとマージはGitHubで行います。端末のチェックアウトで orield workflow を実行してください。"</p></details>
        </section>
        <dialog id="workflow-create-dialog" aria-labelledby="what-heading"><form id="what-form"><fieldset id="what-fields" disabled=""><legend id="what-heading">"作業を作成"</legend><p class="dialog-copy">"達成したいことをWHATとしてGitHub Issueに登録します。実装の承認はHOWを確認してから行います。"</p><label class="form-label" for="what-title">"タイトル"</label><input class="field" id="what-title" type="text" required="" maxlength="256" aria-describedby="what-limits" /><label class="form-label" for="what-body">"達成したいこと"</label><textarea class="field" id="what-body" rows="6" maxlength="60000" aria-describedby="what-limits"></textarea><p id="what-limits">"タイトルは256文字、本文は60000文字までです。絵文字などは2文字分になる場合があります。"</p><p id="what-status" role="status"></p><div class="dialog-actions"><button type="button" class="btn" id="what-cancel">"キャンセル"</button><button type="submit" class="btn primary">"GitHub Issueを作成"</button></div></fieldset></form></dialog>
    }
}
