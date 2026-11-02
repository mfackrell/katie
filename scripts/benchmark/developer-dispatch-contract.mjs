// Ordinary Developer handoffs share the native host but never impersonate a
// benchmark trial. Every binding is covered by a separate signature domain.
import {createHmac,timingSafeEqual} from 'node:crypto';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha=/^[a-f0-9]{40}$/,hash=/^[a-f0-9]{64}$/;
const domain=kind=>kind==='task4a-developer'?'katie:task4a-developer:handoff:v1':'katie:ordinary-developer:handoff:v1';
const required=['version','authorityKind','taskId','projectId','approvalId','accountId','scopeHash','contractHash','baselineSha','releaseSha','expiresAt'];
const deny=()=>{throw Error('DEVELOPER_HANDOFF_INVALID');};
function validate(p,now){
 if(!p||typeof p!=='object'||Array.isArray(p)||p.version!==1||!['ordinary-developer','task4a-developer'].includes(p.authorityKind)
  ||!['taskId','projectId','approvalId','accountId'].every(k=>uuid.test(p[k]??''))
  ||!['scopeHash','contractHash'].every(k=>hash.test(p[k]??''))
  ||!['baselineSha','releaseSha'].every(k=>sha.test(p[k]??''))
  ||(p.authorityKind==='task4a-developer'?!uuid.test(p.task4aContinuationId??''):p.task4aContinuationId!==undefined)
  ||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=now
  ||(p.productionRuntime!==undefined&&(typeof p.productionRuntime!=='string'||p.productionRuntime.length>8192||! /^[A-Za-z0-9_-]+$/.test(p.productionRuntime)))
  ||Object.keys(p).sort().join()!==[...required,...(p.authorityKind==='task4a-developer'?['task4aContinuationId']:[]),...(p.productionRuntime===undefined?[]:['productionRuntime'])].sort().join())deny();
}
function key(value){if(typeof value!=='string'||value.length<32)throw Error('DEVELOPER_HANDOFF_KEY_UNAVAILABLE');return value;}
const signature=(content,secret,kind)=>createHmac('sha256',key(secret)).update(domain(kind)+'\0'+content).digest();
export function encodeDeveloperHandoff(payload,secret,now=Date.now()){
 const p={version:1,authorityKind:'ordinary-developer',...payload};validate(p,now);
 const content=Buffer.from(JSON.stringify(p)).toString('base64url');
 const tag=p.authorityKind==='task4a-developer'?'task4a':'developer';
 return '<!-- katie-native-'+tag+':'+content+'.'+signature(content,secret,p.authorityKind).toString('base64url')+' -->';
}
export function readDeveloperHandoff(source,secret,now=Date.now()){
 const text=String(source),matches=[...text.matchAll(/<!-- katie-native-(developer|task4a):([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+) -->/g)];
 if(matches.length!==1||/<!--\s*katie-native-benchmark[:\s]/.test(text))throw Error('DEVELOPER_HANDOFF_MISSING_DUPLICATED_OR_MIXED');
 const [,tag,content,signed]=matches[0];
 let p;try{p=JSON.parse(Buffer.from(content,'base64url').toString('utf8'));}catch{deny();}
 validate(p,now);
 if((tag==='task4a')!==(p.authorityKind==='task4a-developer'))deny();
 const expected=signature(content,secret,p.authorityKind),actual=Buffer.from(signed,'base64url');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('DEVELOPER_HANDOFF_UNAUTHENTICATED');
 return Object.freeze(p);
}
