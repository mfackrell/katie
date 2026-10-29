import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {accountingError,accountingScope,noStore,scopeSchema} from '../_shared';
export async function GET(request:NextRequest){
 try{
 const input=scopeSchema.extend({scope:z.enum(['this-agent','all']).default('this-agent'),before:z.string().datetime({offset:true}).optional(),beforeId:z.string().uuid().optional()}).parse(Object.fromEntries(request.nextUrl.searchParams));
 if(Boolean(input.before)!==Boolean(input.beforeId))return NextResponse.json({error:'Both cursor fields are required.'},{status:400,headers:noStore});
 const {ownerId,ledger}=await accountingScope(request,input);
 const attempts=await ledger.recentActivity(ownerId,input.scope==='all'?null:input.actorId,input.before??null,input.beforeId??null);
 const last=attempts.length===25?attempts[attempts.length-1]:null;
 return NextResponse.json({attempts,next:last?{before:last.created_at,beforeId:last.id}:null},{headers:noStore});
 }catch(error){return accountingError(error);}
}
