import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const runner=readFileSync('scripts/run-migrations.mjs','utf8');
test('migration runner retains checksum guards and retries only ledger reads',()=>{
 assert.match(runner,/json_object_agg\(filename,checksum\)/);
 assert.match(runner,/for \(let attempt = 0; attempt < 3; attempt\+\+\)/);
 const loop=runner.slice(runner.indexOf('for (const file of files)'));
 assert.doesNotMatch(loop,/SELECT checksum FROM schema_migrations/);
 assert.match(loop,/Checksum mismatch for already-applied migration/);
 assert.match(loop,/Applying migration:/);
});
test('80 historical applied migrations use two connections rather than 82',t=>{
 const root=mkdtempSync(join(tmpdir(),'katie-migration-pool-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'scripts'),{recursive:true});mkdirSync(join(root,'supabase','migrations'),{recursive:true});mkdirSync(join(root,'bin'),{recursive:true});
 writeFileSync(join(root,'scripts','run-migrations.mjs'),runner);
 const ledger={};for(let i=0;i<80;i++){const name=String(i).padStart(3,'0')+'.sql';writeFileSync(join(root,'supabase','migrations',name),'select 1;');ledger[name]=createHash('sha256').update('select 1;').digest('hex');}
 const fake=`#!/usr/bin/env node
const fs=require('fs');fs.appendFileSync(process.env.CALLS,'1');
const a=process.argv.join(' ');if(a.includes('json_object_agg'))process.stdout.write(process.env.LEDGER);process.exit(0);
`;
 writeFileSync(join(root,'bin','psql'),fake,{mode:0o755});
 const run=spawnSync(process.execPath,['scripts/run-migrations.mjs'],{cwd:root,encoding:'utf8',env:{...process.env,DATABASE_URL:'postgres://fixture',CALLS:join(root,'calls'),LEDGER:JSON.stringify(ledger),PATH:join(root,'bin')+':'+process.env.PATH}});
 assert.equal(run.status,0,run.stderr);
 assert.equal(readFileSync(join(root,'calls'),'utf8').length,2);
});

test('transient Supavisor authentication failure retries idempotent initialization only',t=>{
 const root=mkdtempSync(join(tmpdir(),'katie-migration-auth-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'scripts'),{recursive:true});mkdirSync(join(root,'supabase','migrations'),{recursive:true});mkdirSync(join(root,'bin'),{recursive:true});
 writeFileSync(join(root,'scripts','run-migrations.mjs'),runner);
 const filename='001.sql';writeFileSync(join(root,'supabase','migrations',filename),'select 1;');
 const ledger={[filename]:createHash('sha256').update('select 1;').digest('hex')};
 writeFileSync(join(root,'bin','psql'),`#!/usr/bin/env node
const fs=require('fs');const path=process.env.CALLS;
const n=fs.existsSync(path)?fs.readFileSync(path,'utf8').length:0;fs.appendFileSync(path,'1');
if(n===0){process.stderr.write('FATAL: Failed to connect to database: authentication did not complete within 15000ms');process.exit(2);}
if(process.argv.join(' ').includes('json_object_agg'))process.stdout.write(process.env.LEDGER);
process.exit(0);
`,{mode:0o755});
 const run=spawnSync(process.execPath,['scripts/run-migrations.mjs'],{cwd:root,encoding:'utf8',env:{...process.env,DATABASE_URL:'postgres://fixture',CALLS:join(root,'calls'),LEDGER:JSON.stringify(ledger),PATH:join(root,'bin')+':'+process.env.PATH}});
 assert.equal(run.status,0,run.stderr);
 assert.equal(readFileSync(join(root,'calls'),'utf8').length,3);
 assert.match(run.stderr,/retrying/);
});
