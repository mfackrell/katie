import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {gameFixture} from './fixtures/game-project.mjs';
import {validateProjectGame} from '../scripts/project-game-rules.mjs';
import {checkGameModel} from '../scripts/project-game-check.mjs';
import {projectMarker,parseProjectContext,contractHash} from '../scripts/project-context.mjs';
test('registration preserves complete rules and exact browser scenarios in the immutable owner context',()=>{
 const f=gameFixture();assert.equal(validateProjectGame(f.game,f.allowedPaths,f.contract),f.game);
 const c={version:1,projectId:'11111111-1111-4111-8111-111111111111',baseSha:'a'.repeat(40),baselineSha:'a'.repeat(40),allowedPaths:f.allowedPaths,contractHash:contractHash(f.contract),contract:f.contract,game:f.game};
 assert.deepEqual(parseProjectContext(projectMarker(c)),c);
 const swapped={...f.contract,scenarios:[{name:'title-only',steps:[{action:'expectVisible',selector:'#title'}]}]};
 assert.throws(()=>projectMarker({...c,contract:swapped,contractHash:contractHash(swapped)}),/exactly execute/);
 const missing=structuredClone(f.game);missing.rules.unknowns=[{id:'edition',question:'Which edition?',status:'open',blocking:true,ruleIds:['increment']}];
 assert.throws(()=>validateProjectGame(missing,f.allowedPaths,f.contract),/resolve game rules/);
 assert.throws(()=>validateProjectGame(f.game,['app/elsewhere/'],f.contract),/outside approved/);
 assert.throws(()=>validateProjectGame(f.game,f.allowedPaths,{...f.contract,scenarios:[{name:'loading-only',steps:[{action:'expectVisible',selector:'#title'}]}]}),/exactly execute/);
 assert.throws(()=>parseProjectContext(projectMarker({...c,game:{...f.game,enginePath:'app/counter/../../secrets.ts'}})),/engine path/);
});
test('trusted model runner tests the actual isolated engine and rejects wrong, mutating and fake-output implementations',()=>{
 const probe=spawnSync('bwrap',['--unshare-user','--ro-bind','/','/','true'],{encoding:'utf8',timeout:5000});
 if(probe.status!==0&&!process.env.CI){console.log('Model execution unavailable locally: '+String(probe.stderr||probe.error?.message||'namespace unavailable').trim());return;}
 assert.equal(probe.status,0,probe.stderr);
 const root=mkdtempSync(join(tmpdir(),'game-engine-'));
 try{
  mkdirSync(join(root,'app/counter'),{recursive:true});mkdirSync(join(root,'node_modules'));
  const dependencies=resolve('node_modules');mkdirSync(join(dependencies,'.vite'),{recursive:true});const f=gameFixture();const context={game:f.game};
  const engine=code=>writeFileSync(join(root,f.game.enginePath),code);
  engine('export function transition(state,action){return action.type === "increment" ? {count:state.count+1} : state;}');
  assert.equal(checkGameModel(context,root,dependencies).passed,true);
  engine('export function transition(state,action){return {count:99};}');
  assert.throws(()=>checkGameModel(context,root,dependencies),/disagreed with expected/);
  engine('export function transition(state,action){if(action.type === "increment")state.count++;return state;}');
  assert.throws(()=>checkGameModel(context,root,dependencies),/mutated prior/);
  engine('export function transition(){return {passed:true};}');
  assert.throws(()=>checkGameModel(context,root,dependencies),/disagreed with expected/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
