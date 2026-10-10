import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../src/assets/dashboard.js', import.meta.url), 'utf8');
function element(dataset = {}) {
  return {dataset, textContent: '', attributes: {}, hidden: false, focused: false,
    classList: {values: new Set(), toggle(key, value) {value ? this.values.add(key) : this.values.delete(key);}},
    setAttribute(key,value) {this.attributes[key]=value;}, removeAttribute(key) {delete this.attributes[key];},
    focus() {this.focused=true;}, addEventListener() {}};
}
function screen(connectionRequest = {}) {
  const pages=['overview','workflow','devices','settings'];
  const regions=pages.map(region=>element({region}));
  const buttons=pages.map(page=>element({page}));
  const elements=new Map();
  const c=vm.createContext({connectionRequest,sessionLoading:false,devices:[],user:null,repositoryDeviceId:null,deviceListFailed:false,
    workflowSnapshot:null,progressSnapshot:new Map(),progressStream:'connecting',progressStages:{implementing:'実装'},
    dashboard:{querySelectorAll(selector) {return selector==='[data-region]' ? regions : buttons;}},
    document:{getElementById(id) {if(!elements.has(id)) elements.set(id,element()); return elements.get(id);}}});
  vm.runInContext(source.slice(source.indexOf('let currentPage =')),c);
  return {c,regions,buttons,elements};
}
test('overview is initial page; switching preserves authentication-controlled hidden state',()=>{
  const {c,regions,buttons,elements}=screen();
  assert.equal(regions[0].classList.values.has('page-hidden'),false);
  regions[3].hidden=true;
  c.showPage('settings');
  assert.equal(regions[3].hidden,true);
  assert.equal(regions[0].classList.values.has('page-hidden'),true);
  assert.equal(buttons[3].attributes['aria-current'],'page');
  assert.equal(buttons[0].attributes['aria-current'],undefined);
  assert.equal(elements.get('page-title').focused,true);
  c.showPage('invalid');
  assert.equal(elements.get('page-title').textContent,'設定');
});
test('authorization returns show settings so completion and failure guidance is visible',()=>{
  for (const connectionRequest of [{returned:'github'}, {failed:true}]) {
    const {regions,buttons,elements}=screen(connectionRequest);
    assert.equal(regions[3].classList.values.has('page-hidden'),false);
    assert.equal(buttons[3].attributes['aria-current'],'page');
    assert.equal(elements.get('page-title').textContent,'設定');
    assert.equal(elements.get('page-title').focused,false);
  }
});
test('overview separates online terminal from unconfirmed runner and clears old selection',()=>{
  const {c,elements}=screen();
  c.user={id:'owner'}; c.repositoryDeviceId='a';
  c.devices=[{device_id:'a',name:'fixture',terminal_status:'online',repository:{owner:'demo',name:'repo'}}];
  c.progressSnapshot.set('a',{state:'running',stage:'implementing'});
  c.renderOverview();
  assert.match(elements.get('overview-target').textContent,/使用可能/);
  assert.match(elements.get('overview-progress').textContent,/未確認/);
  c.progressStream='live';c.renderOverview();
  assert.match(elements.get('overview-progress').textContent,/実行中.*実装/);
  c.progressSnapshot.set('a',{state:'paused'});
  c.renderOverview();
  assert.match(elements.get('overview-progress').textContent,/一時停止/);
  c.progressSnapshot.set('a',{state:'unexpected'});
  c.renderOverview();
  assert.match(elements.get('overview-progress').textContent,/状態未取得/);
  c.deviceListFailed=true;c.renderOverview();
  assert.match(elements.get('overview-target').textContent,/状態確認失敗/);
  c.devices=[];c.repositoryDeviceId=null;c.user=null;c.renderOverview();
  assert.doesNotMatch(elements.get('overview-target').textContent,/fixture|demo/);
  assert.match(elements.get('overview-next').textContent,/ログイン/);
});
test('late workflow responses from a previous target or account cannot overwrite current data',async()=>{
  const workflow=source.slice(source.indexOf('async function refreshWorkflow()'),source.indexOf('async function createWhat()'));
  for(const switchAccount of [false,true]) {
    let resolve;
    const c=vm.createContext({user:{id:'owner'},devices:[{device_id:'a',name:'fixture'}],repositoryDeviceId:'a',
      accountEpoch:1,repositoryRequest:0,repositoryDetails:{},repositoryStatus:{},workflowSnapshot:null,
      integrationApi:()=>new Promise(done=>{resolve=done;}),currentAccount:epoch=>epoch===c.accountEpoch,
      render(){}});
    vm.runInContext(workflow,c);
    const pending=c.refreshWorkflow();
    if(switchAccount)c.accountEpoch++; else c.repositoryDeviceId='b';
    resolve({repository:{owner:'old',name:'old'}});
    await pending;
    assert.equal(c.workflowSnapshot,null);
  }
});

test('failed device discovery directs users to recovery rather than pairing',()=>{
  const {c,elements}=screen();
  c.user={id:'owner'};
  c.deviceListFailed=true;
  c.renderOverview();
  assert.match(elements.get('overview-next').textContent,/取得できません.*更新/);
  assert.equal(elements.get('overview-action').textContent,'設定へ');
  c.deviceListFailed=false;
  c.renderOverview();
  assert.match(elements.get('overview-next').textContent,/ペアリング/);
});

test('closing a visible terminal restores keyboard focus to the dashboard',()=>{
  const disconnect=source.slice(source.indexOf('function disconnect()'),source.indexOf('function setUser('));
  const heading=element();
  let closed=false;
  const c=vm.createContext({socket:{close(){closed=true;}},terminalView:{hidden:false},dashboard:{hidden:true},
    document:{getElementById(){return heading;}}});
  vm.runInContext(disconnect,c);
  c.disconnect();
  assert.equal(closed,true);
  assert.equal(c.terminalView.hidden,true);
  assert.equal(c.dashboard.hidden,false);
  assert.equal(heading.focused,true);
  heading.focused=false;
  c.disconnect();
  assert.equal(heading.focused,false);
});

test('initial session loading does not claim the user is signed out',()=>{
  const {c,elements}=screen();
  c.sessionLoading=true;
  c.renderOverview();
  assert.match(elements.get('overview-target').textContent,/確認中/);
  assert.match(elements.get('overview-next').textContent,/お待ちください/);
  assert.equal(elements.get('overview-action').textContent,'確認中…');
  c.sessionLoading=false;
  c.renderOverview();
  assert.match(elements.get('overview-next').textContent,/ログインしてください/);
});
