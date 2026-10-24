#!/usr/bin/env node
// Benchmark orchestration driver. No model calls are made by this file.
// Each adapter must enforce its own cap BEFORE sending provider requests.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const fail=(s)=>{throw new Error(s)};
const argv=process.argv.slice(2);
const arg=(k)=>{const i=argv.indexOf(k);return i<0?null:argv[i+1]};
const configPath=arg('--config')||fail('--config required');
const cfg=JSON.parse(readFileSync(configPath,'utf8'));
if(!Number.isSafeInteger(cfg.capTokens)||cfg.capTokens<=0)fail('positive integer capTokens required');
if(!cfg.baselineSha || !/^[a-f0-9]{40}$/.test(cfg.baselineSha))fail('exact 40-character baseline SHA required');
if(!Array.isArray(cfg.arms)||cfg.arms.length!==2||new Set(cfg.arms.map(a=>a.id)).size!==2||!['direct','orchestrated'].every(id=>cfg.arms.some(a=>a.id===id)))fail('exactly direct and orchestrated arms required');
const out=resolve(arg('--out')||'benchmark-results');
mkdirSync(out,{recursive:true});
const runId=randomUUID();
const results=[];
for(const arm of cfg.arms){
 if(!/^benchmark\/take-eleven-(direct|orchestrated)$/.test(arm.branch)||arm.branch!==`benchmark/take-eleven-${arm.id}`)fail('invalid isolated branch');
 if(typeof arm.command!=='string'||!arm.command || arm.command.includes('/') || arm.command.includes('\\'))fail('command must be a PATH executable name; no shell commands');
 if(!Array.isArray(arm.args)||arm.args.some(v=>typeof v!=='string'))fail('command args required');
 const cwd=resolve(arm.cwd||'.');
 const head=spawnSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'});
 if(head.status!==0||head.stdout.trim()!==cfg.baselineSha)fail(`${arm.id} cwd must start at baseline SHA`);
 const branch=spawnSync('git',['branch','--show-current'],{cwd,encoding:'utf8'});
 if(branch.status!==0||branch.stdout.trim()!==arm.branch)fail(`${arm.id} not on expected branch`);
 const clean=spawnSync('git',['status','--porcelain'],{cwd,encoding:'utf8'});
 if(clean.status!==0||clean.stdout.trim())fail(`${arm.id} worktree not clean`);
 // An adapter must read this cap and stop BEFORE exceeding it. No adapter, no run.
 const started=Date.now();
 const child=spawnSync(arm.command,arm.args,{cwd,encoding:'utf8',timeout:cfg.timeoutMs||900000,maxBuffer:1024*1024,env:{...process.env,BENCHMARK_ARM:arm.id,BENCHMARK_TOKEN_CAP:String(cfg.capTokens),BENCHMARK_RUN_ID:runId,BENCHMARK_BASELINE_SHA:cfg.baselineSha,BENCHMARK_RECEIPT_PATH:resolve(out,`${arm.id}-provider.json`)}});
 const receiptPath=resolve(out,`${arm.id}-provider.json`);
 let receipt=null;
 try {receipt=JSON.parse(readFileSync(receiptPath,'utf8'))}catch{}
 const usage=receipt?.usage;
 const valid=receipt?.runId===runId&&receipt?.arm===arm.id&&
  receipt?.baselineSha===cfg.baselineSha&&receipt?.capEnforced===true&&
  Number.isSafeInteger(usage?.inputTokens)&&usage.inputTokens>=0&&
  Number.isSafeInteger(usage?.outputTokens)&&usage.outputTokens>=0&&
  usage.inputTokens+usage.outputTokens<=cfg.capTokens;
 const status=child.status===0&&valid?'execution-finished-unverified':'blocked';
 const summary={arm:arm.id,runId,baselineSha:cfg.baselineSha,branch:arm.branch,capTokens:cfg.capTokens,status,exitCode:child.status,elapsedMs:Date.now()-started,usage:valid?usage:null,receiptValid:valid,artifactSha:receipt?.artifactSha||null,verification:'NOT_RUN',failure:valid?(child.error?.message||null):'Provider receipt missing/invalid, cap unverified or exceeded'};
 writeFileSync(resolve(out,`${arm.id}-summary.json`),JSON.stringify(summary,null,2));
 results.push(summary);
 if(status==='blocked')break; // fail closed: never hide invalid usage behind a second run
}
writeFileSync(resolve(out,'comparison.json'),JSON.stringify({runId,results,accepted:false,reason:'Independent deterministic and private browser acceptance required'},null,2));
if(results.length!==2||results.some(r=>r.status!=='execution-finished-unverified'))process.exitCode=1;
