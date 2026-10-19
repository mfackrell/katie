import {spawnSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {sandboxArgs} from './project-sandbox.mjs';
import {runGameModelAcceptance} from './project-game-rules.mjs';
export function checkGameModel(context,workspace,dependencies){
 if(!context.game||context.gameFinal!==true)return null;
 const {rules,acceptance,enginePath}=context.game;
 const program=`const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');const payload=JSON.parse(fs.readFileSync(0,'utf8'));const source=fs.readFileSync(payload.enginePath,'utf8');const exports={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,structuredClone},{timeout:3000});if(typeof exports.transition!=='function')throw Error('Engine must export transition');const next=exports.transition(payload.state,payload.action);process.stdout.write(JSON.stringify({next,prior:payload.state}));`;
 const result=runGameModelAcceptance(rules,acceptance,(state,action)=>{
  const run=spawnSync('bwrap',[...sandboxArgs(workspace,{dependencies}),process.execPath,'-e',program],{input:JSON.stringify({enginePath,state,action}),encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  if(run.status!==0)throw Error('Game engine execution failed: '+String(run.stderr||run.error?.message).slice(-1000));
  const observed=JSON.parse(run.stdout);
  if(!isDeepStrictEqual(observed.prior,state))throw Error('Game transition mutated prior state');
  return observed.next;
 });
 if(!result.passed)throw Error('Registered game model acceptance failed: '+JSON.stringify(result));
 console.log('REGISTERED_GAME_MODEL_RECEIPT '+JSON.stringify(result));
 return result;
}
