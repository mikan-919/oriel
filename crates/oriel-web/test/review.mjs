// Offline review fixtures use the generated HTML and the production dashboard code.
// Run cargo run -p oriel-web, then node crates/oriel-web/test/review.mjs.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const root=new URL('../',import.meta.url);
const html=readFileSync(new URL('build/index.html',root),'utf8');
const css=readFileSync(new URL('src/assets/dashboard.css',root),'utf8');
const js=readFileSync(new URL('src/assets/dashboard.js',root),'utf8');
const output=new URL('build/review/',root);mkdirSync(output,{recursive:true});
for(const state of ['signed-out','pairing','normal','empty','loading','failed','reconnecting']) {
  const setup=`
  const NativeURL = window.URL;
  window.URL = class extends NativeURL {constructor(input, base) {super(input, base === "null" ? "https://fixture.invalid" : base);}};
  const fixtureState = ${JSON.stringify(state)};
  window.orielPairing = {token: fixtureState==='pairing' ? 'a'.repeat(64) : null, invalid:false};
  window.orielConnection = {};
  const fixtureDevice = {device_id:'fixture',name:'開発端末',terminal_status:'online',repository:{owner:'demo',name:'oriel'}};
  window.fetch=async path=>{
    if(fixtureState==='loading')return new Promise(()=>{});
    if(fixtureState==='failed' && path!=='/api/session')throw Error('fixture: 状態を取得できません');
    const data=path==='/api/session' ? {user:fixtureState==='signed-out'?null:{id:'fixture-user',display_name:'レビュー用アカウント'}}
      : path==='/api/devices' ? {devices:fixtureState==='empty'||fixtureState==='pairing'?[]:[fixtureDevice]}
      : path==='/api/pair/inspect' ? {device_id:'fixture',name:'開発端末',expires_at:Math.floor(Date.now()/1000)+60}
      : path.startsWith('/api/workflows/') ? {repository:fixtureDevice.repository,team:{team_name:'開発チーム'},workflows:[],configuration:{autonomous:false,verification:[]}}
      : {github:null,linear:null,choices:{github:[],linear:[]}};
    return {ok:true,json:async()=>data};
  };
  window.WebSocket=class {
    static OPEN=1;listeners={};readyState=1;
    constructor(){setTimeout(()=>{this.listeners.open?.({});if(fixtureState!=='reconnecting')this.listeners.message?.({data:JSON.stringify({type:'workflow-progress',devices:[{device_id:'fixture',state:'running',stage:'implementing',updated_at:new Date().toISOString()}]})});else this.listeners.error?.({});},100);}
    addEventListener(name,fn){this.listeners[name]=fn;}send(){}close(){}
  };
  `;
  const fixture=html.replace(/<link[^>]*>/g,'').replace(/<script[\s\S]*?<\/script>/g,'')
    .replace('</head>',`<style>${css}</style></head>`)
    .replace('</body>',`<script>${setup}</script><script>${js}</script></body>`);
  writeFileSync(new URL(`${state}.html`,output),fixture);
}
console.log('Offline review fixtures: '+output.pathname);
