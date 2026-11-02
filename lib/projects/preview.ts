import {runScenarios,type PreviewCookie} from '../../scripts/project-browser-engine.mjs';
import {immutablePreviewUrl,verifiedPreviewUrl} from '@/lib/agents/development';
import {browserContract,digest} from './contract';
import type {BrowserContract} from './store';
export class PreviewAccessUnavailable extends Error {constructor(){super('Deployed Preview requires authentication. Configure the production-only preview acceptance connection, then resume this project. Deployment protection remains enabled.');this.name='PreviewAccessUnavailable';}}
function samePreviewOrigin(location:string,origin:string){try{return new URL(location,origin+'/').origin===origin;}catch{return false;}}
// Only Vercel's edge sees the automation secret. Its manual redirect mints an
// HttpOnly cookie restricted to this exact deployment URL; application requests
// and the browser never receive the project-wide secret or a trusted OIDC token.
export async function previewCookies(origin:string,request:typeof fetch=fetch):Promise<PreviewCookie[]>{
 if(!verifiedPreviewUrl(origin)||new URL(origin).origin!==origin)throw Error('Exact verified Vercel origin required');
 const secret=process.env.PROJECT_PREVIEW_BYPASS_SECRET;if(!secret)throw new PreviewAccessUnavailable();
 const rule=process.env.PROJECT_PREVIEW_HOST_PATTERN;if(!rule||!rule.startsWith('^')||!rule.endsWith('$')||!new RegExp(rule).test(new URL(origin).hostname))throw new PreviewAccessUnavailable();
 const response=await request(origin+'/',{headers:{'x-vercel-protection-bypass':secret,'x-vercel-set-bypass-cookie':'true'},redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(10000)});
 await response.body?.cancel();
 // Never follow a cross-origin redirect with authentication material.
 const destination=response.headers.get('location');
 if(response.status<300||response.status>=400||(destination&&!samePreviewOrigin(destination,origin)))throw new PreviewAccessUnavailable();
 // Validate attributes on the _vercel_jwt cookie itself, not on another
 // Set-Cookie header. Only a usable host-scoped, Secure HttpOnly cookie passes.
 const lines=response.headers.getSetCookie?.()??[];
 const headers=lines.length?lines:(response.headers.get('set-cookie')??'').split(/,(?=\s*[^\s,;=]+=)/);
 const raw=headers.find(value=>/^\s*_vercel_jwt=/.test(value));
 if(!raw)throw new PreviewAccessUnavailable();
 const parts=raw.split(';'),jwt=parts.shift()!.trim().slice('_vercel_jwt='.length);
 if(!jwt||jwt.length>4096||/[\s,;]/.test(jwt))throw new PreviewAccessUnavailable();
 const attributes=new Map(parts.map(part=>{const i=part.indexOf('=');return [part.slice(0,i<0?undefined:i).trim().toLowerCase(),i<0?'':part.slice(i+1).trim()] as const;}));
 const hostname=new URL(origin).hostname;
 const cookieDomain=attributes.get('domain');
 const maxAge=attributes.get('max-age');
 const expires=attributes.get('expires');
 // The deployed browser phase has a 75-second deadline; a cookie that expires
 // before that bounded acceptance could finish is not usable authentication.
 const ttl=maxAge!==undefined?Number(maxAge):expires!==undefined?(Date.parse(expires)-Date.now())/1000:300;
 if(!attributes.has('httponly')||!attributes.has('secure')||
    (cookieDomain&&cookieDomain.replace(/^\./,'').toLowerCase()!==hostname)||
    (attributes.has('path')&&attributes.get('path')!=='/')||
    (maxAge!==undefined&&!/^\d+$/.test(maxAge))||
    !Number.isFinite(ttl)||ttl<90)throw new PreviewAccessUnavailable();
 return[{name:'_vercel_jwt',value:jwt,domain:hostname,path:'/',httpOnly:true,secure:true,sameSite:'Lax',expires:Math.floor(Date.now()/1000)+Math.min(300,Math.floor(ttl))}];
}
export async function verifyDeployedPreview(preview:{url:string;headSha:string;deploymentId:number;statusId:number},contract:BrowserContract,projectId:string,request:typeof fetch=fetch,run=runScenarios){
 // Validate the contract before any credential minting or network request.
 // An absolute contract.path would otherwise redirect cookie-bearing fetch off-origin.
 browserContract.parse(contract);
 const safe=immutablePreviewUrl(preview.url);if(!safe)throw Error('Verified immutable Vercel Preview origin required');const origin=new URL(safe).origin;
 const cookies=await previewCookies(origin,request);
 const check=await request(new URL(contract.path,origin),{headers:cookies.length?{cookie:'_vercel_jwt='+cookies[0].value}:{},redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(10000)});await check.body?.cancel();
 if([401,403].includes(check.status)||check.status>=300&&check.status<400&&(!check.headers.get('location')||!samePreviewOrigin(check.headers.get('location')!,origin)))throw new PreviewAccessUnavailable();
 const checks=await run(contract,origin,{deployed:true,cookies,timeout:75000});
 return{version:1,projectId,contractHash:digest(contract),headSha:preview.headSha,deploymentId:preview.deploymentId,statusId:preview.statusId,url:new URL(contract.path,origin).href,checkedAt:new Date().toISOString(),passed:checks.length===contract.scenarios.length&&checks.every((c,i)=>c.passed&&c.name===contract.scenarios[i].name),checks};
}
