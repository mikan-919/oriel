import assert from "node:assert/strict";
import test from "node:test";
import {client, device, hostHeaders, pair, runtime} from "./helpers.mjs";

test("unconfirmed pairing storage is bounded while expired hosts can retry and existing devices still work", async () => {
  const worker = await runtime();
  try {
    const {daemon} = await pair(worker);
    const storage = await worker.unsafeGetDurableObjectStorage("oriel-relay", "AccountRegistry", {name: "accounts"});
    const anonymous = client(worker);
    const id = "1".repeat(32);
    assert.equal((await anonymous.api('/api/pair/start', {device_id:id,name:'original'}, hostHeaders)).status,200);
    // Fill expired reservations as persisted by older deployments, without
    // spending time on 1023 equivalent HTTP starts.
    await storage.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1023) INSERT INTO pairings (device_id,name,host_hash,token_hash,expires_at,candidate_id) SELECT printf('%032x',x),'expired','original-host',printf('%064x',x),1,NULL FROM n");
    for(let i=1024;i<1050;i++) assert.equal((await anonymous.api('/api/pair/start',{device_id:i.toString(16).padStart(32,'0'),name:'new'},hostHeaders)).status,429);
    assert.equal((await storage.exec('SELECT COUNT(*) AS total FROM pairings'))[0].total,1024);
    await storage.exec('UPDATE pairings SET expires_at=1 WHERE device_id=?',id);
    assert.equal((await anonymous.api('/api/pair/start',{device_id:id,name:'stolen'},{Authorization:`Bearer ${'c'.repeat(64)}`})).status,403);
    assert.equal((await anonymous.api('/api/pair/start',{device_id:id,name:'retry'},hostHeaders)).status,200);
    assert.equal((await daemon.api('/api/pair/start',{device_id:device,name:'paired'},hostHeaders)).data.status,'paired');
    assert.equal((await anonymous.api(`/api/pair/${id}/cancel`,{},hostHeaders)).status,200);
    assert.equal((await anonymous.api('/api/pair/start',{device_id:'f'.repeat(32),name:'new'},hostHeaders)).status,200);
  } finally {await worker.dispose();}
});
