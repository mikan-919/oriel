import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../src/assets/dashboard.js', import.meta.url), 'utf8');

test('state notifications reuse provider facts, retain unrelated issues and preserve full reconciliation', async () => {
  let connection, received, devices = 0, reconciliations = 0;
  class Socket {
    static OPEN = 1; readyState = 1; listeners = {};
    constructor() { connection = this; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    send() {} close() {}
  }
  const original = {repository_id:501, workflows:[{issue:{number:42}, how_comments:[{body:'discussion'}]}, {issue:{number:43}, phase:'waiting-how'}]};
  const c = vm.createContext({user:{id:'owner'}, accountEpoch:1, progressSocket:undefined, progressRetry:undefined,
    progressReceivedAt:0, progressRetryDelay:5000, progressSnapshot:new Map(), progressStream:'connecting',
    progressExpiry:undefined, progressKeepalive:undefined, status:{}, repositoryDeviceId:'device', workflowSnapshot:original,
    currentAccount:epoch => c.accountEpoch === epoch && !!c.user, setProgressStream() {}, WebSocket:Socket, URL,
    location:{origin:'https://fixture.invalid',protocol:'https:'}, Date:{now:()=>100000},
    setTimeout:()=>1,clearTimeout() {},setInterval:()=>1,clearInterval() {}, errorText:String,
    scheduleWorkflowRefresh:()=>reconciliations++, refreshDevices:async()=>devices++,
    refreshWorkflow:async result=>{received=result;c.workflowSnapshot=result;}, lastWorkflowPoll:0});
  vm.runInContext(source.slice(source.indexOf('function stopProgress()'), source.indexOf('function updateProgressLink(')), c);
  c.connectProgress(); connection.listeners.open();
  const deliver = frame => connection.listeners.message({data:JSON.stringify(frame)});
  deliver({type:'workflow-snapshot',device_id:'device',issue_number:42,snapshot:{repository_id:501,workflows:[{issue:{number:42},phase:'running',how_comments:[]}]}});
  assert.deepEqual(Array.from(received.workflows,row=>row.issue.number),[42,43]);
  assert.equal(received.workflows[0].how_comments[0].body,'discussion');
  assert.equal(c.lastWorkflowPoll,0,'Scoped checks cannot postpone reconciliation of other issues');
  deliver({type:'workflow-snapshot',device_id:'foreign',snapshot:{workflows:[]}});
  assert.equal(received.workflows.length,2);
  deliver({type:'workflow-snapshot',device_id:'device',snapshot:{repository_id:501,workflows:[]}});
  assert.equal(c.lastWorkflowPoll,100000);
  assert.equal(received.workflows.length,0);
  deliver({type:'device-changed'});
  assert.equal(devices,1);
  deliver({type:'workflow-changed'});
  assert.equal(reconciliations,1);
});

test('runtime pongs keep unchanged progress live; missing pongs or an initial snapshot expire', () => {
  for (const baseline of [true, false]) {
    let now = 0, serial = 0, connection, answer = true;
    const timers = new Map();
    const add = (callback, delay, repeat = false) => {const id = ++serial; timers.set(id, {callback, delay, repeat, due: now + delay}); return id;};
    const advance = milliseconds => {
      const end = now + milliseconds;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        const [id, timer] = next; now = timer.due;
        if (timer.repeat) timer.due += timer.delay; else timers.delete(id);
        timer.callback();
      }
      now = end;
    };
    class Socket {
      static OPEN = 1; readyState = 1; listeners = {}; sent = [];
      constructor() {connection = this;}
      addEventListener(name, callback) {this.listeners[name] = callback;}
      send(raw) {this.sent.push(raw); if (raw === 'oriel:ping' && answer) this.listeners.message({data: 'oriel:pong'});}
      close() {this.readyState = 3; this.listeners.close?.();}
    }
    const c = vm.createContext({user: {id: 'owner'}, accountEpoch: 1, progressSocket: undefined,
      progressRetry: undefined, progressExpiry: undefined, progressKeepalive: undefined,
      progressReceivedAt: 0, progressRetryDelay: 5000, progressSnapshot: new Map(), progressStream: 'connecting',
      currentAccount: epoch => !!c.user && c.accountEpoch === epoch,
      setProgressStream: state => {c.progressStream = state;}, WebSocket: Socket, URL,
      location: {origin: 'https://fixture.invalid', protocol: 'https:'}, Date: {now: () => now},
      setTimeout: (callback, delay) => add(callback, delay), clearTimeout: id => timers.delete(id),
      setInterval: (callback, delay) => add(callback, delay, true), clearInterval: id => timers.delete(id)});
    vm.runInContext(source.slice(source.indexOf('function stopProgress()'), source.indexOf('function updateProgressLink(')), c);
    c.connectProgress(); connection.listeners.open();
    if (baseline) connection.listeners.message({data: JSON.stringify({type: 'workflow-progress', devices: [{device_id: 'device', state: 'idle'}]})});
    advance(baseline ? 90000 : 60000);
    assert.equal(c.progressStream, baseline ? 'live' : 'stale');
    if (baseline) {
      assert.equal(c.progressSocket, connection, 'Unchanged state does not force a reconnect');
      assert.equal(c.progressSnapshot.get('device').state, 'idle');
      assert.equal(connection.sent.filter(raw => raw === 'oriel:ping').length, 6);
      answer = false; advance(60000);
      assert.equal(c.progressStream, 'stale');
      assert.equal(connection.readyState, 3);
    }
  }
});

