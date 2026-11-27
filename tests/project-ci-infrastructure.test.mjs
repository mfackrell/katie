import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import vm from 'node:vm';

const source=readFileSync(new URL('../scripts/project-ci.mjs',import.meta.url),'utf8');
const start=source.indexOf('export async function verifyProject(');
const end=source.indexOf('if(process.argv[1]',start);
const body=source.slice(start,end).replace('export async function','async function').replace('fileURLToPath(import.meta.url)',JSON.stringify('/trusted/project-tools/project-ci.mjs'));
const fullGate='npm run typecheck && npm test && npm run check:url && npm run build && npm run smoke';

async function run({failure,gate=fullGate}={}){
 const context={projectId:'project-test',baseSha:'a'.repeat(40)},writes=[],calls=[],collected=[];
 let caught;
 const env={resolve,dirname,Buffer,JSON,Date,Error,
  process:{env:{RUNNER_TEMP:'/tmp'},execPath:'/usr/bin/node'},
  readFileSync:(path)=>path.endsWith('/package.json')?JSON.stringify({scripts:{'ci:gate':gate}}):'request',
  parseProjectContext:()=>context,existsSync:()=>false,mkdirSync:()=>{},rmSync:()=>{},
  cpSync:()=>{},symlinkSync:()=>{},mkdtempSync:path=>path+'test',
  writeFileSync:(path,content)=>writes.push({path,content:JSON.parse(content)}),
  execFileSync:()=>context.baseSha,checkGameModel:()=>null,sandboxArgs:()=>[],
  collectTestArtifacts:(...args)=>collected.push(args),
  spawnSync:(cmd,args,options)=>{
   const stage=cmd==='git'?'archive':cmd==='tar'?'extract':cmd==='bwrap'?'check':args[0]==='ci'?'install':'sdk';
   calls.push({stage,args,options});
   return stage===failure?.stage?failure.result:{status:0,signal:null,stdout:Buffer.alloc(0)};
  }
 };
 // Stop at a real failure boundary before the browser import.
 try{await vm.runInNewContext('(async()=>{'+body+';return verifyProject({request:"/trusted/request",output:"/trusted/receipt.json",workspace:"/candidate"});})()',env);}catch(error){caught=error;}
 return {caught,calls,collected,receipts:writes.filter(x=>x.path.endsWith('/project-verification-failure.json')).map(x=>x.content)};
}
function receipt(result,stage){
 assert.equal(result.receipts.length,1);
 assert.deepEqual(result.receipts[0],{version:1,kind:'infrastructure',stage,projectId:'project-test',baseSha:'a'.repeat(40)});
 assert.ok(result.caught);
}

test('archive timeout stops before extraction or dependency install',async()=>{
 const result=await run({failure:{stage:'archive',result:{status:null,error:Error('ETIMEDOUT'),signal:'SIGTERM'}}});
 receipt(result,'baseline-archive');assert.deepEqual(result.calls.map(x=>x.stage),['archive']);
});
test('extraction failure stops before dependency install',async()=>{
 const result=await run({failure:{stage:'extract',result:{status:null,error:Error('ENOENT')}}});
 receipt(result,'baseline-extract');assert.deepEqual(result.calls.map(x=>x.stage),['archive','extract']);
});
for(const [name,outcome] of [['timeout',{status:null,error:Error('ETIMEDOUT'),signal:'SIGKILL'}],['launch error',{status:null,error:Error('ENOENT')}],['signal',{status:null,signal:'SIGKILL'}]]){
 test('isolated CI '+name+' retains infrastructure receipt and diagnostics',async()=>{
  const result=await run({failure:{stage:'check',result:outcome}});
  receipt(result,'isolated-ci-process');assert.equal(result.collected.length,1);
  assert.equal(result.calls.at(-1).options.killSignal,'SIGKILL');
 });
}
test('candidate CI failure remains failure, not infrastructure',async()=>{
 const result=await run({failure:{stage:'check',result:{status:1,signal:null}}});
 assert.match(result.caught.message,/Isolated project CI failed/);assert.equal(result.receipts.length,0);
});
for(const [gate,expected] of [[fullGate,['ci:gate']],['npm test',['typecheck','ci:gate']]]){
 test('preserves required typecheck and full CI without redundant invocation: '+gate,async()=>{
  const result=await run({gate,failure:{stage:'check',result:{status:1,signal:null}}});
  const script=result.calls.at(-1).args.at(-1),tasks=[];
  vm.runInNewContext(script,{require:()=>({spawnSync:(_cmd,args)=>{tasks.push(args[1]);return {status:0};}}),process:{exit:()=>assert.fail('unexpected exit')}});
  assert.deepEqual(tasks,expected);
 });
}
