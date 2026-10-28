// Run after cargo run -p oriel-web. Initial rendering must not wait for terminal-only assets.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from '../../oriel-relay/node_modules/playwright/index.mjs';

const publicRoot=new URL('../build/public/',import.meta.url);
const assets=new Map(['/index.html','/dashboard.css','/terminal.js','/workflow.js','/codex.js'].map(path=>[
  path,readFileSync(new URL('.'+path,publicRoot)),
]));
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage();
  const external=[];
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='https://fixture.invalid') {
      external.push(url.href);
      return route.abort();
    }
    if(url.pathname==='/api/session')return route.fulfill({contentType:'application/json',body:'{"user":null}'});
    const path=url.pathname==='/'?'/index.html':url.pathname;
    const body=assets.get(path);
    if(!body)return route.abort();
    const contentType=path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':'text/html';
    return route.fulfill({contentType,body});
  });
  await page.goto('https://fixture.invalid/',{waitUntil:'domcontentloaded'});
  await page.locator('#page-title').waitFor({state:'visible'});
  assert.deepEqual(external.filter(url=>url.includes('xterm')),[],'initial rendering requested terminal-only assets');
  console.log('Initial rendering does not request terminal-only assets');
} finally {await browser.close();}
