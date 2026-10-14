const labels = {"waiting-how":"計画依頼待ち","needs-how":"計画待ち",triage:"承認待ち",approved:"開始待ち",running:"実装中",review:"レビュー待ち",merged:"同期中",done:"完了",closed:"終了",blocked:"停止中"};
const stageLabels = {discovering:"探索",preparing:"準備",planning:"計画",discussing:"相談",implementing:"実装",reviewing:"レビュー",verifying:"検証",integrating:"統合",pushing:"送信",publishing:"PR更新",reconciling:"同期",paused:"一時停止",idle:"待機"};
export function workflowState(row, progress, live) {
    const active = live && progress?.task?.issue_number === row.issue.number;
    if (row.phase === "blocked" || row.blocked_reason && row.phase === "review") return {group:"blocked",label:"停止中",tone:"red",active};
    if (active && progress.state === "paused") return {group:"blocked",label:"一時停止",tone:"amber",active};
    if (active && progress.state === "running" && !["triage","closed","done","merged"].includes(row.phase)) return {group:"running",label:stageLabels[progress.stage] ? stageLabels[progress.stage]+"中" : "実行中",tone:"green",active};
    if (row.phase === "running") return {group:"blocked",label:live?"再開待ち":"実行状況未確認",tone:"neutral",active:false};
    const group = row.phase === "triage" ? "waiting" : ["waiting-how","needs-how"].includes(row.phase) ? "planning" : row.phase === "approved" ? "ready" : ["done","closed"].includes(row.phase) ? "done" : "review";
    return {group,label:labels[row.phase] || "未確認",tone:group === "waiting" ? "amber" : group === "running" ? "green" : "neutral",active};
}
export function currentCI(row) {
    if (row.pull_request?.head_oid && row.ci?.head_oid === row.pull_request.head_oid && ["success","failure","pending","unknown"].includes(row.ci?.status)) return row.ci;
    if (row.feedback?.kind === "check_failure" && row.pull_request?.head_oid && row.feedback.key?.endsWith(":"+row.pull_request.head_oid)) return {status:"failure",checks:[]};
    return {status:"unknown",checks:[]};
}
export function currentVerification(row, snapshot, progress, live) {
    const value=progress?.verification, head=row.pull_request?.head_oid ?? row.canonical_oid;
    return live && value?.issue_number === row.issue.number && value.target_oid === snapshot?.target_oid && value.head_oid === head &&
        ["running","success","failure"].includes(value.status) && Number.isSafeInteger(value.completed) && Number.isSafeInteger(value.total) && value.total>0 &&
        value.completed>=0 && value.completed<=value.total && value.total===snapshot?.configuration?.verification?.length &&
        (value.status !== "success" || value.completed === value.total) ? value : null;
}

