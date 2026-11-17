import { buildImageReference, imageFileFromDataUrl, MAX_IMAGE_BYTES } from './image-reference';
import { persistGeneratedImage, readGeneratedImage } from './stored-uploads';
import { GeneratedImageUnavailable } from './generated-image-store';
import { generatedImageId, type GeneratedImageBinding, type ImageAsset, type ImageParent } from '@/lib/images/generated-source';
import type { ConversationAttachment } from '@/lib/chat/attachment-continuity';
import type { Message } from '@/lib/types/chat';

/** Only provider-returned/saved assistant assets may reach this loader. Never
 * accept a URL supplied in a user message as generated-image provenance. */
export async function generatedImageBytes(url:string,transport:typeof fetch=fetch):Promise<File> {
  if (url.startsWith('data:')) return imageFileFromDataUrl(url,'generated-image');
  let target:URL;
  try { target = new URL(url); } catch { throw new GeneratedImageUnavailable(); }
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const ownStorage = supabase && target.origin === new URL(supabase).origin &&
    /^\/storage\/v1\/object\/(?:sign|public)\//.test(target.pathname);
  // Existing adapters use inline bytes or these provider-owned image hosts.
  // No redirects, user-controlled hosts, credentials or arbitrary URL fetches.
  const providerHost = target.hostname === 'imgen.x.ai' ||
    target.hostname === 'oaidalleapiprodscus.blob.core.windows.net';
  if (target.protocol !== 'https:' || target.username || target.password || target.port || (!ownStorage && !providerHost))
    throw new GeneratedImageUnavailable('The saved generated-image URL cannot be safely reopened.');
  let response:Response;
  try { response = await transport(target,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)}); }
  catch { throw new GeneratedImageUnavailable('The original generated-image link is no longer accessible.'); }
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!response.ok || !mime || !['image/png','image/jpeg','image/webp','image/gif'].includes(mime) || !response.body) {
    await response.body?.cancel();
    throw new GeneratedImageUnavailable('The original generated-image link is unavailable or did not return an image.');
  }
  if (Number(response.headers.get('content-length') ?? 0)>MAX_IMAGE_BYTES) {
    await response.body.cancel(); throw new GeneratedImageUnavailable('Generated image exceeds the retained-source size limit.');
  }
  const reader = response.body.getReader(), chunks:Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.byteLength; if (size>MAX_IMAGE_BYTES) throw new GeneratedImageUnavailable('Generated image exceeds the retained-source size limit.');
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(()=>{});
    throw new GeneratedImageUnavailable('The generated-image original could not be retained completely.');
  }
  if (!size) throw new GeneratedImageUnavailable();
  return new File([Buffer.concat(chunks)],'generated-image',{type:mime});
}

type Dependencies = {
  load: typeof generatedImageBytes;
  build: typeof buildImageReference;
  persist: typeof persistGeneratedImage;
  read: typeof readGeneratedImage;
};
const defaults:Dependencies = {load:generatedImageBytes,build:buildImageReference,persist:persistGeneratedImage,read:readGeneratedImage};
export function createGeneratedImageService(overrides:Partial<Dependencies>={}) {
  const deps={...defaults,...overrides};
  async function retain(asset:ImageAsset,binding:GeneratedImageBinding):Promise<{asset:ImageAsset;attachment:ConversationAttachment}> {
    const id=generatedImageId(binding);
    // Recovery must prefer the retained original, even if a provider URL expired.
    // read() verifies actual source bytes and canonical provenance.
    try {
      const saved=await deps.read(binding.actorId,binding.chatId,id);
      const g=saved.descriptor.generatedSource!;
      if (g.messageId!==binding.messageId || g.imageIndex!==binding.imageIndex ||
        g.model!==binding.model || g.requestId!==binding.requestId)
        throw new GeneratedImageUnavailable('Generated-image output identity conflicts with the saved source.');
      await deps.persist(saved.reference,saved.source,binding); // Repair a partial catalog write on replay.
      const original=`data:${saved.descriptor.mimeType};base64,${Buffer.from(await saved.source.arrayBuffer()).toString('base64')}`;
      return {attachment:saved.descriptor,asset:{type:'image',url:original,attachmentId:id,
        sourceChatId:binding.chatId,sourceMessageId:binding.messageId,sourceHash:g.sourceHash}};
    } catch (error) {
      // A missing record can be a crash before registration. Other mismatches
      // are checked again by immutable persistence; nothing is overwritten.
      if (!(error instanceof GeneratedImageUnavailable)) throw error;
    }
    const bytes=await deps.load(asset.url);
    const extension=bytes.type==='image/jpeg'?'jpg':bytes.type.slice('image/'.length);
    const name=`generated-${binding.messageId}-${binding.imageIndex+1}.${extension}`;
    const reference=await deps.build(new File([bytes],name,{type:bytes.type}));
    reference.fileId=id;
    const attachment=await deps.persist(reference,bytes,binding);
    const original=`data:${bytes.type};base64,${Buffer.from(await bytes.arrayBuffer()).toString('base64')}`;
    return {attachment,asset:{type:'image',url:original,attachmentId:attachment.id,
      sourceChatId:binding.chatId,sourceMessageId:binding.messageId,sourceHash:attachment.generatedSource!.sourceHash}};
  }
  return {
    async retainResult(input:{actorId:string;chatId:string;messageId:string;requestId:string;
      createdAt:string;provider:string;model:string;assets:ImageAsset[];parents?:ImageParent[]}) {
      if (input.assets.length>5) throw new GeneratedImageUnavailable('Choose no more than five generated images.');
      const retained=[];
      for (const [imageIndex,asset] of input.assets.entries()) {
        retained.push(await retain(asset,{actorId:input.actorId,chatId:input.chatId,messageId:input.messageId,
          requestId:input.requestId,createdAt:input.createdAt,provider:input.provider,model:input.model,
          imageIndex,parents:input.parents??[],registration:'generation-result'}));
      }
      return {assets:retained.map(r=>r.asset),attachments:retained.map(r=>r.attachment)};
    },
    async registerLegacy(actorId:string,chatId:string,message:Message,index:number):Promise<ConversationAttachment> {
      // message MUST come from the authorized current chat, never from payload text.
      const asset=message.assets?.[index];
      if (message.chatId!==chatId || message.role!=='assistant' || !asset || asset.type!=='image' || !message.model)
        throw new GeneratedImageUnavailable('The selected assistant image source could not be verified.');
      if (asset.attachmentId) {
        const saved=await deps.read(actorId,chatId,asset.attachmentId);
        if (saved.descriptor.generatedSource?.messageId!==message.id || saved.descriptor.generatedSource.imageIndex!==index)
          throw new GeneratedImageUnavailable('Saved image asset and attachment identities differ.');
        return saved.descriptor;
      }
      // No invented original request/provider receipt for historical assets.
      return (await retain(asset,{actorId,chatId,messageId:message.id,requestId:null,
        createdAt:message.createdAt,provider:null,model:message.model,imageIndex:index,
        parents:[],registration:'legacy-assistant-asset'})).attachment;
    },
  };
}
export const generatedImageService = () => createGeneratedImageService();
