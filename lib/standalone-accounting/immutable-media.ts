/** Freeze the application's own stored image bytes before quoting. Arbitrary
 * external URLs remain unsupported; never forward credentials or follow redirects. */
export async function freezeStoredImages(payload:Record<string,unknown>,transport:typeof fetch=fetch):Promise<Record<string,unknown>>{
 const copy=JSON.parse(JSON.stringify(payload)) as Record<string,unknown>;
 const base=process.env.NEXT_PUBLIC_SUPABASE_URL;
 const trusted=base?new URL(base):null;
 async function inline(value:unknown):Promise<unknown>{
  if(typeof value!=='string'||!value.startsWith('https:')||!trusted)return value;
  const url=new URL(value);
  if(url.origin!==trusted.origin||url.username||url.password||!/^\/storage\/v1\/object\/(?:public|sign)\//.test(url.pathname))return value;
  const response=await transport(url,{redirect:'error',signal:AbortSignal.timeout(15000),cache:'no-store'});
  const mime=response.headers.get('content-type')?.split(';')[0].toLowerCase();
  if(!response.ok||!mime||!['image/png','image/jpeg','image/gif','image/webp'].includes(mime)||!response.body)throw Object.assign(new Error('Stored image could not be frozen for spending approval.'),{code:'standalone_image_unavailable'});
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>20*1024*1024)throw Error('Stored image exceeds 20 MiB accounting limit');chunks.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw Object.assign(new Error('Stored image could not be frozen for spending approval.',{cause:error}),{code:'standalone_image_unavailable'});}
  return `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`;
 }
 async function walk(value:unknown):Promise<void>{
  if(Array.isArray(value)){for(const entry of value)await walk(entry);return;}
  if(!value||typeof value!=='object')return;const part=value as Record<string,unknown>;
  if(part.type==='image_url'||part.type==='input_image'){
   if(typeof part.image_url==='string')part.image_url=await inline(part.image_url);
   else if(part.image_url&&typeof part.image_url==='object'){const image=part.image_url as Record<string,unknown>;image.url=await inline(image.url);}
  }else if(part.type==='image'&&part.source&&typeof part.source==='object'){
   const source=part.source as Record<string,unknown>;
   if(source.type==='url'){const image=await inline(source.url);if(typeof image==='string'&&image.startsWith('data:')){const [,mime,data]=/^data:([^;]+);base64,(.*)$/.exec(image)!;part.source={type:'base64',media_type:mime,data};}}
  }
  for(const child of Object.values(part))await walk(child);
 }
 await walk(copy);return copy;
}
