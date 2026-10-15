// Extended content is tested separately from the default-state screenshot matrix.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {chromium} from '../../oriel-relay/node_modules/playwright/index.mjs';
import {captureNlAssertImage} from '../../oriel-relay/node_modules/@mizchi/vlmkit/dist/playwright.mjs';
const browser=await chromium.launch({headless:true});
const measurements=[];
try {
  const page=await browser.newPage();
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='https://fixture.invalid'||!/^\/(normal|codex)\.html$/.test(url.pathname))return route.abort();
    return route.fulfill({contentType:'text/html',body:readFileSync(new URL('../build/review'+url.pathname,import.meta.url))});
  });
  for(const width of [320,360,390,768,900,901,1440,844]) {
    await page.setViewportSize({width,height:width===844?390:800});
    await page.goto('https://fixture.invalid/normal.html');
    await page.locator('[data-page="workflow"]').click();
    await page.locator('[data-work-number="86"]').click();
    await page.locator('[data-work-panel="plan"]').click();
    assert.ok((await page.locator('#workflow-what-body').textContent()).length>1000);
    assert.ok((await page.locator('#workflow-how-body').textContent()).length>1000);
    const measure=async screen=>{
      const row=await page.evaluate(()=>({clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}));
      measurements.push({screen,width,...row});
      assert.ok(row.scrollWidth<=row.clientWidth+1,JSON.stringify(measurements.at(-1)));
      if(width===320)await page.locator(screen==='plan'?'#workflow-how-body':'#codex-output').scrollIntoViewIfNeeded();
      if(width===320)writeFileSync(new URL(`evidence/after/long-${screen}-320.png`,import.meta.url),await captureNlAssertImage({target:page}));
    };
    await measure('plan');
    await page.goto('https://fixture.invalid/codex.html');
    await page.locator('#codex-new').click();
    await page.waitForFunction(()=>document.getElementById('codex-output').textContent.includes('保存済みの回答'));
    await measure('answer');
  }
  writeFileSync(new URL('evidence/after/long-content.json',import.meta.url),JSON.stringify(measurements,null,2)+'\n');
  console.log('Long WHAT/HOW and Codex answer: 16 cases passed');
} finally {await browser.close();}
