// Run after npm run build. Exercises production markup and workflow rendering offline.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from '../../oriel-relay/node_modules/playwright/index.mjs';
const html=readFileSync(new URL('../build/public/index.html',import.meta.url),'utf8')
  .replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,'');
const source=readFileSync(new URL('../src/assets/workflow.js',import.meta.url),'utf8').replace(/^export /gm,'');
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage();
  await page.route('**/*',route=>route.abort());
  await page.setContent(html);
  await page.addStyleTag({content:readFileSync(new URL('../src/assets/dashboard.css',import.meta.url),'utf8')});
  await page.evaluate(()=>{
    let element=document.getElementById('repository-work');
    while(element){element.hidden=false;element=element.parentElement;}
  });
  await page.addScriptTag({content:source+`
    window.panel=mountWorkflow({onDevice(){},onCodex(){},onCreate(){}});
    const head='a'.repeat(40), target='b'.repeat(40);
    const commands=[['cargo','test'],['cargo','clippy']];
    window.report={issue_number:137,execution_id:'run-1',configuration_id:'config-1',
      commands,head_oid:target,target_oid:target,status:'running',completed:1,total:2,
      device_id:'device',repository:'demo/repo',generation:'g1',updated_at:new Date().toISOString()};
    window.model={userId:'owner',device:{device_id:'device'},devices:[],live:true,
      snapshot:{repository:{owner:'demo',name:'repo'},target_oid:target,configuration:{verification:commands},
        workflows:[{issue:{number:137,title:'検証表示',url:'https://github.com/demo/repo/issues/137'},
          phase:'review',pull_request:{head_oid:head,url:'https://github.com/demo/repo/pull/136'},
          ci:{head_oid:head,status:'unknown',checks:[],acquisition:'received'}}]},
      progress:{execution_id:'run-1',generation:'g1',state:'running',stage:'verifying',task:{issue_number:137},verification:report}};
    window.update=()=>panel.update(model);
    update();
  `});
  assert.equal(await page.locator('#workflow-ci-badge').isVisible(),true);
  const text=id=>page.locator('#workflow-'+id).textContent();
  assert.match(await text('steps'),/● レビュー/);
  assert.doesNotMatch(await text('steps'),/✓/);
  assert.equal(await text('ci-badge'),'CI結果なし');
  assert.match(await text('local-checks'),/1 \/ 2 件完了/);
  assert.match(await text('local-note'),/push前/);
  await page.evaluate(()=>{model.live=false;model.progress=null;update();});
  assert.equal(await text('local-badge'),'進捗未確認');
  assert.match(await text('local-note'),/現在は未確認/);
  assert.equal(await text('badge'),'レビュー待ち');
  await page.evaluate(()=>{model.live=true;report.status='success';report.completed=2;model.progress={execution_id:'run-1',generation:'g1',task:{issue_number:137},verification:report};update();});
  assert.equal(await text('local-badge'),'✓ 成功');
  await page.evaluate(()=>{model.progress={execution_id:'run-2',generation:'g1',task:{issue_number:138}};update();});
  assert.equal(await text('local-badge'),'✓ 成功');
  assert.match(await text('local-note'),/保存した実行/);
  await page.evaluate(()=>{model.snapshot.configuration.verification=[['npm','test']];update();});
  assert.match(await text('local-note'),/設定が異なります/);
  assert.match(await text('local-checks'),/cargo test/);
  await page.evaluate(()=>{model.userId='other';update();});
  assert.equal(await text('local-badge'),'未取得');
  assert.match(await text('local-checks'),/過去結果の取得経路なし/);
  await page.evaluate(()=>{model.userId='owner';model.progress={generation:'g2'};update();});
  assert.equal(await text('local-badge'),'未取得');
  for(const status of ['pending','failure','success']) {
    await page.evaluate(status=>{model.snapshot.workflows[0].ci={head_oid:'a'.repeat(40),status,checks:[{name:'CI',status}]};update();},status);
    assert.equal(await text('badge'),'レビュー待ち');
    assert.match(await text('steps'),/● レビュー/);
  }

  await page.evaluate(()=>{
    model.snapshot.configuration.verification=report.commands;
    report.status='failure';report.completed=1;
    model.progress={execution_id:'run-1',generation:'g2',task:{issue_number:137},verification:{...report,generation:'g2'}};
    update();
  });
  assert.equal(await text('local-badge'),'× 失敗');
  await page.evaluate(()=>{model.live=false;model.progress=null;update();});
  assert.equal(await text('local-badge'),'× 失敗');
  await page.evaluate(()=>{model.live=true;model.progress={generation:'g2',task:{issue_number:138}};update();});
  assert.equal(await text('local-badge'),'× 失敗');
  await page.evaluate(()=>{model.snapshot.repository={owner:'other',name:'repo'};update();});
  assert.equal(await text('local-badge'),'未取得');
  await page.evaluate(()=>{model.snapshot.repository={owner:'demo',name:'repo'};model.device={device_id:'other-device'};update();});
  assert.equal(await text('local-badge'),'未取得');
  await page.evaluate(()=>{model.device={device_id:'device'};model.progress=null;
    panel=mountWorkflow({onDevice(){},onCodex(){},onCreate(){}});update();});
  assert.match(await text('local-checks'),/過去結果の取得経路なし/);
  await page.setViewportSize({width:320,height:800});
  assert.equal(await page.locator('#workflow-ci-badge').isVisible(),true);
  console.log('Workflow browser assertions passed');
} finally {await browser.close();}
