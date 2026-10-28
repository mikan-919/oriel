// Generate assets and review fixtures first. No external accounts or connections.
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, writeFileSync, renameSync} from 'node:fs';
import {chromium} from '../../oriel-relay/node_modules/playwright/index.mjs';
import {captureNlAssertImage} from '../../oriel-relay/node_modules/@mizchi/vlmkit/dist/playwright.mjs';

const stage=process.argv[2] || 'after';
assert.ok(['before','after'].includes(stage));
const output=new URL(`./evidence/${stage}/`,import.meta.url);
mkdirSync(output,{recursive:true});
let browser;
const results=[];
const viewports=[320,360,390,768,900,901,1440].map(width=>({width,height:800})).concat({width:844,height:390});
try {
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='https://fixture.invalid' || !/^\/[a-z-]+\.html$/.test(url.pathname))return route.abort();
    return route.fulfill({contentType:'text/html; charset=utf-8',body:readFileSync(new URL('../build/review'+url.pathname,import.meta.url))});
  });
  for(const state of ['signed-out','pairing','normal','empty','loading','failed','reconnecting','codex']) {
    for(const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(`https://fixture.invalid/${state}.html`);
      await page.waitForTimeout(700);
      for(const screen of ['overview','workflow','codex','devices','settings']) {
        await page.evaluate(screen=>showPage(screen,false),screen);
        await page.locator('details').evaluateAll(nodes=>nodes.forEach(node=>node.open=true));
        if(screen==='codex' && state==='codex') {
          await page.evaluate(()=>window.fixtureCodex?.deliver({type:'event',engine:'manual',message:{method:'turn/diff/updated',params:{diff:('+long-diff-line'.repeat(40)+'\n').repeat(5)}}}));
        }
        const measurement=await page.evaluate(()=>({clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('body *')].filter(e=>e.getClientRects().length && e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>e.id||e.tagName)}));
        const row={state,screen,...viewport,...measurement};results.push(row);
        // Keep representative images in git; measurements cover every combination.
        if((viewport.width===320 && ['normal','codex'].includes(state)) || (state==='normal' && screen==='overview') || (state==='normal' && screen==='workflow' && viewport.width===1440)) {
          writeFileSync(new URL(`${state}-${screen}-${viewport.width}x${viewport.height}.png`,output),await captureNlAssertImage({target:page,screenshotOptions:{fullPage:true}}));
        }
      }
    }
  }
  // Exercise real xterm with a mock WebSocket and both width and height changes.
  await page.goto('https://fixture.invalid/normal.html');
  await page.waitForTimeout(300);
  await page.evaluate(()=>showPage('devices',false));
  const opener=page.getByRole('button',{name:'端末を開く',exact:true});
  await opener.click();await page.locator('#terminal-view').waitFor({state:'visible'});
  for(const viewport of viewports) {
    await page.setViewportSize(viewport);await page.waitForTimeout(100);
    const measurement=await page.evaluate(()=>{const r=document.querySelector('.xterm-screen').getBoundingClientRect();const t=document.getElementById('terminal').getBoundingClientRect();return {clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,terminalRight:r.right,terminalBottom:r.bottom,containerBottom:t.bottom,viewportHeight:innerHeight};});
    const close=page.locator('#close-terminal');
    // Switch to keyboard input before testing :focus-visible. Programmatic
    // focus after the mouse click intentionally retains pointer modality.
    await page.keyboard.press('Tab');
    await close.focus();
    const control=await close.evaluate(button=>{
      const r=button.getBoundingClientRect();
      const style=getComputedStyle(button);
      return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,
        focused:document.activeElement===button,outline:style.outlineStyle,
        unobstructed:button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
    });
    if(stage==='after') {
      assert.ok(control.left>=0 && control.top>=0 && control.right<=viewport.width && control.bottom<=viewport.height,'close button within viewport');
      assert.ok(control.unobstructed,'close button can be clicked');
      assert.ok(control.focused && control.outline!=='none','close button has visible keyboard focus');
    }
    results.push({state:'normal',screen:'terminal',...viewport,...measurement,close:control});
    if(viewport.width===320 || viewport.width===844)writeFileSync(new URL(`normal-terminal-${viewport.width}x${viewport.height}.png`,output),await captureNlAssertImage({target:page}));
  }
  await page.locator('#close-terminal').focus();await page.keyboard.press('Enter');
  await page.locator('#dashboard').waitFor({state:'visible'});
  const focus=await page.evaluate(()=>document.activeElement.id || document.activeElement.textContent);
  await page.setViewportSize({width:320,height:800});
  await page.locator('[data-page="workflow"]').focus();
  await page.keyboard.press('Enter');
  await page.locator('#workflow-create').click();
  await page.locator('#what-title').fill('小画面の入力確認');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'what-body');
  await page.keyboard.type('fixture form verification');
  await page.locator('#what-form button[type="submit"]').click();
  await page.locator('#workflow-create-dialog').waitFor({state:'hidden'});
  assert.ok(await page.evaluate(()=>window.fixtureRequests.some(r=>r.method==='POST')));
  // Keep the last complete evidence if a run fails or is interrupted.
  writeFileSync(new URL('results.json.tmp',output),JSON.stringify({browser:browser.version(),results,errors,focus},null,2)+'\n');
  renameSync(new URL('results.json.tmp',output),new URL('results.json',output));
  console.log(JSON.stringify({cases:results.length,overflow:results.filter(r=>r.scrollWidth>r.clientWidth+1),errors,focus},null,2));
  if(stage==='after') {
    assert.deepEqual(errors,[]);
    assert.ok(results.every(r=>r.scrollWidth<=r.clientWidth+1),'page width');
    assert.ok(results.filter(r=>r.screen==='terminal').every(r=>r.terminalRight<=r.clientWidth+1 && r.terminalBottom<=r.viewportHeight+1),'terminal fit');
    assert.equal(focus,'端末を開く');
  }
} finally {await browser?.close();}