export function mountWorkflow({onDevice, onCodex, onCreate}) {
    const get=id=>document.getElementById("workflow-"+id);
    const node=(tag,text,className)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;};
    const list=document.getElementById("repository-issues");
    let model={}, selected=null, filter="all", panel="status", scope="", histories=new Map();
    const rows=()=>[...(model.snapshot?.workflows ?? [])].sort((a,b)=>b.issue.number-a.issue.number);
    const state=row=>workflowState(row,model.progress,model.live);
    const selectedRow=()=>rows().find(row=>row.issue.number===selected);
    function link(label,address,host) {
        const element=node("a",label);
        try {const url=new URL(address);if(url.protocol!=="https:"||url.hostname!==host||url.username||url.password||url.port)throw Error();element.href=url.href;element.target="_blank";element.rel="noopener noreferrer";}
        catch {element.setAttribute("aria-disabled","true");}
        return element;
    }
    function showPanel(name) {
        panel=name;
        for(const button of document.querySelectorAll("[data-work-panel]"))button.setAttribute("aria-pressed",String(button.dataset.workPanel===name));
        for(const key of ["status","plan","history"])document.getElementById("work-"+key+"-panel").hidden=key!==name;
    }
    function badge(id,label,tone) {get(id).textContent=label;get(id).className="badge "+tone;}
    function checkRow(name,status) {const item=node("div",undefined,"check-row");item.append(node("span",name),node("span",status,{"成功":"passed","失敗":"failed"}[status]||""));return item;}
    function detail(row) {
        get("detail").hidden=!row;
        if(!row){
            for(const id of ["number","how-number","title","badge","next-title","next-copy","what-body","how-body","failure-body","local-checks","ci-checks","discussion","links","history","steps"])get(id).replaceChildren();
            get("primary").removeAttribute("href");return;
        }
        const info=state(row),ci=currentCI(row),verification=currentVerification(row,model.snapshot,model.progress,model.live);
        get("number").textContent="WHAT #"+row.issue.number;get("how-number").textContent=row.linear?"HOW "+row.linear.identifier:"HOWを未作成";
        get("title").textContent=row.issue.title;badge("badge",info.label,info.tone);
        let action=row.phase==="triage"&&row.linear?link("LinearでHOWを確認 ↗",row.linear.url,"linear.app"):
            row.pull_request?link(ci.status==="failure"?"PRとCIを確認 ↗":"PRをレビュー ↗",row.pull_request.url,"github.com"):
            link(row.phase==="waiting-how"?"GitHubで計画を依頼 ↗":"WHATを確認 ↗",row.issue.url,"github.com");
        action.id="workflow-primary";action.className="btn primary small";get("primary").replaceWith(action);
        get("codex").disabled=!!model.busy||!model.device;
        get("control").disabled=!!model.busy||!model.device||!model.live||!model.progress||model.progress.state==="offline";
        const step=["waiting-how","needs-how","triage"].includes(row.phase)?0:["approved","running"].includes(row.phase)?1:row.phase==="review"?3:row.phase==="done"||row.phase==="merged"?4:0;
        const current=ci.status==="failure"||info.active&&["verifying","integrating","pushing","publishing"].includes(model.progress?.stage)?2:step;
        get("steps").replaceChildren(...["計画・承認","実装","検証","レビュー"].map((title,index)=>{
            const done=index<current&&(index!==2||ci.status==="success"&&verification?.status==="success");
            return node("li",(done?"✓ ":index===current?"● ":"")+title,"step"+(done?" done":index===current?" current":""));
        }));
        const next={"waiting-how":["計画の依頼を待っています","GitHub Issueのコメントを /oriel how で始めると、HOWの計画を依頼できます。実装の承認はLinearで行います。"],"needs-how":["HOWの提案を待っています","端末でワークフローを起動すると、目的に沿ったHOWを提案します。"],triage:["あなたのHOW確認を待っています","LinearでHOWを確認し、Todoへ移すと実装を承認します。"],approved:["実装の開始を待っています","承認と実行設定を確認してから、端末で実装を開始します。"],running:["承認されたHOWを実装しています","実行段階を確認し、必要な場合はCodexから一時停止してください。"],review:["PRのレビューをお願いします","GitHubで変更とCIの結果を確認し、レビュー・マージしてください。"],merged:["完了状態への同期を待っています","PRのマージを確認しました。LinearのDoneへの反映を待っています。"],done:["作業は完了しています","PRのマージとLinearのDoneを確認しました。"],closed:["この作業は終了しています","管理対象のPRのマージは未確認です。自動実行は行いません。"],blocked:["作業を進められません",row.blocked_reason||"HOWと実行条件を確認してください。"]}[row.phase]||["現在の状態は未確認です","更新して状態を確認してください。"];
        if(ci.status==="failure") {next[0]=info.active?"CIの失敗に対応しています":"CIの失敗を確認してください";next[1]=info.active?"端末の進行状況と、失敗したCIの結果を確認できます。":"PRで失敗した工程を確認してください。端末が自動修正中かどうかは実行状況から確認できます。";}
        if(info.label==="一時停止"){next[0]="ワークフローを一時停止しています";next[1]="Codexで実行条件を確認してから再開してください。";}
        if(row.phase==="running"&&!info.active){next[0]=model.live?"この作業の再開を待っています":"実行状況は未確認です";next[1]=model.live?"現在この作業を実行する端末は確認できません。実行端末と進行中の作業を確認してください。":"進捗通知への再接続を待っています。最後に取得した作業の状態を表示しています。";}
        if(row.blocked_reason&&row.phase!=="waiting-how")next[1]=row.blocked_reason;
        get("next").className="next-action"+(info.group==="waiting"?" waiting":"");get("next-title").textContent=next[0];get("next-copy").textContent=next[1];
        const statuses={success:["✓ 成功","green"],failure:["× 失敗","red"],running:["実行中","green"],pending:["実行待ち・実行中","amber"],unknown:["未取得","neutral"]};
        const verificationPaused=verification?.status==="running"&&model.progress?.state==="paused";
        badge("local-badge",...(verificationPaused?["一時停止","amber"]:statuses[verification?.status||"unknown"]));
        const local=get("local-checks");local.replaceChildren();
        if(verification) {
            local.append(checkRow("設定した検証コマンド",verification.completed+" / "+verification.total+" 件完了"));
            for(const [index,argv] of (model.snapshot.configuration?.verification||[]).entries())local.append(checkRow(argv.join(" "),index<verification.completed?"成功":index===verification.completed&&verification.status==="failure"?"失敗":index===verification.completed&&verification.status==="running"?verificationPaused?"一時停止":"実行中":"未実行"));
        } else local.append(node("p","現在の変更に対する端末の検証結果は未取得です。更新したorieldからの報告を待っています。","check-note"));
        get("local-note").textContent=verification?"検証したコミット: "+verification.head_oid.slice(0,12)+" · "+new Date(verification.updated_at).toLocaleString("ja-JP"):"端末側の検証とGitHub CIは、確認する工程が異なります。";
        badge("ci-badge",...statuses[ci.status]);get("ci-checks").replaceChildren();
        for(const check of ci.checks||[]) {const item=checkRow(check.name,{success:"成功",failure:"失敗",pending:"実行中",skipped:"省略",unknown:"未取得"}[check.status]||"未取得");if(check.url){const title=link(check.name+" ↗",check.url,"github.com");if(title.hasAttribute("href"))item.firstChild.replaceWith(title);}get("ci-checks").append(item);}
        if(!ci.checks?.length)get("ci-checks").append(node("p",row.pull_request?"現在のPRコミットに対するCIの情報は未取得です。":"PRがまだないため、CIの結果はありません。","check-note"));
        get("failure").hidden=row.feedback?.kind!=="check_failure";get("failure-body").textContent=row.feedback?.body||"";
        get("links").replaceChildren(link("WHATを確認 ↗",row.issue.url,"github.com"),...(row.linear?[link("HOWを確認 ↗",row.linear.url,"linear.app")]:[]),...(row.pull_request?[link("PR #"+row.pull_request.number+"を開く ↗",row.pull_request.url,"github.com")]:[]));
        get("evidence-note").textContent=model.live?"接続状態は進捗通知で確認しています。承認状態はGitHub・Linearの取得結果を表示しています。":"進捗通知は未確認です。最後に取得した作業の情報を表示しています。";
        get("what-body").textContent=row.issue.body||"本文はありません。";get("how-heading").textContent=row.phase==="triage"?"HOW — 提案された進め方":"HOW — 作業の進め方";
        get("how-body").textContent=row.linear?.description||"HOWはまだありません。";
        get("discussion").replaceChildren();
        for(const [title,comments] of [["WHATのコメント",row.what_comments||[]],["HOWのコメント",row.how_comments||[]]]) {const section=node("details");section.append(node("summary",title+"（"+comments.length+"件）"));for(const comment of comments){section.append(node("p",(comment.author||"投稿者不明")+" · "+comment.created_at,"check-note"),node("p",comment.body,"how-description"));}get("discussion").append(section);}
        if(row.feedback) get("discussion").append(node("h4","PRフィードバック"),node("p",[row.feedback.body,...(row.feedback.comments||[]).map(comment=>(comment.path||"")+" "+(comment.line||"")+" "+comment.body)].join("\n\n"),"how-description"));
        get("history").replaceChildren(...(histories.get(row.issue.number)||[]).map(event=>{const item=node("li");const info=node("div");info.append(node("strong",event.title),node("p",event.body));item.append(node("time",new Date(event.time).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"})),info);return item;}));
        if(!get("history").children.length)get("history").append(node("li","この作業の進捗通知はまだありません。"));
        showPanel(panel);
    }
    function render() {
        const focus=document.activeElement?.dataset?.workNumber;
        if(!selectedRow())selected=rows().find(row=>state(row).active)?.issue.number??rows().find(row=>!["done","closed"].includes(row.phase))?.issue.number??rows()[0]?.issue.number??null;
        const query=get("search").value.trim().toLowerCase();
        const visible=rows().filter(row=>(filter==="all"||state(row).group===filter)&&(row.issue.number+" "+row.issue.title+" "+(row.linear?.identifier||"")).toLowerCase().includes(query));
        for(const group of ["running","waiting","review"])get(group+"-count").textContent=model.snapshot?rows().filter(row=>state(row).group===group).length:"—";
        get("done-count").textContent=model.snapshot?rows().filter(row=>row.phase==="done").length:"—";
        get("total").textContent=model.snapshot?visible.length+"件":"";
        list.replaceChildren(...visible.map(row=>{const info=state(row),item=node("li"),button=node("button",undefined,"task");button.type="button";button.dataset.workNumber=row.issue.number;button.setAttribute("aria-pressed",String(row.issue.number===selected));
            const meta=node("span",undefined,"task-meta");meta.append(node("span","#"+row.issue.number),node("span",row.linear?.identifier||"HOWを未作成"));
            const foot=node("span",undefined,"task-foot");foot.append(node("span",info.label,"badge "+info.tone));if(currentCI(row).status==="failure")foot.append(node("span","CI失敗","failed"));
            button.append(meta,node("span",row.issue.title,"task-title"),foot);button.addEventListener("click",()=>{selected=row.issue.number;showPanel("status");render();list.querySelector('[data-work-number="'+selected+'"]').focus({preventScroll:true});});item.append(button);return item;}));
        if(focus)list.querySelector('[data-work-number="'+focus+'"]')?.focus({preventScroll:true});
        get("empty").hidden=visible.length>0;get("empty").textContent=model.snapshot?rows().length?"該当する作業はありません。":"作業はありません。WHATを作成して始めてください。":"作業の取得結果は未確認です。連携設定を確認し、更新してください。";
        detail(selectedRow());
    }
    get("search").addEventListener("input",render);
    for(const button of document.querySelectorAll("[data-work-filter]"))button.addEventListener("click",()=>{filter=button.dataset.workFilter;for(const item of document.querySelectorAll("[data-work-filter]"))item.setAttribute("aria-pressed",String(item===button));render();});
    for(const button of document.querySelectorAll("[data-work-panel]"))button.addEventListener("click",()=>showPanel(button.dataset.workPanel));
    get("device").addEventListener("change",()=>onDevice(get("device").value));get("create").addEventListener("click",onCreate);
    get("codex").addEventListener("click",()=>onCodex(false));get("control").addEventListener("click",()=>onCodex(true));
    return {update(next) {
        const nextScope=(next.userId||"")+":"+(next.device?.device_id||"");
        if(scope!==nextScope){scope=nextScope;selected=null;panel="status";histories.clear();get("search").value="";filter="all";document.getElementById("workflow-create-dialog").close();for(const button of document.querySelectorAll("[data-work-filter]"))button.setAttribute("aria-pressed",String(button.dataset.workFilter==="all"));}
        model=next;
        const ids=(next.devices||[]).map(device=>device.device_id).join(",");
        if(get("device").dataset.ids!==ids){get("device").replaceChildren(...(next.devices||[]).map(device=>{const option=node("option",device.name);option.value=device.device_id;return option;}));get("device").dataset.ids=ids;}
        get("device").value=next.device?.device_id||"";get("device").disabled=!!next.busy;
        const terminal={online:"使用可能",grace:"再接続中",offline:"使用不可",unknown:"未確認"}[next.device?.terminal_status]||"未確認";
        get("connection").textContent="端末中継: "+terminal+" · ワークフロー: "+(next.live?stageLabels[next.progress?.stage]||"未接続":"未確認");
        get("create").disabled=!!next.busy||!next.snapshot;
        for(const button of document.querySelectorAll("[data-work-filter],[data-work-panel]"))button.disabled=!!next.busy||!next.snapshot;
        const progress=next.progress;
        if(next.live&&progress?.task?.issue_number&&progress.updated_at){const number=progress.task.issue_number;const events=histories.get(number)||[];const title=stageLabels[progress.stage]||progress.state;const key=JSON.stringify([progress.updated_at,title,progress.verification]);if(events[0]?.key!==key){events.unshift({key,time:progress.updated_at,title:title+"の進捗を受信",body:progress.verification?"端末検証 "+progress.verification.completed+" / "+progress.verification.total+" 件":"対象: #"+number});if(events.length>30)events.length=30;if(histories.size>=64&&!histories.has(number))histories.delete(histories.keys().next().value);histories.set(number,events);}}
        render();
    }};
}
