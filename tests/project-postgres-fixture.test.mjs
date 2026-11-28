import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile,execFileSync,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {legacyFixturePath,legacyFixtureBlob,correctedFixtureBlob,gitBlobHash,fixLegacyPostgresFixture,prepareLegacyPostgresFixture} from '../scripts/project-postgres-fixture.mjs';

const close=server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
async function listen(server,port=0,host='127.0.0.1'){
 server.listen(port,host);await once(server,'listening');return server.address().port;
}

test('occupied TCP port collides while separate private socket directories coexist',async()=>{
 const blocker=createServer(),collision=createServer(),probe=createServer(),sockets=[];
 const dirs=[mkdtempSync(join(tmpdir(),'pg-a-')),mkdtempSync(join(tmpdir(),'pg-b-'))];
 try{
  const blockedPort=await listen(blocker);
  await assert.rejects(listen(collision,blockedPort),{code:'EADDRINUSE'});
  const dynamicPort=await listen(probe);await close(probe);
  assert.notEqual(dynamicPort,blockedPort);
  for(const dir of dirs){
   const socket=createServer();socket.listen(join(dir,'.s.PGSQL.'+dynamicPort));await once(socket,'listening');sockets.push(socket);
  }
  assert.equal(sockets.every(s=>s.listening),true);
 }finally{
  for(const server of [...sockets,probe,collision,blocker])if(server.listening)await close(server);
  for(const dir of dirs)rmSync(dir,{recursive:true,force:true});
 }
});

test('corrected fixture is exact, and unknown or already corrected sources cannot be rewritten',()=>{
 const corrected=readFileSync(resolve(legacyFixturePath));
 assert.equal(gitBlobHash(corrected),correctedFixtureBlob);
 assert.throws(()=>fixLegacyPostgresFixture(corrected),/Unrecognized/);
 assert.throws(()=>fixLegacyPostgresFixture(Buffer.from('different test')),/Unrecognized/);
});

if(process.env.KATIE_VERIFY_NATIVE_ENV==='1')test('actual PostgreSQL: reproduce bind failure, run two corrected fixtures, preserve original historical tree',{timeout:180000},async()=>{
 const legacy=execFileSync('git',['cat-file','blob',legacyFixtureBlob]);
 assert.equal(fixLegacyPostgresFixture(legacy),readFileSync(resolve(legacyFixturePath),'utf8'));
 const root=mkdtempSync(join(tmpdir(),'pg-collision-')),candidate=join(root,'candidate'),data=join(root,'data');
 const blocker=createServer();
 const bin=process.env.KATIE_TEST_PG_BIN||['/usr/lib/postgresql/16/bin','/usr/lib/postgresql/17/bin','/tmp/katie-pg-bin'].find(p=>existsSync(join(p,'initdb')));
 assert.ok(bin,'Actual PostgreSQL fixture binaries are required');
 const git=(...args)=>execFileSync('git',args,{cwd:candidate,encoding:'utf8',timeout:10000}).trim();
 let overlay;
 try{
  // Exercise the same actual TCP bind error as the old fixed-port fixture.
  const blockedPort=await listen(blocker);
  const run=(name,args)=>spawnSync(join(bin,name),args,{encoding:'utf8',timeout:30000});
  const init=run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);
  assert.equal(init.status,0,init.stderr);
  const failed=run('pg_ctl',['-D',data,'-l',join(root,'postgres.log'),'-o',"-h 127.0.0.1 -k '' -p "+blockedPort,'-w','start']);
  assert.notEqual(failed.status,0,'Legacy TCP startup must reproduce the collision');
  assert.match(readFileSync(join(root,'postgres.log'),'utf8'),/Address already in use/);
  console.log('POSTGRES_LEGACY_TCP_COLLISION_REPRODUCED');
  // Both actual tests must complete every original SQL assertion concurrently,
  // with separate clusters. The already occupied TCP endpoint stays occupied.
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const invoke=promisify(execFile);
  const results=await Promise.allSettled([0,1].map(()=>invoke(process.execPath,['--test',legacyFixturePath],{cwd:process.cwd(),env,timeout:120000,maxBuffer:4*1024*1024})));
  const endpoints=[];
  for(const result of results){
   if(result.status==='rejected')throw Error(String(result.reason)+'\n'+result.reason.stdout+'\n'+result.reason.stderr);
   const {stdout}=result.value;
   assert.match(stdout,/STANDALONE_OWNER_UNCERTAIN_EXPOSURE_CONTINUATION_AND_LATE_RECEIPT_PASS/);
   const marker=stdout.match(/ISOLATED_POSTGRES_ENDPOINT (\{[^\n]+\})/);
   assert.ok(marker,stdout);const endpoint=JSON.parse(marker[1]);
   assert.notEqual(endpoint.port,blockedPort);endpoints.push(endpoint);
  }
  assert.notEqual(endpoints[0].directory,endpoints[1].directory);
  // The trusted overlay accepts only the exact unmodified historical fixture.
  mkdirSync(join(candidate,'tests'),{recursive:true});
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  const file=join(candidate,legacyFixturePath);writeFileSync(file,legacy);
  git('add','.');git('commit','-qm','historical fixture');const head=git('rev-parse','HEAD');
  const tree=git('rev-parse','HEAD^{tree}');
  overlay=prepareLegacyPostgresFixture({root:candidate,baseSha:head,tempRoot:root});
  assert.ok(overlay);assert.equal(gitBlobHash(readFileSync(overlay.args[1])),correctedFixtureBlob);
  assert.equal(git('rev-parse','HEAD^{tree}'),tree);assert.equal(git('status','--porcelain'),'');
  overlay.cleanup();overlay=null;
  writeFileSync(file,Buffer.concat([legacy,Buffer.from('\n// candidate change\n')]));
  assert.throws(()=>prepareLegacyPostgresFixture({root:candidate,baseSha:head,tempRoot:root}),/Unrecognized/);
  git('add','.');git('commit','-qm','candidate changed fixture');
  assert.equal(prepareLegacyPostgresFixture({root:candidate,baseSha:head,tempRoot:root}),null);
  console.log('POSTGRES_PRIVATE_SOCKET_CONCURRENT_NATIVE_PASS');
 }finally{
  overlay?.cleanup();
  if(existsSync(join(data,'postmaster.pid')))spawnSync(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{timeout:15000});
  if(blocker.listening)await close(blocker);
  rmSync(root,{recursive:true,force:true});
 }
});
