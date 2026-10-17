import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';import {sandboxArgs} from '../scripts/project-sandbox.mjs';
test('candidate code cannot tamper with trusted verifier, owner contract, evidence, dependencies or parent processes',()=>{
 if(!process.env.CI){const probe=spawnSync('unshare',['--user','--map-root-user','true'],{encoding:'utf8',timeout:5000});if(probe.status!==0){assert.match(probe.stderr,/Operation not permitted|No permissions/);return;}}
 const root=mkdtempSync(join(tmpdir(),'project-boundary-')),candidate=join(root,'candidate'),trusted=join(root,'trusted'),deps=join(root,'deps');
 try{for(const p of [candidate,trusted,deps])mkdirSync(p);mkdirSync(join(candidate,'node_modules'));for(const name of ['verifier','contract','evidence'])writeFileSync(join(trusted,name),'ORIGINAL');writeFileSync(join(deps,'dependency'),'ORIGINAL');
 const malicious=`const fs=require('node:fs');let escaped=0;for(const file of ${JSON.stringify(['verifier','contract','evidence'].map(n=>join(trusted,n)).concat(['/app/node_modules/dependency']))}){try{fs.writeFileSync(file,'FORGED');escaped++;}catch{}}if(fs.existsSync('/proc/${process.pid}/root'))escaped++;try{fs.writeFileSync('/app/local','allowed');}catch{process.exit(3);}process.exit(escaped?2:0);`;
 const r=spawnSync('bwrap',[...sandboxArgs(candidate,{dependencies:deps,writable:true}),process.execPath,'-e',malicious],{encoding:'utf8',timeout:15000});
 if(r.status!==0&&!process.env.CI&&/Operation not permitted|No permissions|namespace/.test(r.stderr??'')){assert.match(r.stderr,/Operation not permitted|No permissions|namespace/);return;}
 assert.equal(r.status,0,r.stderr||r.error?.message);assert.equal(readFileSync(join(candidate,'local'),'utf8'),'allowed');for(const name of ['verifier','contract','evidence'])assert.equal(readFileSync(join(trusted,name),'utf8'),'ORIGINAL');assert.equal(readFileSync(join(deps,'dependency'),'utf8'),'ORIGINAL');
 }finally{rmSync(root,{recursive:true,force:true});}
});
