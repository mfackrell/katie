import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
const domain='katie:benchmark715:native-production-runtime:v1';
const deny=()=>{throw Error('NATIVE_PRODUCTION_RUNTIME_INVALID')};
const keyFor=key=>{if(typeof key!=='string'||key.length<32)deny();return createHash('sha256').update(domain+'\0'+key).digest()};
const aad=p=>Buffer.from(JSON.stringify([domain,p.taskId,p.trialId,p.approvalId,p.projectId,p.contractHash,p.benchmarkContractHash,p.baselineSha,p.expiresAt,...(p.continuationId?[p.continuationId]:[]),...(p.startupRecoveryId?[p.startupRecoveryId]:[]),...(p.developmentRenewalId?[p.developmentRenewalId]:[]),...(p.pregrantRecoveryId?[p.pregrantRecoveryId]:[])]));
const validate=(p,now)=>{if(!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=now||p.expiresAt>now+1800000)deny()};
export function sealNativeProductionRuntime(serviceRoleKey,proof,key,now=Date.now()){
 validate(proof,now);
 if(typeof serviceRoleKey!=='string'||!serviceRoleKey||/[\r\n]/.test(serviceRoleKey))deny();
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyFor(key),iv);
 cipher.setAAD(aad(proof));
 const encrypted=Buffer.concat([cipher.update(JSON.stringify({serviceRoleKey}),'utf8'),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
}
// Only the trusted host calls this after validating the outer signed handoff.
// The capsule cannot select an arbitrary database or any provider credential.
export function openNativeProductionRuntime(value,proof,key,now=Date.now()){
 try{
  validate(proof,now);
  if(typeof value!=='string'||value.length>8192||! /^[A-Za-z0-9_-]+$/.test(value))deny();
  const raw=Buffer.from(value,'base64url'),decipher=createDecipheriv('aes-256-gcm',keyFor(key),raw.subarray(0,12));
  decipher.setAAD(aad(proof));decipher.setAuthTag(raw.subarray(12,28));
  const p=JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8'));
  if(Object.keys(p).join()!=='serviceRoleKey'||typeof p.serviceRoleKey!=='string'||!p.serviceRoleKey||/[\r\n]/.test(p.serviceRoleKey))deny();
  return {url:'https://barclcqataqyvifoeyop.supabase.co',serviceRoleKey:p.serviceRoleKey};
 }catch{deny()}
}


