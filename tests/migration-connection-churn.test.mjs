import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const runner=readFileSync('scripts/run-migrations.mjs','utf8');
const audit=readFileSync('scripts/audit-migration-authority.mjs','utf8');

test('migration runner retains checksum guards and retries only initialization and history reads',()=>{
 const preflight=runner.indexOf('const plan = auditMigrationPlan(databaseUrl,migrationsDir)');
 const gate=runner.indexOf('if(plan.errors.length)',preflight);
 const pending=runner.indexOf('for(const file of plan.pending)',gate);
 assert.ok(preflight>=0&&gate>preflight&&pending>gate);
 assert.match(audit,/Historical migration checksum mismatch/);
 assert.match(audit,/old\.checksum===sha256/);
 assert.match(audit,/json_agg\(t\)/);
 assert.match(runner,/for \(let attempt = 0; attempt < 3; attempt\+\+\)/);
 assert.match(audit,/for\(let attempt=0;attempt<3;attempt\+\+\)/);
 const loop=runner.slice(pending);
 assert.doesNotMatch(loop,/SELECT checksum FROM schema_migrations|for\s*\(let attempt|UPDATE\s+(?:public\.)?schema_migrations|DELETE\s+FROM\s+(?:public\.)?schema_migrations/i);
 assert.match(loop,/Applying migration:/);
});

function fixture(t,count,{failInitialization=false,corrupt=false}={}){
 const root=mkdtempSync(join(tmpdir(),'katie-migration-pool-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'scripts'),{recursive:true});mkdirSync(join(root,'supabase','migrations'),{recursive:true});mkdirSync(join(root,'bin'),{recursive:true});
 writeFileSync(join(root,'scripts','run-migrations.mjs'),runner);
 writeFileSync(join(root,'scripts','audit-migration-authority.mjs'),audit);
 // Isolated custom-ledger fixture: no native mappings or accounting exception.
 // The actual production manifest and historical bytes are tested separately.
 writeFileSync(join(root,'scripts','migration-provenance.json'),JSON.stringify({version:1,native:[],accounting:{filename:'accounting.sql',recordedSha256:'0'.repeat(64),repositorySha256:'1'.repeat(64)}}));
 const ledger=[];
 for(let i=0;i<count;i++){
  const filename=String(i).padStart(3,'0')+'.sql';
  writeFileSync(join(root,'supabase','migrations',filename),'select 1;');
  ledger.push({filename,checksum:createHash('sha256').update('select 1;').digest('hex'),applied_at:'2026-01-01T00:00:00.000000+00:00'});
 }
 if(corrupt){ledger[0].checksum='f'.repeat(64);writeFileSync(join(root,'supabase','migrations','999.sql'),'select 2;');}
 writeFileSync(join(root,'bin','psql'),`#!/usr/bin/env node
const fs=require('fs');const path=process.env.CALLS;const a=process.argv.join(' ');
const kind=a.includes('CREATE TABLE IF NOT EXISTS schema_migrations')?'init':a.includes('from public.schema_migrations')?'custom':a.includes('from supabase_migrations.schema_migrations')?'native':'unexpected';
const prior=fs.existsSync(path)?fs.readFileSync(path,'utf8'):'';fs.appendFileSync(path,kind+'\\n');
if(process.env.FAIL_INITIALIZATION==='1'&&kind==='init'&&!prior){process.stderr.write('FATAL: Failed to connect to database: authentication did not complete within 15000ms');process.exit(2);}
if(kind==='custom')process.stdout.write(process.env.LEDGER);
if(kind==='native')process.stdout.write('[]');
if(kind==='unexpected'){process.stderr.write('Unexpected migration or ledger write');process.exit(7);}
`,{mode:0o755});
 const run=spawnSync(process.execPath,['scripts/run-migrations.mjs'],{cwd:root,encoding:'utf8',env:{...process.env,DATABASE_URL:'postgres://fixture',CALLS:join(root,'calls'),LEDGER:JSON.stringify(ledger),FAIL_INITIALIZATION:failInitialization?'1':'0',PATH:join(root,'bin')+':'+process.env.PATH}});
 return {run,calls:readFileSync(join(root,'calls'),'utf8').trim().split('\n')};
}

test('80 historical applied migrations use three connections, independent of migration count',t=>{
 const {run,calls}=fixture(t,80);
 assert.equal(run.status,0,run.stderr);
 assert.deepEqual(calls,['init','custom','native']);
 assert.equal(calls.length,3);
 assert.equal((run.stdout.match(/Skipping already-applied migration:/g)||[]).length,80);
});

test('transient Supavisor authentication failure retries idempotent initialization only',t=>{
 const {run,calls}=fixture(t,1,{failInitialization:true});
 assert.equal(run.status,0,run.stderr);
 assert.deepEqual(calls,['init','init','custom','native']);
 assert.equal(calls.length,4);
 assert.match(run.stderr,/retrying/);
});

test('historical checksum mismatch fails closed before any pending migration or ledger write',t=>{
 const {run,calls}=fixture(t,1,{corrupt:true});
 assert.equal(run.status,1,run.stderr);
 assert.match(run.stderr,/Historical migration checksum mismatch: 000\.sql/);
 assert.deepEqual(calls,['init','custom','native']);
 assert.doesNotMatch(run.stdout,/Applying migration:/);
});
