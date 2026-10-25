import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowState,currentCI,currentVerification,verificationEvidence} from '../src/assets/workflow.js';
const head='a'.repeat(40), target='b'.repeat(40);
const row={issue:{number:86},phase:'review',pull_request:{head_oid:head},ci:{head_oid:head,status:'success',checks:[]}};
test('CI success requires evidence for the current PR head',()=>{
  assert.equal(currentCI(row).status,'success');
  assert.equal(currentCI({...row,pull_request:{head_oid:target}}).status,'unknown');
  assert.equal(currentCI({...row,ci:undefined}).status,'unknown');
});
const commands=[['cargo','test'],['cargo','clippy']];
const proof={issue_number:86,head_oid:head,target_oid:target,status:'success',completed:2,total:2,
  execution_id:'run-1',configuration_id:'config-1',commands,updated_at:'2026-10-18T00:00:00Z'};
const snapshot={target_oid:target,configuration:{verification:commands}};
test('received terminal evidence survives disconnection and describes mismatches',()=>{
  for(const live of [true,false])assert.equal(currentVerification(row,snapshot,{verification:proof,execution_id:'run-1'},live),proof);
  for(const [patch,reason] of [[{head_oid:target},/異なるコミット/],[{target_oid:head},/基準/],[{commands:[['npm','test'],['npm','run','check']]},/設定/]])
    assert.match(verificationEvidence(row,snapshot,{verification:{...proof,...patch}},true).reason,reason);
  assert.equal(currentVerification({...row,issue:{number:87}},snapshot,{verification:proof},true),null);
  for(const patch of [{completed:1},{total:1},{execution_id:undefined}])
    assert.equal(currentVerification(row,snapshot,{verification:{...proof,...patch}},true),null);
});
test('running push-before-PR evidence stays progress, never current PR success',()=>{
  const observation=verificationEvidence(row,snapshot,{verification:{...proof,status:'running',head_oid:target,completed:1}},false);
  assert.equal(observation.value.completed,1);
  assert.equal(observation.current,false);
  assert.match(observation.reason,/push前/);
  assert.match(observation.reason,/現在は未確認/);
  assert.match(verificationEvidence(row,snapshot,{},true).reason,/未受信.*実行履歴/);
});
test('CI empty acquisition and unavailability remain independent of local success',()=>{
  const empty={...row,ci:{head_oid:head,status:'unknown',checks:[],acquisition:'received'}};
  assert.equal(currentCI(empty).acquisition,'received');
  assert.equal(currentCI({...row,ci:undefined}).acquisition,'unavailable');
  assert.equal(currentVerification(empty,snapshot,{verification:proof},false).status,'success');
});
test('execution notifications cannot replace revoked approval or fresh blocked facts',()=>{
  const progress={state:'running',stage:'implementing',task:{issue_number:86}};
  assert.equal(workflowState({...row,phase:'triage'},progress,true).group,'waiting');
  assert.equal(workflowState({...row,phase:'blocked'},progress,true).group,'blocked');
  assert.equal(workflowState(row,progress,false).label,'レビュー待ち');
  assert.equal(workflowState(row,progress,true).group,'running');
  assert.notEqual(workflowState({...row,phase:'running'},{state:'offline'},true).group,'running');
  assert.equal(workflowState({...row,phase:'running'},progress,false).label,'実行状況未確認');
  assert.notEqual(workflowState({...row,phase:'approved'},null,false).group,'running');
});
