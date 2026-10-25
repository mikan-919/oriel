import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import {parseDocument} from 'yaml';

test('documented execution example is accepted by the production parser',()=>{
  const source=stripTypeScriptTypes(readFileSync(new URL('../src/workflow.ts',import.meta.url),'utf8'),{mode:'transform'});
  const context=vm.createContext({parseDocument});
  vm.runInContext(source.replace(/^import[\s\S]*?;/gm,'').replace(/^export /gm,''),context);
  const result=context.parseConfiguration(readFileSync(new URL('../../../.oriel.example.yaml',import.meta.url),'utf8'));
  assert.equal(result.error,null);assert.equal(result.autonomous,true);
  assert.equal(result.verification.length,2);
});
