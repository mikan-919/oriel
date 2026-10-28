// Run after cargo run -p oriel-web. Initial rendering must not wait for unrelated data or terminal-only assets.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from '../../oriel-relay/node_modules/playwright/index.mjs';

const publicRoot=new URL('../build/public/',import.meta.url);
const assets=new Map(['/index.html','/dashboard.css','/terminal.js','/workflow.js','/codex.js'].map(path=>[
  path,readFileSync(new URL('.'+path,publicRoot)),
]));
const browser=await chromium.launch({headless:true});
let releaseIssues;
try {
  const page=await browser.newPage();
  const external=[];
  const issuesPending=new Promise(resolve=>{releaseIssues=resolve;});
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='https://fixture.invalid') {
      external.push(url.href);
      return route.abort();
    }
    if(url.pathname==='/api/session')return route.fulfill({contentType:'application/json',body:'{"user":{"id":"owner","display_name":"確認用"}}'});
    if(url.pathname==='/api/devices')return route.fulfill({contentType:'application/json',body:JSON.stringify({devices:[{device_id:'device',name:'開発端末',terminal_status:'online',repository:{owner:'demo',name:'repo'}}]})});
    if(url.pathname==='/api/integrations')return route.fulfill({contentType:'application/json',body:'{"github":{"owner":"demo","name":"repo","repository_id":1,"installation_id":1},"linear":null,"choices":{"github":[],"linear":[]}}'});
    if(url.pathname==='/api/integrations/issues')return issuesPending.then(()=>route.fulfill({contentType:'application/json',body:'{"github":null,"linear":null}'}));
    if(url.pathname==='/api/workflows/device')return route.fulfill({contentType:'application/json',body:JSON.stringify({repository:{owner:'demo',name:'repo'},team:{team_name:'開発チーム'},repository_id:1,target_oid:'a'.repeat(40),workflows:[],configuration:{autonomous:true,verification:[],error:null}})});
    const path=url.pathname==='/'?'/index.html':url.pathname;
    const body=assets.get(path);
    if(!body)return route.abort();
    const contentType=path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':'text/html';
    return route.fulfill({contentType,body});
  });
  await page.goto('https://fixture.invalid/',{waitUntil:'domcontentloaded'});
  await page.locator('#page-title').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.getElementById('repository-status').textContent.includes('0件'),null,{timeout:1000});
  await page.waitForFunction(()=>document.getElementById('status').textContent!=='処理中…',null,{timeout:1000});
  assert.deepEqual(external.filter(url=>url.includes('xterm')),[],'initial rendering requested terminal-only assets');
  console.log('Initial workflow rendering does not wait for integrations or terminal-only assets');
} finally {releaseIssues?.();await browser.close();}
