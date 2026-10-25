import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {authenticator,client,connect,device,hostHeaders,origin,pair,runtime} from './helpers.mjs';
import {workflowFixture} from './workflow-fixture.mjs';

test('history storage failure cannot prevent control revocation',()=>{
  const source=stripTypeScriptTypes(readFileSync(new URL('../src/workflow-lease.ts',import.meta.url),'utf8'),{mode:'transform'});
  const context=vm.createContext({});
  vm.runInContext(source.replace(/^import[\s\S]*?;/gm,'').replace(/^export /gm,'')+'\nglobalThis.Leases=WorkflowLeases;',context);
  const controls=Object.create(context.Leases.prototype);
  controls.history={record(){throw Error('unavailable');}};
  let saved,closed=false;
  const socket={deserializeAttachment:()=>({protocol:'oriel/workflow/v2',binding:{},grant:{lease_id:'run',issue_number:42}}),serializeAttachment:a=>{saved=a;},close(){closed=true;}};
  controls.stop(socket);assert.equal(saved,null);assert.equal(closed,true);
});

test('execution history persists without a browser, deduplicates progress and remains owner/repository/work scoped after restart',async()=>{
  const fixture=workflowFixture(),worker=await runtime(fixture.env,r=>fixture.fetch(r));
  try {
    const {owner,daemon}=await pair(worker);
    await connect(owner,fixture,'github');await connect(owner,fixture,'linear');
    await daemon.api(`/api/integrations/${device}/repository`,{repository:fixture.repository},hostHeaders);
    fixture.addHow();
    const open=async()=>{
      const upgraded=await worker.dispatchFetch(`${origin}/api/workflows/${device}/connect`,{headers:{...hostHeaders,Upgrade:'websocket'}});
      assert.equal(upgraded.status,101);const socket=upgraded.webSocket;socket.accept();let serial=0;
      return {socket,message:body=>new Promise((resolve,reject)=>{
        const request_id=`history-${++serial}`,timer=setTimeout(()=>reject(Error('history RPC timeout')),5000);
        const handler=event=>{const response=JSON.parse(event.data);if(response.request_id!==request_id)return;clearTimeout(timer);socket.removeEventListener('message',handler);resolve(response);};
        socket.addEventListener('message',handler);socket.send(JSON.stringify({...body,request_id}));
      })};
    };
    const claim=async connection=>{
      const row=(await daemon.api(`/api/workflows/${device}`,undefined,hostHeaders)).data.workflows[0];
      const result=await connection.message({type:'claim',kind:'implement',issue_number:42,version:row.version,branch:row.branch});
      assert.equal(result.type,'granted',JSON.stringify(result));return result.lease_id;
    };
    const history=(client=owner,issue=42,repository=501)=>client.api(`/api/workflows/${device}/history?repository_id=${repository}&issue_number=${issue}`);
    let connection=await open(),lease=await claim(connection);
    assert.equal((await daemon.api(`/api/workflows/${device}/actions`,{lease_id:lease,action:'begin'},hostHeaders)).status,200);
    const progress=stage=>connection.message({type:'progress',stage,lease_id:lease});
    await progress('implementing');
    const report={type:'progress',stage:'verifying',lease_id:lease,verification:{head_oid:'2'.repeat(40),target_oid:fixture.target_oid,status:'success',completed:1,total:1}};
    assert.equal((await connection.message(report)).type,'progressed');
    const count=(await history()).data.events.length;
    await connection.message(report);await connection.message({type:'heartbeat'});
    assert.equal((await history()).data.events.length,count);
    await connection.message({type:'progress',stage:'paused',lease_id:lease,outcome:{status:'stopped',reason:'web-paused'}});
    await connection.message({type:'release',lease_id:lease});
    connection.socket.close();
    connection=await open();lease=await claim(connection);
    await progress('implementing');connection.socket.close();
    await new Promise(resolve=>setTimeout(resolve,50));
    await worker.unsafeEvictDurableObject('oriel-relay','AccountRegistry',{name:'accounts'});
    const result=await history();assert.equal(result.status,200,JSON.stringify(result.data));
    const events=result.data.events;
    assert.equal(new Set(events.map(e=>e.execution_id)).size,2);
    assert.equal(events.filter(e=>e.kind==='started').length,2);
    assert.equal(events.filter(e=>e.kind==='started'&&e.resumed).length,1);
    assert.equal(events.find(e=>e.kind==='ended').outcome.reason,'web-paused');
    assert.equal(events.find(e=>e.verification).verification.head_oid,'2'.repeat(40));
    assert.ok(events.some(e=>e.kind==='disconnected'));
    assert.equal(events.some(e=>e.outcome?.status==='completed'),false,'Socket closure never proves completion');
    assert.doesNotMatch(JSON.stringify(events),/access_token|host_hash|WHAT:|commands|argv/);
    assert.deepEqual((await history(owner,43)).data.events,[]);
    assert.deepEqual((await history(owner,42,999)).data.events,[]);
    assert.equal((await history(client(worker))).status,401);
    const stranger=client(worker);await stranger.enroll(authenticator());
    assert.equal((await history(stranger)).status,403);
    const storage=await worker.unsafeGetDurableObjectStorage('oriel-relay','AccountRegistry',{name:'accounts'});
    const user=(await owner.api('/api/session')).data.user.id;
    await storage.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5001) INSERT INTO workflow_history (user_id,repository_id,device_id,issue_number,execution_id,recorded_at,payload) SELECT ?,501,?,42,'limit',?,'{\"kind\":\"progress\",\"stage\":\"planning\"}' FROM n",user,device,new Date().toISOString());
    assert.equal((await history()).data.events.length,200);assert.equal((await history()).data.truncated,true);
    connection=await open();lease=await claim(connection);await progress('implementing');
    assert.equal((await storage.exec('SELECT COUNT(*) AS count FROM workflow_history WHERE user_id=?',user))[0].count,5000);
    connection.socket.close();
  } finally {await worker.dispose();}
});
