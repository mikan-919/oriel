// Offline review fixtures use the generated HTML and the production dashboard code.
// Run cargo run -p oriel-web, then node crates/oriel-web/test/review.mjs.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const html=readFileSync(new URL('build/public/index.html',root),'utf8');
const css=readFileSync(new URL('src/assets/dashboard.css',root),'utf8');
const codex=readFileSync(new URL('src/assets/codex.js',root),'utf8').replace('export function mountCodex', 'function mountCodex');
const workflow=readFileSync(new URL('src/assets/workflow.js',root),'utf8').replace(/^export /gm,'');
const js=workflow+'\n'+codex+'\n'+readFileSync(new URL('src/assets/dashboard.js',root),'utf8').replace(/^import .*;\n/gm, '');
const output=new URL('build/review/',root);mkdirSync(output,{recursive:true});
for(const state of ['signed-out','pairing','normal','empty','loading','failed','reconnecting','codex']) {
  const setup=`
  const NativeURL = window.URL;
  window.URL = class extends NativeURL {constructor(input, base) {super(input, base === "null" ? "https://fixture.invalid" : base);}};
  const fixtureState = ${JSON.stringify(state)};
  window.orielPairing = {token: fixtureState==='pairing' ? 'a'.repeat(64) : null, invalid:false};
  window.orielConnection = {};
  const fixtureDevice = {device_id:'fixture',name:'開発端末',terminal_status:'online',repository:{owner:'demo',name:'oriel'}};
  const fixtureHead='a'.repeat(40);
  const sampleRow=(number,title,phase,ci)=>({issue:{number,title,body:'達成したいことと完了条件を確認します。',url:'https://github.com/mikan-919/oriel/issues/'+number,state:'open'},linear:{identifier:'MIKAN-'+number,title,description:'変更を作成し、設定した検証を実行します。',url:'https://linear.app/example/issue/MIKAN-'+number,state:{name:phase==='triage'?'Triage':'In Progress'}},phase,canonical_oid:fixtureHead,what_comments:[],how_comments:[],pull_request:phase==='review'?{number:87,url:'https://github.com/mikan-919/oriel/pull/87',head_oid:fixtureHead}:null,ci:ci?{head_oid:fixtureHead,status:ci,checks:[{name:'validate',status:ci,url:'https://github.com/mikan-919/oriel/actions'}]}:undefined,feedback:ci==='failure'?{kind:'check_failure',key:'check:sample:'+fixtureHead,body:'Install unpacked package: archive not found',comments:[]}:null});
  const fixtureRows=fixtureState==='normal'?[sampleRow(86,'cargo installでorieldをインストールできるようにする','review','failure'),sampleRow(92,'端末の接続状態と実行状況を分けて表示する','triage'),sampleRow(84,'セッション失効後に再ログインへ案内する','review','success')]:[];
  window.fixtureRequests=[];
  window.fetch=async (path,options={})=>{
    window.fixtureRequests.push({path,method:options.method||'GET'});
    if(path.endsWith('/issues')&&options.method==='POST'){const body=JSON.parse(options.body);const row=sampleRow(99,body.title,'waiting-how');row.issue.body=body.body;row.linear=null;fixtureRows.push(row);return {ok:true,json:async()=>({issue:row.issue})};}

    if(fixtureState==='loading')return new Promise(()=>{});
    if(fixtureState==='failed' && path!=='/api/session')throw Error('fixture: 状態を取得できません');
    const data=path==='/api/session' ? {user:fixtureState==='signed-out'?null:{id:'fixture-user',display_name:'レビュー用アカウント'}}
      : path==='/api/devices' ? {devices:fixtureState==='empty'||fixtureState==='pairing'?[]:[fixtureDevice]}
      : path==='/api/pair/inspect' ? {device_id:'fixture',name:'開発端末',expires_at:Math.floor(Date.now()/1000)+60}
      : path.startsWith('/api/workflows/') ? {repository:fixtureDevice.repository,team:{team_name:'開発チーム'},repository_id:501,target_oid:fixtureHead,workflows:fixtureRows,configuration:{autonomous:true,verification:[['cargo','test','--workspace'],['cargo','clippy','--workspace']],error:null}}
      : {github:null,linear:null,choices:{github:[],linear:[]}};
    return {ok:true,json:async()=>data};
  };
  window.fixtureRPCs=[];
  const codexState={type:'state',workflowPaused:false,engines:[
    {id:'manual',title:'相談・レビュー',automatic:false,readOnly:true,requests:[{id:'question',method:'item/tool/requestUserInput',params:{questions:[{id:'choice',question:'検証する対象を選んでください。',options:[{label:'全体'},{label:'変更部分'}]}]}}]},
    {id:'automatic',title:'#86 · cargo install対応',automatic:true,readOnly:false,threadId:'auto-thread',turnId:'running',requests:[{id:'approval',method:'item/commandExecution/requestApproval',params:{command:'cargo test --workspace',reason:'テストを実行します。'}}]}
  ]};
  window.WebSocket=class {
    static OPEN=1;listeners={};readyState=1;
    constructor(url){this.codex=String(url).includes('/api/codex/');if(this.codex)window.fixtureCodex=this;setTimeout(()=>{this.listeners.open?.({});if(this.codex)this.deliver(codexState);else if(fixtureState!=='reconnecting')this.deliver({type:'workflow-progress',devices:[{device_id:'fixture',state:'running',stage:'verifying',task:{issue_number:86,title:'cargo install対応',url:'https://github.com/mikan-919/oriel/issues/86',how_identifier:'MIKAN-105',how_url:'https://linear.app/example/issue/MIKAN-105',repository:'demo/oriel'},verification:{issue_number:86,head_oid:fixtureHead,target_oid:fixtureHead,status:'success',completed:2,total:2,updated_at:new Date().toISOString()},updated_at:new Date().toISOString()}]});else this.listeners.error?.({});},100);}
    addEventListener(name,fn){this.listeners[name]=fn;}
    deliver(message){this.listeners.message?.({data:JSON.stringify(message)});}
    send(raw){if(raw==='oriel:ping'){this.listeners.message?.({data:'oriel:pong'});return;}if(!this.codex)return;const m=JSON.parse(raw);window.fixtureRPCs.push(m);let result={};
      if(m.method==='model/list')result={data:[{model:'test-model',displayName:'検証用モデル',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]};
      if(m.method==='thread/list')result={data:[{id:'saved',name:'保存した会話'}]};
      if(['thread/start','thread/fork','thread/resume','thread/read'].includes(m.method))result={thread:{id:m.params.threadId||'new',name:'保存した会話',turns:[{status:'completed',items:[{id:'message',type:'agentMessage',text:'保存済みの回答です。'}]}]}};
      if(m.method==='thread/read'&&m.params.threadId==='auto-thread')result.thread.turns=[{id:'running',status:'inProgress',items:[]}];
      if(['turn/start','review/start'].includes(m.method))result={turn:{id:'running',status:'inProgress'}};
      if(m.method==='skills/list')result={data:[{skills:[{name:'example-skill',description:'検証用スキル',enabled:true}]}]};
      if(m.method==='mcpServerStatus/list')result={data:[{name:'docs',authStatus:'notLoggedIn'}]};
      if(m.method==='mcpServer/oauth/login')result={authorizationUrl:'https://example.com/authorize'};
      if(m.method==='request/respond'){const engine=codexState.engines.find(e=>e.id===m.engine);engine.requests=engine.requests.filter(r=>r.id!==m.params.requestId);}
      if(m.method==='workflow/pause')codexState.workflowPaused=true;
      if(m.method==='workflow/resume')codexState.workflowPaused=false;
      setTimeout(()=>{this.deliver({type:'response',request_id:m.request_id,result});if(m.method==='turn/interrupt')this.deliver({type:'event',engine:m.engine,message:{method:'turn/completed',params:{turn:{id:'running',status:'interrupted'}}}});if(m.method.startsWith('workflow/'))this.deliver(codexState);},10);
    }
    close(){if(this.readyState===3)return;this.readyState=3;this.listeners.close?.({});}
  };
  `;
  const fixture=html.replace(/<link[^>]*>/g,'').replace(/<script[\s\S]*?<\/script>/g,'')
    .replace('</head>',`<style>${css}</style></head>`)
    .replace('</body>',()=>`<script>${setup}</script><script>${js}</script>${state==='codex'?'<script>setTimeout(()=>{showPage("codex",false);document.getElementById("codex-connect").click();},500);</script>':''}</body>`);
  writeFileSync(new URL(`${state}.html`,output),fixture);
}
console.log('Offline review fixtures: '+output.pathname);
