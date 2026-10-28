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
    return {status:"unknown",checks:[],acquisition:"unavailable",head_oid:row.pull_request?.head_oid};
}
export function verificationEvidence(row, snapshot, progress, live) {
    const value=progress?.verification;
    if (!value) return {value:null, reason:"この接続の検証報告は未受信です。保存した実行の経過は実行履歴で確認できます。"};
    if (value.issue_number !== row.issue.number) return {value:null,reason:"別の作業の結果です"};
    if (!value.execution_id || !value.configuration_id || !Array.isArray(value.commands)) return {value:null,reason:"旧形式の通知には実行・設定の証拠がありません"};
    if (!["running","success","failure"].includes(value.status) || !Number.isSafeInteger(value.completed) ||
        !Number.isSafeInteger(value.total) || value.total<1 || value.completed<0 || value.completed>value.total ||
        value.total!==value.commands.length || value.status==="success" && value.completed!==value.total)
        return {value:null,reason:"検証報告の証拠が不足しています"};
    const reasons=[];
    if(value.target_oid!==snapshot?.target_oid)reasons.push("基準コミットが異なります");
    if(JSON.stringify(value.commands)!==JSON.stringify(snapshot?.configuration?.verification))reasons.push("現在と検証設定が異なります");
    if(value.head_oid!==(row.pull_request?.head_oid??row.canonical_oid))reasons.push("現在のPRとは異なるコミット（push前を含む）");
    if(value.execution_id!==progress?.execution_id)reasons.push("保存した実行の結果");
    if((!live || value.execution_id!==progress?.execution_id || progress?.task?.issue_number!==row.issue.number)&&value.status==="running")reasons.push("最後に受信した進捗・現在は未確認");
    return {value,reason:reasons.join(" · "),current:reasons.length===0};
}
export function currentVerification(row, snapshot, progress, live) {
    return verificationEvidence(row,snapshot,progress,live).value;
}

