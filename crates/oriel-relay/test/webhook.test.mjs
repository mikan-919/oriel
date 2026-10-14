import assert from 'node:assert/strict';
import test from 'node:test';
import {createHmac, webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {connect, device, hostHeaders, origin, pair, runtime} from './helpers.mjs';
import {workflowFixture} from './workflow-fixture.mjs';
const source = stripTypeScriptTypes(readFileSync(new URL('../src/webhook.ts', import.meta.url), 'utf8'), {mode:'transform'});
const c = vm.createContext({crypto:webcrypto, URL, Response, TextEncoder, TextDecoder, Uint8Array});
vm.runInContext(source.replace(/^export /gm, '') + '\nglobalThis.verify = workflowChange;', c);
const secret = 'test-only-secret';
function signed(provider, payload, key=secret) {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', key).update(body).digest('hex');
  return new Request(`${origin}/api/webhooks/${provider}`, {method:'POST', body, headers:provider==='github'
    ? {'x-hub-signature-256':`sha256=${signature}`, 'x-github-event':'issue_comment'}
    : {'linear-signature':signature}});
}
const env = {GITHUB_APP_WEBHOOK_SECRET:secret, LINEAR_WEBHOOK_SECRET:secret};
test('Webhook hints require bounded signed bodies and fresh signed Linear timestamps', async () => {
  const github = {repository:{id:501}};
  assert.deepEqual(JSON.parse(JSON.stringify(await c.verify(signed('github',github),env,'github'))), {provider:'github',scope:'501'});
  assert.equal((await c.verify(signed('github',github,'wrong'),env,'github')).status,401);
  assert.equal((await c.verify(signed('github',github),{},'github')).status,503);
  const linear = {type:'Issue', organizationId:'11111111-1111-4111-a111-111111111111', webhookTimestamp:Date.now()};
  assert.equal((await c.verify(signed('linear',linear),env,'linear')).scope,linear.organizationId);
  assert.equal((await c.verify(signed('linear',{...linear,webhookTimestamp:0}),env,'linear')).status,401);
  assert.equal((await c.verify(signed('linear',{...linear,webhookTimestamp:Date.now()+600000}),env,'linear')).status,401);
  assert.equal((await c.verify(signed('github',{padding:'x'.repeat(1048576)}),env,'github')).status,413);
  assert.equal((await c.verify(signed('github',{repository:{id:'501'}}),env,'github')).status,400);
});

test('Signed provider changes wake only subscribed matching workflows, coalesce, and do not grant approval', {timeout:60000}, async () => {
  const fixture = workflowFixture();
  const worker = await runtime({...fixture.env,...env}, request=>fixture.fetch(request));
  let socket;
  try {
    const {owner,daemon}=await pair(worker);
    await connect(owner,fixture,'github'); await connect(owner,fixture,'linear');
    await daemon.api(`/api/integrations/${device}/repository`,{repository:fixture.repository},hostHeaders);
    const upgraded=await worker.dispatchFetch(`${origin}/api/workflows/${device}/connect`,{headers:{...hostHeaders,Upgrade:'websocket'}});
    socket=upgraded.webSocket;socket.accept();
    let sequence=0, changes=0;
    socket.addEventListener('message',event=>{if(JSON.parse(event.data).type==='changed')changes++;});
    const rpc=payload=>new Promise((resolve,reject)=>{
      const request_id=`hook-${++sequence}`;
      const timer=setTimeout(()=>reject(Error('RPC timeout')),10000);
      const listener=event=>{const value=JSON.parse(event.data);if(value.request_id!==request_id)return;clearTimeout(timer);socket.removeEventListener('message',listener);resolve(value);};
      socket.addEventListener('message',listener);socket.send(JSON.stringify({...payload,request_id}));
    });
    const deliver=async(repository=501,key=secret,legacy=false)=>{
      const request=signed('github',{repository:{id:repository}},key);
      return worker.dispatchFetch(legacy ? request.url.replace('/api/webhooks/', '/webhooks/') : request.url,{method:'POST',headers:request.headers,body:await request.text()});
    };
    assert.equal((await deliver()).status,200);
    assert.equal(changes,0,'Old hosts never receive an unknown unsolicited message');
    const snapshot=await rpc({type:'snapshot',changes:true});
    assert.equal(snapshot.poll_after_seconds,900);
    const before=fixture.calls.length;
    assert.equal((await deliver(999)).status,200);
    assert.equal((await deliver(501,'wrong')).status,401);
    await rpc({type:'heartbeat'});
    assert.equal(changes,0);
    await deliver();await deliver();await rpc({type:'heartbeat'});
    assert.equal(changes,1,'Coalesce until the next fresh snapshot');
    assert.equal(fixture.calls.length,before,'A webhook does not perform provider reads or grant work');
    const next=await rpc({type:'snapshot',changes:true});
    assert.equal(next.snapshot.workflows[0].phase,snapshot.snapshot.workflows[0].phase);
    await deliver(501,secret,true);await rpc({type:'heartbeat'});
    assert.equal(changes,2);
    assert.equal((await worker.dispatchFetch(`${origin}/workflow-change`,{method:'POST',body:JSON.stringify({provider:'github',scope:'501'})})).status,404);
  } finally {socket?.close();await worker.dispose();}
});
