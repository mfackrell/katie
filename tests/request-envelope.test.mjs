import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {packDevelopmentRequest,unpackDevelopmentRequest} from '../scripts/request-envelope.mjs';
test('trusted request transport preserves the complete source and durable marker through the real unpack CLI',()=>{
 const marker='<!-- katie-managed-task:'+randomUUID()+' -->';
 const original=marker+'\n\n'+('Exact original rules, Unicode 🙂 and approved instructions.\n'.repeat(1700));
 const packed=packDevelopmentRequest(original,marker);assert.ok(original.length>65536);assert.ok(packed.length<60000);assert.ok(packed.startsWith(marker));
 assert.equal(unpackDevelopmentRequest(packed),original);
 const title='[agent] Approved game',dir=mkdtempSync(join(tmpdir(),'katie-envelope-')),path=join(dir,'request.md');
 try{writeFileSync(path,title+'\n\n'+packed);const result=spawnSync(process.execPath,['scripts/request-envelope.mjs','unpack',path],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(path,'utf8'),title+'\n\n'+original);}finally{rmSync(dir,{recursive:true,force:true});}
 for(const workflow of ['autonomous-development.yml','project-reverify.yml']){const text=readFileSync('.github/workflows/'+workflow,'utf8');assert.ok(text.indexOf('node scripts/request-envelope.mjs unpack')<text.indexOf('node scripts/project-context.mjs prepare'));}
});
test('ordinary requests remain unchanged; malformed envelopes and decompression overflow never become coding input',()=>{
 assert.equal(unpackDevelopmentRequest('Ordinary task'),'Ordinary task');const marker='<!-- katie-managed-task:'+randomUUID()+' -->',original=marker+'\n\n'+'Complete rules. '.repeat(6000),packed=packDevelopmentRequest(original,marker);
 assert.throws(()=>unpackDevelopmentRequest(packed.replace(/v1: [0-9a-f]/,'v1: z')));
 assert.throws(()=>unpackDevelopmentRequest(packed+packed));
 const bytes=Buffer.from('x'.repeat(1_000_001)),digest=createHash('sha256').update(bytes).digest('hex');assert.throws(()=>unpackDevelopmentRequest(marker+'\n\n<!-- katie-request-v1: '+digest+':'+gzipSync(bytes).toString('base64url')+' -->'));
 assert.throws(()=>packDevelopmentRequest(original+'<!-- katie-request-v1: nested -->',marker));
});