export function mountWorkflow({onDevice, onCodex, onCreate, loadHistory}) {
    let staged = null, detailIdentity = "";
    const get=id=>staged?.get(id) ?? document.getElementById("workflow-"+id);
    const node=(tag,text,className)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;};
    const list=document.getElementById("repository-issues");
    let model={}, selected=null, filter="all", panel="status", scope="", generation="", histories=new Map(), evidence=new Map();
    const savedHistory=new Map();let historyRequest=0;
    async function refreshHistory(number=selected) {
        if(!loadHistory||!number||!model.device||!model.snapshot)return;
        const currentScope=scope,request=++historyRequest;
        if(savedHistory.size>=64&&!savedHistory.has(number))savedHistory.delete(savedHistory.keys().next().value);
        savedHistory.set(number,{loading:true,events:[],request});render();
        try {
            const result=await loadHistory(model.device.device_id,model.snapshot.repository_id,number);
            if(scope!==currentScope||savedHistory.get(number)?.request!==request)return;
            savedHistory.set(number,{...result,loading:false,request});
        } catch {if(scope===currentScope&&savedHistory.get(number)?.request===request)savedHistory.set(number,{events:[],error:true,request});}
        if(scope===currentScope&&savedHistory.get(number)?.request===request)render();
    }
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
        if(name==="history"&&!savedHistory.has(selected))refreshHistory();
    }
    function badge(id,label,tone) {get(id).textContent=label;get(id).className="badge "+tone;}
    function checkRow(name,status) {const item=node("div",undefined,"check-row");item.append(node("span",name),node("span",status,{"成功":"passed","失敗":"failed"}[status]||""));return item;}
    function sync(target, source) {
        if (target.nodeType === 3) { if(target.data!==source.data)target.data=source.data; return; }
        for(const attribute of [...target.attributes])if(!source.hasAttribute(attribute.name)&&!(target.tagName==="DETAILS"&&attribute.name==="open"))target.removeAttribute(attribute.name);
        for(const attribute of source.attributes)if(target.getAttribute(attribute.name)!==attribute.value)target.setAttribute(attribute.name,attribute.value);
        for(let i=0;i<source.childNodes.length;i++) {
            const next=source.childNodes[i], current=target.childNodes[i];
            if(current?.nodeName===next.nodeName)sync(current,next);
            else if(current)current.replaceWith(next.cloneNode(true));
            else target.append(next.cloneNode(true));
        }
        while(target.childNodes.length>source.childNodes.length)target.lastChild.remove();
    }
    function detail(row) {
        get("detail").hidden=!row;
        if(!row){
            for(const id of ["number","how-number","title","badge","next-title","next-copy","what-body","how-body","failure-body","local-checks","ci-checks","discussion","links","history","steps"])get(id).replaceChildren();
            get("primary").removeAttribute("href");return;
        }
        const identity=scope+":"+row.issue.number;
        if(detailIdentity!==identity)get("discussion").replaceChildren();
        detailIdentity=identity;
        staged=new Map(["primary","links","ci-checks","discussion"].map(id=>[id,get(id).cloneNode(false)]));
        const info=state(row),ci=currentCI(row);
        const received=evidence.get(row.issue.number) ?? (!model.progress?.verification?.execution_id ? model.progress?.verification : undefined);
        const observation=verificationEvidence(row,model.snapshot,{...model.progress,verification:received},model.live);
        const verification=observation.value;
        get("number").textContent="WHAT #"+row.issue.number;get("how-number").textContent=row.linear?"HOW "+row.linear.identifier:"HOWを未作成";
        get("title").textContent=row.issue.title;badge("badge",info.label,info.tone);
        let action=row.phase==="triage"&&row.linear?link("LinearでHOWを確認 ↗",row.linear.url,"linear.app"):
            row.pull_request?link(ci.status==="failure"?"PRとCIを確認 ↗":"PRをレビュー ↗",row.pull_request.url,"github.com"):
            link(row.phase==="waiting-how"?"GitHubで計画を依頼 ↗":"WHATを確認 ↗",row.issue.url,"github.com");
        action.id="workflow-primary";action.className="btn primary small";staged.set("primary",action);
        get("codex").disabled=!!model.busy||!model.device;
        get("control").disabled=!!model.busy||!model.device||!model.live||!model.progress||model.progress.state==="offline";
        const step=["waiting-how","needs-how","triage"].includes(row.phase)?0:["approved","running"].includes(row.phase)?1:row.phase==="review"?3:row.phase==="done"||row.phase==="merged"?4:0;
        const current=row.phase==="running"&&info.active&&["verifying","integrating","pushing","publishing"].includes(model.progress?.stage)?2:step;
        get("steps").replaceChildren(...["計画・承認","実装","検証","レビュー"].map((title,index)=>{
            const done=index<current;
            return node("li",(done?"":index===current?"● ":"")+title,"step"+(done?" done":index===current?" current":""));
        }));
        const next={"waiting-how":["計画の依頼を待っています","GitHub Issueのコメントを /oriel how で始めると、HOWの計画を依頼できます。実装の承認はLinearで行います。"],"needs-how":["HOWの提案を待っています","端末でワークフローを起動すると、目的に沿ったHOWを提案します。"],triage:["あなたのHOW確認を待っています","LinearでHOWを確認し、Todoへ移すと実装を承認します。"],approved:["実装の開始を待っています","承認と実行設定を確認してから、端末で実装を開始します。"],running:["承認されたHOWを実装しています","実行段階を確認し、必要な場合はCodexから一時停止してください。"],review:["PRのレビューをお願いします","GitHubで変更とCIの結果を確認し、レビュー・マージしてください。"],merged:["完了状態への同期を待っています","PRのマージを確認しました。LinearのDoneへの反映を待っています。"],done:["作業は完了しています","PRのマージとLinearのDoneを確認しました。"],closed:["この作業は終了しています","管理対象のPRのマージは未確認です。自動実行は行いません。"],blocked:["作業を進められません",row.blocked_reason||"HOWと実行条件を確認してください。"]}[row.phase]||["現在の状態は未確認です","更新して状態を確認してください。"];
        if(ci.status==="failure") {next[0]=info.active?"CIの失敗に対応しています":"CIの失敗を確認してください";next[1]=info.active?"端末の進行状況と、失敗したCIの結果を確認できます。":"PRで失敗した工程を確認してください。端末が自動修正中かどうかは実行状況から確認できます。";}
        if(info.label==="一時停止"){next[0]="ワークフローを一時停止しています";next[1]="Codexで実行条件を確認してから再開してください。";}
        if(row.phase==="running"&&!info.active){next[0]=model.live?"この作業の再開を待っています":"実行状況は未確認です";next[1]=model.live?"現在この作業を実行する端末は確認できません。実行端末と進行中の作業を確認してください。":"進捗通知への再接続を待っています。最後に取得した作業の状態を表示しています。";}
        if(row.blocked_reason&&row.phase!=="waiting-how")next[1]=row.blocked_reason;
        get("next").className="next-action"+(info.group==="waiting"?" waiting":"");get("next-title").textContent=next[0];get("next-copy").textContent=next[1];
        const statuses={success:["✓ 成功","green"],failure:["× 失敗","red"],running:["実行中","green"],pending:["実行待ち・実行中","amber"],unknown:["未取得","neutral"],empty:["CI結果なし","neutral"]};
        const unconfirmed=verification?.status==="running"&&(!model.live||verification.execution_id!==model.progress?.execution_id||model.progress?.task?.issue_number!==row.issue.number);
        const verificationPaused=!unconfirmed&&verification?.status==="running"&&model.progress?.state==="paused";
        badge("local-badge",...(unconfirmed?["進捗未確認","neutral"]:verificationPaused?["一時停止","amber"]:statuses[verification?.status||"unknown"]));
        const local=get("local-checks");local.replaceChildren();
        if(verification) {
            local.append(checkRow("設定した検証コマンド",verification.completed+" / "+verification.total+" 件完了"));
            for(const [index,argv] of (verification.commands||[]).entries())local.append(checkRow(argv.join(" "),index<verification.completed?"成功":index===verification.completed&&verification.status==="failure"?"失敗":index===verification.completed&&verification.status==="running"?unconfirmed?"最後の進捗・未確認":verificationPaused?"一時停止":"実行中":"未実行"));
        } else local.append(node("p",observation.reason,"check-note"));
        get("local-note").textContent=verification?"検証したコミット: "+verification.head_oid.slice(0,12)+" · 作業 #"+verification.issue_number+" · 実行 "+verification.execution_id+" · 設定 "+verification.configuration_id+" · 基準 "+verification.target_oid+" · "+observation.reason+" · "+new Date(verification.updated_at).toLocaleString("ja-JP"):"端末側の検証とGitHub CIは、確認する工程が異なります。";
        badge("ci-badge",...statuses[ci.acquisition==="received"&&!ci.checks?.length?"empty":ci.status]);get("ci-checks").replaceChildren();
        if(ci.head_oid)get("ci-checks").append(node("p","対象コミット: "+ci.head_oid+" · "+(ci.fetched_at?new Date(ci.fetched_at).toLocaleString("ja-JP"):"取得時刻は不明"),"check-note"));
        for(const check of ci.checks||[]) {const item=checkRow(check.name,{success:"成功",failure:"失敗",pending:"実行中",skipped:"省略",unknown:"未取得"}[check.status]||"未取得");if(check.url){const title=link(check.name+" ↗",check.url,"github.com");if(title.hasAttribute("href"))item.firstChild.replaceWith(title);}get("ci-checks").append(item);}
        if(!ci.checks?.length)get("ci-checks").append(node("p",ci.acquisition==="received"?"CI結果なし（取得成功・検査0件）。起動されなかった理由は不明です。":row.pull_request?"CIを取得できません。取得経路または対象コミットを確認してください。":"PRがまだないため、CIの結果はありません。","check-note"));
        get("failure").hidden=row.feedback?.kind!=="check_failure";get("failure-body").textContent=row.feedback?.body||"";
        get("links").replaceChildren(link("WHATを確認 ↗",row.issue.url,"github.com"),...(row.linear?[link("HOWを確認 ↗",row.linear.url,"linear.app")]:[]),...(row.pull_request?[link("PR #"+row.pull_request.number+"を開く ↗",row.pull_request.url,"github.com")]:[]));
        get("evidence-note").textContent=model.live?"接続状態は進捗通知で確認しています。承認状態はGitHub・Linearの取得結果を表示しています。":"進捗通知は未確認です。最後に取得した作業の情報を表示しています。";
        get("what-body").textContent=row.issue.body||"本文はありません。";get("how-heading").textContent=row.phase==="triage"?"HOW — 提案された進め方":"HOW — 作業の進め方";
        get("how-body").textContent=row.linear?.description||"HOWはまだありません。";
        get("discussion").replaceChildren();
        for(const [title,comments] of [["WHATのコメント",row.what_comments||[]],["HOWのコメント",row.how_comments||[]]]) {const section=node("details");section.append(node("summary",title+"（"+comments.length+"件）"));for(const comment of comments){section.append(node("p",(comment.author||"投稿者不明")+" · "+comment.created_at,"check-note"),node("p",comment.body,"how-description"));}get("discussion").append(section);}
        if(row.feedback) get("discussion").append(node("h4","PRフィードバック"),node("p",[row.feedback.body,...(row.feedback.comments||[]).map(comment=>(comment.path||"")+" "+(comment.line||"")+" "+comment.body)].join("\n\n"),"how-description"));
        const saved=savedHistory.get(row.issue.number);
        const reasons={completed:"処理完了","web-paused":"Webから一時停止","approval-changed":"承認内容の変更","authority-unconfirmed":"実行権限を確認できません","interrupted":"端末で中断","pr-closed":"PR終了","target-changed":"対象コミットの変更","model-capacity":"モデル利用上限","rate-limited":"外部サービスの利用上限","needs-human":"人の判断が必要","verification":"検証失敗","runtime":"実行失敗"};
        const stored=(saved?.events||[]).map(event=>{
            const v=event.verification;
            return {key:JSON.stringify([event.execution_id,event.stage,v&&[v.head_oid,v.target_oid,v.status,v.completed,v.total]]),time:event.recorded_at,
              title:event.kind==="ended"?reasons[event.outcome?.reason]||"実行終了":event.kind==="started"?event.resumed?"実行再開（新しい実行）":"実行開始":event.kind==="disconnected"?"接続切断・実行結果は未確定":event.kind==="released"?"実行権の解放":stageLabels[event.stage]||event.stage,
              body:"実行 "+event.execution_id+" · 端末 "+model.device.device_id+(v?" · 検証コミット "+v.head_oid+" · 基準 "+v.target_oid+" · "+v.completed+" / "+v.total+" · "+v.status:"")};
        });
        const keys=new Set(stored.map(event=>event.key));
        const combined=[...stored,...(histories.get(row.issue.number)||[]).filter(event=>!keys.has(event.key))].sort((a,b)=>b.time.localeCompare(a.time));
        get("history-status").textContent=saved?.loading?"保存済み履歴を取得中です。":saved?.error?"保存済み履歴を取得できません。履歴を更新して再試行してください。":saved?combined.length?(saved.truncated?"取得上限の200件を表示しています。":"保存済み履歴とこの画面の進捗を表示しています。検証結果は記載されたコミットの結果です。現在のPRの検証結果は状態欄で確認してください。"):"保存済み履歴はありません。":"履歴欄を開くと保存済み履歴を取得します。";
        get("history").replaceChildren(...combined.map(event=>{const item=node("li");const info=node("div");info.append(node("strong",event.title),node("p",event.body));item.append(node("time",new Date(event.time).toLocaleString("ja-JP")),info);return item;}));
        const updates=staged;staged=null;
        for(const [id,content] of updates)sync(get(id),content);
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
            button.append(meta,node("span",row.issue.title,"task-title"),foot);button.addEventListener("click",()=>{selected=row.issue.number;showPanel("status");render();if(matchMedia("(max-width: 760px)").matches)get("title").focus();else list.querySelector('[data-work-number="'+selected+'"]').focus({preventScroll:true});});item.append(button);return item;}));
        if(focus)list.querySelector('[data-work-number="'+focus+'"]')?.focus({preventScroll:true});
        get("empty").hidden=visible.length>0;get("empty").textContent=model.snapshot?rows().length?"該当する作業はありません。":"作業はありません。WHATを作成して始めてください。":"作業の取得結果は未確認です。連携設定を確認し、更新してください。";
        detail(selectedRow());
    }
    get("search").addEventListener("input",render);
    for(const button of document.querySelectorAll("[data-work-filter]"))button.addEventListener("click",()=>{filter=button.dataset.workFilter;for(const item of document.querySelectorAll("[data-work-filter]"))item.setAttribute("aria-pressed",String(item===button));render();});
    for(const button of document.querySelectorAll("[data-work-panel]"))button.addEventListener("click",()=>showPanel(button.dataset.workPanel));
    get("history-refresh").addEventListener("click",()=>refreshHistory());
    get("device").addEventListener("change",()=>onDevice(get("device").value));get("create").addEventListener("click",onCreate);
    get("codex").addEventListener("click",()=>onCodex(false));get("control").addEventListener("click",()=>onCodex(true));
    return {select(number) { if(rows().some(row=>row.issue.number===number)){selected=number;showPanel("status");render();get("primary").focus();} },update(next) {
        const nextScope=(next.userId||"")+":"+(next.device?.device_id||"")+":"+JSON.stringify([next.snapshot?.repository_id,next.snapshot?.repository]);
        if(scope!==nextScope || next.progress?.generation && generation && generation!==next.progress.generation){scope=nextScope;generation="";selected=null;panel="status";histories.clear();evidence.clear();savedHistory.clear();historyRequest++;get("search").value="";filter="all";document.getElementById("workflow-create-dialog").close();for(const button of document.querySelectorAll("[data-work-filter]"))button.setAttribute("aria-pressed",String(button.dataset.workFilter==="all"));}
        if(next.progress?.generation)generation=next.progress.generation;
        model=next;
        const report=next.live&&next.progress?.verification;
        const repository=next.snapshot?.repository;
        if(report?.execution_id && report.device_id===next.device?.device_id &&
           report.repository===repository?.owner+"/"+repository?.name && report.generation===generation) {
            evidence.delete(report.issue_number);evidence.set(report.issue_number,report);
            if(evidence.size>64)evidence.delete(evidence.keys().next().value);
        }
        const ids=(next.devices||[]).map(device=>device.device_id).join(",");
        if(get("device").dataset.ids!==ids){get("device").replaceChildren(...(next.devices||[]).map(device=>{const option=node("option",device.name);option.value=device.device_id;return option;}));get("device").dataset.ids=ids;}
        get("device").value=next.device?.device_id||"";get("device").disabled=!!next.busy;
        const terminal={online:"使用可能",grace:"再接続中",offline:"使用不可",unknown:"未確認"}[next.device?.terminal_status]||"未確認";
        get("connection").textContent="端末中継: "+terminal+" · ワークフロー: "+(next.live?stageLabels[next.progress?.stage]||"未接続":"未確認");
        get("create").disabled=!!next.busy||(!next.pendingWhat&&!next.snapshot);
        if(next.pendingWhat)get("device").disabled=true;
        for(const button of document.querySelectorAll("[data-work-filter],[data-work-panel]"))button.disabled=!!next.busy||!next.snapshot;
        const progress=next.progress;
        if(next.live&&progress?.task?.issue_number&&progress.updated_at){const number=progress.task.issue_number;const events=histories.get(number)||[];const title=stageLabels[progress.stage]||progress.state;const v=progress.verification;const key=JSON.stringify([progress.execution_id,progress.stage,v&&[v.head_oid,v.target_oid,v.status,v.completed,v.total]]);if(events[0]?.key!==key){events.unshift({key,time:progress.updated_at,title:title+"の進捗を受信",body:progress.verification?"端末検証 "+progress.verification.completed+" / "+progress.verification.total+" 件":"対象: #"+number});if(events.length>30)events.length=30;if(histories.size>=64&&!histories.has(number))histories.delete(histories.keys().next().value);histories.set(number,events);}}
        render();
    }};
}

