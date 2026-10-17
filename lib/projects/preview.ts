import {runScenarios,type PreviewCookie} from '../../scripts/project-browser-engine.mjs';
import {verifiedPreviewUrl} from '@/lib/agents/development';
import {digest} from './contract';
import type {BrowserContract} from './store';
export class PreviewAccessUnavailable extends Error {constructor(){super('Deployed Preview requires authentication. Configure the production-only preview acceptance connection, then resume this project. Deployment protection remains enabled.');this.name='PreviewAccessUnavailable';}}
// Only Vercel's edge sees the automation secret. Its manual redirect mints an
// HttpOnly cookie restricted to this exact deployment URL; application requests
// and the browser never receive the project-wide secret or a trusted OIDC token.
export async function previewCookies(origin:string,request:typeof fetch=fetch):Promise<PreviewCookie[]>{
 if(!verifiedPreviewUrl(origin)||new URL(origin).origin!==origin)throw Error('Exact verified Vercel origin required');
 const secret=process.env.PROJECT_PREVIEW_BYPASS_SECRET;if(!secret)return[];
 const rule=process.env.PROJECT_PREVIEW_HOST_PATTERN;if(!rule||!rule.startsWith('^')||!rule.endsWith('$')||!new RegExp(rule).test(new URL(origin).hostname))throw new PreviewAccessUnavailable();
 const response=await request(origin+'/',{headers:{'x-vercel-protection-bypass':secret,'x-vercel-set-bypass-cookie':'true'},redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(10000)});
 await response.body?.cancel();
 const set=response.headers.get('set-cookie')??'',jwt=/(?:^|,\s*)_vercel_jwt=([^;\s,]+)/.exec(set)?.[1];
 if(response.status<300||response.status>=400||!jwt||!/(?:^|;)\s*HttpOnly(?:;|$)/i.test(set)||!/(?:^|;)\s*Secure(?:;|$)/i.test(set))throw new PreviewAccessUnavailable();
 return[{name:'_vercel_jwt',value:jwt,domain:new URL(origin).hostname,path:'/',httpOnly:true,secure:true,sameSite:'Lax',expires:Math.floor(Date.now()/1000)+300}];
}
export async function verifyDeployedPreview(preview:{url:string;headSha:string;deploymentId:number;statusId:number},contract:BrowserContract,projectId:string,request:typeof fetch=fetch,run=runScenarios){
 const safe=verifiedPreviewUrl(preview.url);if(!safe)throw Error('Verified Vercel Preview origin required');const origin=new URL(safe).origin;
 const cookies=await previewCookies(origin,request);
 const check=await request(new URL(contract.path,origin),{headers:cookies.length?{cookie:'_vercel_jwt='+cookies[0].value}:{},redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(10000)});await check.body?.cancel();
 if([401,403].includes(check.status)||check.status>=300&&check.status<400&&check.headers.get('location')?.includes('vercel.com/'))throw new PreviewAccessUnavailable();
 const checks=await run(contract,origin,{deployed:true,cookies,timeout:75000});
 return{version:1,projectId,contractHash:digest(contract),headSha:preview.headSha,deploymentId:preview.deploymentId,statusId:preview.statusId,url:new URL(contract.path,origin).href,checkedAt:new Date().toISOString(),passed:checks.length===contract.scenarios.length&&checks.every((c,i)=>c.passed&&c.name===contract.scenarios[i].name),checks};
}