test('background polling stops for hidden tabs and resumes device discovery when visible', async () => {
  let deviceRequests = 0;
  let workflowRequests = 0;
  let periodic;
  let visibility;
  let timer;
  const c = vm.createContext({user: {id: 'owner'}, accountEpoch: 1, deviceTimer: null,
    progressStream: 'connecting', progressReceivedAt: 0, busy: false, workflowRefreshing: false,
    repositoryDeviceId: 'device', dashboard: {hidden: false}, status: {},
    document: {hidden: false, addEventListener(type, callback) {if (type === 'visibilitychange') visibility = callback;}},
    currentAccount: epoch => !!c.user && epoch === c.accountEpoch,
    refreshDevices: async () => {deviceRequests++;}, refreshWorkflow: async () => {workflowRequests++;},
    setInterval(callback, delay) {assert.equal(delay, 60000); periodic = callback;},
    setTimeout(callback, delay) {assert.ok([1000, 900000].includes(delay)); timer = callback; return 1;}, clearTimeout() {},
    staleProgress() {throw new Error('Unexpected progress expiry');}, errorText: String});
  vm.runInContext(source.slice(source.indexOf('document.addEventListener("visibilitychange"'),
    source.indexOf('\nrender();\nperform(async () =>')), c);
  c.scheduleDevices();
  await timer();
  await periodic();
  assert.equal(deviceRequests, 1);
  assert.equal(workflowRequests, 1);
  vm.runInContext('workflowPollInterval = 900000', c);
  await periodic();
  assert.equal(workflowRequests, 1, 'Live event mode avoids repeated full discovery');
  c.scheduleWorkflowRefresh();
  c.busy = true;
  await timer();
  assert.equal(workflowRequests, 1);
  c.busy = false;
  await periodic();
  assert.equal(workflowRequests, 2, 'A change received while busy remains pending');
  c.scheduleDevices();
  c.document.hidden = true;
  await timer();
  await periodic();
  assert.equal(deviceRequests, 1);
  assert.equal(workflowRequests, 2);
  c.document.hidden = false;
  visibility();
  assert.equal(deviceRequests, 2, 'Returning to the tab refreshes devices immediately');
  c.accountEpoch++;
  await timer();
  assert.equal(deviceRequests, 2, 'An old account timer cannot refresh a new account');
});
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
  const c=vm.createContext({connectionRequest,busy:false,sessionLoading:false,devices:[],user:null,repositoryDeviceId:null,deviceListFailed:false,
    workflowSnapshot:null,progressSnapshot:new Map(),progressStream:'connecting',progressStages:{implementing:'実装'},
    dashboard:{querySelectorAll(selector) {return selector==='[data-region]' ? regions : buttons;}},
    document:{getElementById(id) {if(!elements.has(id)) elements.set(id,element()); return elements.get(id);}}});
  vm.runInContext(source.slice(source.indexOf('let currentPage =')),c);
  return {c,regions,buttons,elements};
}
test('workflow is initial page; switching preserves authentication-controlled hidden state',()=>{
  const {c,regions,buttons,elements}=screen();
  assert.equal(regions[1].classList.values.has('page-hidden'),false);
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
  const workflow=source.slice(source.indexOf('async function refreshWorkflow(pushed)'),source.indexOf('async function createWhat()'));
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
  const c=vm.createContext({socket:{close(){closed=true;}},terminalOpener:undefined,terminalView:{hidden:false},dashboard:{hidden:true},
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

test('terminal focus returns to its visible enabled opener, with a heading fallback',()=>{
  const disconnect=source.slice(source.indexOf('function disconnect()'),source.indexOf('function setUser('));
  for (const available of [true,false]) {
    const opener={...element(),isConnected:available,disabled:false,getClientRects:()=>[{}]};
    const heading=element();
    const c=vm.createContext({socket:undefined,terminalOpener:opener,terminalView:{hidden:false},dashboard:{hidden:true},
      document:{getElementById(){return heading;}}});
    vm.runInContext(disconnect,c);
    c.disconnect();
    assert.equal(opener.focused,available);
    assert.equal(heading.focused,!available);
    assert.equal(c.terminalOpener,undefined);
  }
});

test('initial session loading does not claim the user is signed out',()=>{
  const {c,elements}=screen();
  c.sessionLoading=true;
  c.renderOverview();
  assert.match(elements.get('overview-target').textContent,/確認中/);
  assert.match(elements.get('overview-next').textContent,/お待ちください/);
  assert.equal(elements.get('overview-action').textContent,'確認中…');
  assert.equal(elements.get('overview-action').disabled,true);
  c.sessionLoading=false;
  c.renderOverview();
  assert.match(elements.get('overview-next').textContent,/ログインしてください/);
  assert.equal(elements.get('overview-action').disabled,false);
  c.busy=true;
  c.renderOverview();
  assert.equal(elements.get('overview-action').disabled,true);
});

function httpScreen(fetch) {
  const timers = new Map();
  let serial = 0;
  const c = vm.createContext({fetch, AbortController, accountEpoch:0, busy:false,
    status:{textContent:''}, render() {}, setUser() {c.accountEpoch++;},
    setTimeout(callback, delay) {assert.equal(delay,30000); timers.set(++serial,callback); return serial;},
    clearTimeout(id) {timers.delete(id);}});
  vm.runInContext(source.slice(source.indexOf('async function api('), source.indexOf('function decodeBase64url(')), c);
  return {c, timers, expire() {for (const callback of [...timers.values()]) callback();}};
}

test('HTTP deadline includes body, ignores late results and releases perform', async () => {
  for (const body of [false,true]) {
    for (const fail of [false,true]) {
      let resolve, reject, signal;
      const stalled = new Promise((a,b)=>{resolve=a;reject=b;});
      const h = httpScreen((_path,options)=>{
        signal=options.signal;
        return body ? Promise.resolve({ok:true,json:()=>stalled}) : stalled;
      });
      const task = h.c.perform(()=>h.c.api('/api/test',{}));
      await Promise.resolve();
      h.expire();
      await task;
      assert.equal(h.c.busy,false);
      assert.match(h.c.status.textContent,/変更結果は不明/);
      assert.equal(signal.aborted,true);
      assert.equal(h.timers.size,0);
      if (fail) reject(Error('late')); else resolve(body ? {} : {ok:true,json:async()=>({})});
      await new Promise(done=>setImmediate(done));
      assert.match(h.c.status.textContent,/変更結果は不明/);
    }
  }
});

test('HTTP success and parse failures clear timers; old account success, 401 and timeout are isolated', async () => {
  for (const ok of [true,false]) {
    const h=httpScreen(async()=>({ok:true,json:async()=>{if (!ok) throw Error('json'); return {ok};}}));
    await h.c.api('/api/test');
    assert.equal(h.timers.size,0);
  }
  for (const outcome of ['success','401','timeout']) {
    let resolve;
    const h=httpScreen(()=>new Promise(done=>resolve=done));
    const task=h.c.perform(()=>h.c.api('/api/test'));
    h.c.accountEpoch++;
    h.c.status.textContent='new account';
    if(outcome==='timeout') h.expire();
    else resolve({ok:outcome==='success',status:401,json:async()=>({})});
    await task;
    assert.equal(h.c.status.textContent,'new account');
    assert.equal(h.c.accountEpoch,1);
  }
});

test('WHAT retry preserves original request and contents until confirmed', async () => {
  let fail=true; const calls=[];
  const c=vm.createContext({user:{id:'owner'},accountEpoch:1,repositoryDeviceId:'a',workflowSnapshot:{},
    pendingWhat:null,whatTitle:{value:'original'},whatBody:{value:'body'},crypto:{randomUUID:()=> 'same-id'},
    currentAccount:epoch=>epoch===c.accountEpoch, status:{}, refreshWorkflow:async()=>{},
    document:{getElementById:()=>({close(){}})},
    integrationApi:async(path,body)=>{calls.push({path,...body}); if(fail) throw Error('timeout'); return {issue:{number:1}};}});
  vm.runInContext(source.slice(source.indexOf('async function createWhat()'),source.indexOf('function sendResize()')),c);
  await assert.rejects(c.createWhat());
  c.repositoryDeviceId='b'; c.whatTitle.value='changed'; c.whatBody.value='changed';
  await assert.rejects(c.createWhat());
  assert.deepEqual(calls[0],calls[1]);
  assert.equal(c.whatTitle.disabled,true);
  fail=false; await c.createWhat();
  assert.deepEqual(calls[0],calls[2]);
  assert.equal(c.pendingWhat,null);
  assert.equal(c.whatTitle.value,'');
  assert.equal(c.whatTitle.disabled,false);
});

test('a superseded operation cannot replace the current notification or release its busy state', async () => {
  const h = httpScreen(async () => ({}));
  let rejectOld, finishNew;
  const oldTask = h.c.perform(() => new Promise((_, reject) => { rejectOld = reject; }));
  // Account changes invalidate the active operation and allow a new one.
  h.c.accountEpoch++;
  h.c.perform.operation = null;
  h.c.busy = false;
  const newTask = h.c.perform(() => new Promise(resolve => { finishNew = resolve; }));
  h.c.status.textContent = 'current operation';
  rejectOld(Object.assign(Error('expired old session'), {sessionExpired:true}));
  await oldTask;
  assert.equal(h.c.status.textContent, 'current operation');
  assert.equal(h.c.busy, true);
  finishNew();
  await newTask;
  assert.equal(h.c.busy, false);
});

test('old account reconciliation cannot start workflow reads for the new account', async () => {
  let finishDevices;
  let workflows = 0;
  const c = vm.createContext({accountEpoch:1,
    currentAccount:epoch => epoch === c.accountEpoch,
    refreshIntegrations:async () => {},
    refreshDevices:() => new Promise(resolve => { finishDevices = resolve; }),
    inspectPair:async () => {}, refreshWorkflow:async () => { workflows++; }});
  vm.runInContext(source.slice(source.indexOf('async function refreshAccountData()'),
    source.indexOf('async function refreshIntegrations()')), c);
  const task = c.refreshAccountData();
  c.accountEpoch++;
  finishDevices();
  await task;
  assert.equal(workflows, 0);
});

test('current session expiration keeps the login guidance after account reset', async () => {
  const h = httpScreen(async () => ({ok:false,status:401,json:async()=>({})}));
  h.c.setUser = () => {
    h.c.accountEpoch++;
    h.c.perform.operation = null;
    h.c.busy = false;
  };
  await h.c.perform(() => h.c.api('/api/test'));
  assert.match(h.c.status.textContent, /再度ログイン/);
  assert.equal(h.c.busy, false);
  assert.equal(h.timers.size, 0);
});