export function mountWorkflowNotifications(onSelect) {
    const toggle=document.getElementById("workflow-notifications-toggle"), status=document.getElementById("workflow-notifications-status");
    let userId="", scope="", enabled=false, previous=new Map(), current=new Set();
    const supported=()=>typeof Notification!=="undefined";
    const close=()=>{for(const notification of current)notification.close();current.clear();};
    const preference=()=>{try{localStorage.setItem("oriel:notifications:"+userId,String(enabled));}catch{}};
    function render() {
        toggle.disabled=!userId||!supported();toggle.textContent=enabled?"通知を無効にする":"通知を有効にする";
        status.textContent=!supported()?"このブラウザーは通知に対応していません。":!userId?"ログインすると通知を設定できます。":Notification.permission==="denied"?"通知はブラウザーで拒否されています。許可の変更はブラウザーの設定で行ってください。":enabled&&Notification.permission==="granted"?"通知は有効です。この画面を開いている間、承認待ち・レビュー待ち・停止を通知します。":"通知は無効です。";
    }
    toggle.addEventListener("click",async()=>{
        const owner=userId;
        if(enabled){enabled=false;close();preference();render();return;}
        try{const permission=await Notification.requestPermission();if(owner!==userId)return;enabled=permission==="granted";preference();}catch{enabled=false;}
        render();
    });
    return {update(model) {
        if(userId!==(model.userId||"")) {
            userId=model.userId||"";enabled=false;
            try{enabled=!!userId&&localStorage.getItem("oriel:notifications:"+userId)==="true";}catch{}
        }
        const nextScope=JSON.stringify([userId,model.device?.device_id,model.snapshot?.repository_id,model.snapshot?.repository]);
        if(scope!==nextScope){scope=nextScope;previous.clear();close();}
        render();if(!userId||!model.snapshot)return;
        const next=new Map();
        for(const row of model.snapshot.workflows) {
            const old=previous.get(row.issue.number);
            const paused=model.live&&model.progress?.task?.issue_number===row.issue.number&&model.progress.state==="paused";
            const key=paused?"paused":!model.live&&old?.phase===row.phase?old.key:row.phase;
            next.set(row.issue.number,{phase:row.phase,key});
            if(!old||old.key===key||!enabled||!supported()||Notification.permission!=="granted"||!["triage","review","blocked","paused"].includes(key))continue;
            const label={triage:"承認待ち",review:"レビュー待ち",blocked:"停止中",paused:"一時停止"}[key];
            try {
                const notification=new Notification("#"+row.issue.number+" "+row.issue.title,{body:label,tag:scope+":"+row.issue.number});
                current.add(notification);if(current.size>32){const first=current.values().next().value;first.close();current.delete(first);}
                const targetScope=scope;
                notification.onclick=()=>{notification.close();current.delete(notification);if(scope===targetScope&&enabled){window.focus();onSelect(row.issue.number);}};
                notification.onclose=()=>current.delete(notification);
            } catch { /* Notification failure must not interrupt workflow controls. */ }
        }
        previous=next;
    }};
}
