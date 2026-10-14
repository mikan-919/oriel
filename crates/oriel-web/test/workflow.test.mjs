import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowState,currentCI,currentVerification} from '../src/assets/workflow.js';
const head='a'.repeat(40), target='b'.repeat(40);
const row={issue:{number:86},phase:'review',pull_request:{head_oid:head},ci:{head_oid:head,status:'success',checks:[]}};
test('CI success requires evidence for the current PR head',()=>{
  assert.equal(currentCI(row).status,'success');
  assert.equal(currentCI({...row,pull_request:{head_oid:target}}).status,'unknown');
  assert.equal(currentCI({...row,ci:undefined}).status,'unknown');
});
test('terminal verification cannot be reused across issues, commits, configuration or stale transport',()=>{
  const value={issue_number:86,head_oid:head,target_oid:target,status:'success',completed:2,total:2};
  const snapshot={target_oid:target,configuration:{verification:[['cargo','test'],['cargo','clippy']]}};
  assert.equal(currentVerification(row,snapshot,{verification:value},true),value);
  for(const [patch,live] of [[{issue_number:87},true],[{head_oid:target},true],[{target_oid:head},true],[{completed:1},true],[{completed:1,total:1},true],[{},false]])
    assert.equal(currentVerification(row,snapshot,{verification:{...value,...patch}},live),null);
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
