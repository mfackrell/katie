import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
const domain='katie:benchmark715:dashboard-owner-consent:v1';
const deny=()=>{throw Error('DASHBOARD_OWNER_CONSENT_INVALID')};
const keyFor=key=>{if(typeof key!=='string'||key.length<32)deny();return createHash('sha256').update(domain+'\0'+key).digest()};
export function sealDashboardHandoff(payload,key){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyFor(key),iv);
 cipher.setAAD(Buffer.from(domain));
 const encrypted=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
}
export function openDashboardHandoff(value,key,sha,now=Date.now()){
 try{
  if(typeof value!=='string'||value.length>12000||! /^[A-Za-z0-9_-]+$/.test(value))deny();
  const raw=Buffer.from(value,'base64url'),decipher=createDecipheriv('aes-256-gcm',keyFor(key),raw.subarray(0,12));
  decipher.setAAD(Buffer.from(domain));decipher.setAuthTag(raw.subarray(12,28));
  const p=JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8'));
  if(!/^[a-f0-9-]{36}$/.test(p.consentId??'')||p.sha!==sha||! /^[a-f0-9]{40}$/.test(sha)||
   !Number.isSafeInteger(p.expiresAt)||p.expiresAt<=now||p.expiresAt>now+3600000||
   typeof p.bypass!=='string'||!p.bypass||/[\r\n]/.test(p.bypass)||
   Object.keys(p).sort().join()!==['consentId','sha','expiresAt','bypass'].sort().join())deny();
  return p;
 }catch{deny()}
}
export function validateDashboardConsent(consent,{id,ownerId,sha,runId,authorizationSha},now=Date.now()){
 if(!consent||consent.id!==id||consent.owner_id!==ownerId||consent.commit_sha!==sha||
  consent.authorization_sha!==authorizationSha||consent.revoked_at||
  !Number.isFinite(Date.parse(consent.expires_at))||Date.parse(consent.expires_at)<=now||
  (consent.run_id!==null&&consent.run_id!==runId))deny();
 return true;
}
