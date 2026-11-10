import {createHash,createHmac,timingSafeEqual} from 'node:crypto';

const tag=/<!--\s*katie-native-(?:provider|developer|task4a|benchmark)[:\s]/g;
const exact=/<!-- katie-native-provider:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+) -->/g;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const deny=()=>{throw Error('PROVIDER_EXECUTION_HANDOFF_INVALID');};
const sign=(content,key)=>{
 if(typeof key!=='string'||key.length<32)deny();
 return createHmac('sha256',key).update('katie:provider-execution:handoff:v1\0'+content).digest();
};
export const providerExecutionRequestHash=body=>createHash('sha256').update(body.trim()).digest('hex');
function validate(p,now){
 const keys=['version','authorityKind','taskId','projectId','scopeHash','contractHash','baselineSha','releaseSha','requestHash','expiresAt','productionRuntime'];
 if(!p||Object.keys(p).sort().join()!==keys.sort().join()||p.version!==1||p.authorityKind!=='provider-execution'||
    !['taskId','projectId'].every(k=>uuid.test(p[k]??''))||
    !['scopeHash','contractHash','requestHash'].every(k=>/^[a-f0-9]{64}$/.test(p[k]??''))||
    !['baselineSha','releaseSha'].every(k=>/^[a-f0-9]{40}$/.test(p[k]??''))||
    !Number.isSafeInteger(p.expiresAt)||p.expiresAt<=now||p.expiresAt>now+1800000||
    typeof p.productionRuntime!=='string'||p.productionRuntime.length>8192||!/^[A-Za-z0-9_-]+$/.test(p.productionRuntime))deny();
}
export function encodeProviderExecutionHandoff(proof,key,now=Date.now()){
 const p={version:1,...proof};validate(p,now);
 const content=Buffer.from(JSON.stringify(p)).toString('base64url');
 return `<!-- katie-native-provider:${content}.${sign(content,key).toString('base64url')} -->`;
}
export function readProviderExecutionHandoff(source,key,now=Date.now()){
 const matches=[...source.matchAll(exact)];
 if(matches.length!==1||[...source.matchAll(tag)].length!==1)deny();
 const [header,content,signed]=matches[0];
 const expected=sign(content,key),actual=Buffer.from(signed,'base64url');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))deny();
 let p;try{p=JSON.parse(Buffer.from(content,'base64url').toString('utf8'));}catch{deny();}
 validate(p,now);
 const marker=`<!-- katie-managed-task:${p.taskId} -->`;
 if(!source.slice(0,matches[0].index).trimEnd().endsWith(marker)||
    providerExecutionRequestHash(source.slice(matches[0].index+header.length))!==p.requestHash)deny();
 return Object.freeze(p);
}
