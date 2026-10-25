import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function screen(permission='default',supported=true) {
  const toggle={addEventListener(_,fn){this.click=fn;}},status={},notifications=[],opened=[];
  let requests=0;
  class Notice {
    static permission=permission;
    static async requestPermission(){requests++;return this.permission;}
    constructor(title,options){Object.assign(this,{title,options});notifications.push(this);}
    close(){this.closed=true;this.onclose?.();}
  }
  const c=vm.createContext({document:{getElementById:id=>id.endsWith('toggle')?toggle:status},
    localStorage:{getItem:()=>null,setItem(){}},window:{focus(){}},...(supported?{Notification:Notice}:{})});
  const source=readFileSync(new URL('../src/assets/workflow.js',import.meta.url),'utf8');
  vm.runInContext(source.slice(source.indexOf('export function mountWorkflowNotifications')).replace('export ',''),c);
  return {panel:c.mountWorkflowNotifications(number=>opened.push(number)),toggle,status,notifications,opened,Notice,get requests(){return requests;}};
}
const model=()=>({userId:'owner',device:{device_id:'device'},snapshot:{repository_id:1,repository:{owner:'demo',name:'repo'},workflows:[{issue:{number:42,title:'Task',body:'secret'},phase:'running'}]},live:true});
test('notifications require a user gesture and a new state, isolate scopes and open their work',async()=>{
  const s=screen('granted'),m=model();s.panel.update(m);assert.equal(s.requests,0);
  await s.toggle.click();assert.equal(s.requests,1);
  for(const phase of ['triage','review','blocked']) {
    m.snapshot.workflows[0].phase=phase;s.panel.update(m);s.panel.update(m);
    assert.equal(s.notifications.length,['triage','review','blocked'].indexOf(phase)+1);
    assert.doesNotMatch(JSON.stringify(s.notifications.at(-1).options),/secret/);
  }
  const notice=s.notifications.at(-1);notice.onclick();assert.deepEqual(s.opened,[42]);
  m.live=false;s.panel.update(m);m.live=true;s.panel.update(m);assert.equal(s.notifications.length,3);
  m.snapshot.repository_id=2;s.panel.update(m);assert.equal(s.notifications.length,3);
  assert.ok(s.notifications.every(n=>n.closed));notice.onclick();assert.deepEqual(s.opened,[42]);
  await s.toggle.click();m.snapshot.workflows[0].phase='triage';s.panel.update(m);assert.equal(s.notifications.length,3);
  m.userId=null;s.panel.update(m);assert.equal(s.toggle.disabled,true);
});
test('denied, unavailable and failed notifications do not interrupt workflow updates',async()=>{
  for(const supported of [true,false]) {
    const s=screen('denied',supported),m=model();s.panel.update(m);
    if(supported)await s.toggle.click();else assert.equal(s.toggle.disabled,true);
    m.snapshot.workflows[0].phase='triage';s.panel.update(m);assert.equal(s.notifications.length,0);
  }
});
test('a paused execution is not notified again merely because its progress reconnects',async()=>{
  const s=screen('granted'),m=model();s.panel.update(m);await s.toggle.click();
  m.progress={state:'paused',task:{issue_number:42}};s.panel.update(m);assert.equal(s.notifications.length,1);
  m.live=false;s.panel.update(m);m.live=true;s.panel.update(m);assert.equal(s.notifications.length,1);
});
