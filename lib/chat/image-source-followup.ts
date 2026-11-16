import type { Message } from '@/lib/types/chat';
import type { ConversationAttachment } from './attachment-continuity';
import type { AttachmentDecision } from './attachment-selection';

export type ImageSourcePin = {messageId:string;assetIndex:number};
type Candidate = {message:Message;index:number;attachment?:ConversationAttachment;legacy:boolean};
export type ImageSourceChoice = {candidates:Candidate[];clarification?:string;operation:'inspect'|'edit'};
const edit=/\b(?:change|edit|modify|retouch|crop|recolou?r|replace|remove|add|fix)\b.{0,90}\b(?:shirt|clothes|clothing|dress|background|hair|eyes|face|lighting|colour|color|hat|jacket|image|picture|photo|it)\b|\bmake (?:it|this|that|her|him) (?:more|less|look)\b/i;
export function imageFollowupIntent(text:string):'inspect'|'edit'|null {
  const s=text.trim();
  if (!s || s.length>900 || /\b(?:new topic|unrelated|switch topics?|ignore (?:the|this|that) image)\b/i.test(s)) return null;
  if (edit.test(s)) return 'edit';
  if (/\b(?:image|picture|photo|portrait|render|version)\b/.test(s.toLowerCase()) &&
    /\b(?:you (?:just )?(?:made|created|generated)|describe|inspect|look|use|same|first|second|third|fourth|fifth|original|previous|earlier|that|this|these|those)\b/i.test(s)) return 'inspect';
  if (/^(?:so[, ]+)?(?:what do you think of (?:it|this|that)|how does (?:it|this|that) look|does (?:this|that|it) look (?:natural|real|good)|look (?:at it )?again|is (?:it|this|that) (?:natural|realistic|attractive)|use the (?:first|second|third|fourth|fifth)(?: one| version)?)[?!. ]*$/i.test(s)) return 'inspect';
  return null;
}
function groups(history:Message[],catalog:ConversationAttachment[],actorId:string,chatId:string):Candidate[][] {
  return history.filter(m=>m.chatId===chatId).map(message=> {
    if (message.role==='assistant' && message.assets?.some(a=>a.type==='image')) {
      return message.assets.flatMap((asset,index):Candidate[] => {
        if (asset.type!=='image') return [];
        const attachment=catalog.find(f=>f.actorId===actorId && f.chatId===chatId &&
          f.generatedSource?.messageId===message.id && f.generatedSource.imageIndex===index &&
          (!asset.attachmentId || f.id===asset.attachmentId));
        return [{message,index,attachment,legacy:!attachment}];
      });
    }
    if (message.role!=='user') return [];
    return (message.attachments??[]).flatMap((a,index):Candidate[] => {
      if (!a.mimeType.startsWith('image/') || !['uploaded','explicit-reference'].includes(a.conversationUsage??'') ||
        (a.actorId && a.actorId!==actorId) || (a.chatId && a.chatId!==chatId)) return [];
      const attachment=catalog.find(f=>f.id===a.id && f.actorId===actorId && f.chatId===chatId);
      return [{message,index,attachment,legacy:false}];
    });
  }).filter(g=>g.length);
}
/** No semantic-model guess or global last-image slot. All choices point back
 * to exact source messages and output indices in this authorized chat. */
export function chooseImageFollowup(input:{message:string;history:Message[];catalog:ConversationAttachment[];
  actorId:string;chatId:string;freshCount:number;pin?:ImageSourcePin}):ImageSourceChoice|null {
  const operation=imageFollowupIntent(input.message);
  if (!input.pin && (!operation || input.freshCount)) return null;
  const all=groups(input.history,input.catalog,input.actorId,input.chatId);
  const clarify=(message:string):ImageSourceChoice=>({candidates:[],clarification:message,operation:operation??'inspect'});
  if (input.pin) {
    const source=all.flat().find(c=>c.message.id===input.pin!.messageId && c.index===input.pin!.assetIndex);
    return source?{candidates:[source],operation:operation??'inspect'}:clarify('That image is not available in this conversation. Select its saved image message.');
  }
  if (!all.length) return null;
  const named=all.flat().filter(c=>c.attachment && input.message.toLowerCase().includes(c.attachment.fileName.toLowerCase()));
  if (named.length) return named.length===1?{candidates:named,operation:operation!}:clarify('Which saved image message should I use?');
  let group=all.at(-1)!;
  const explicitGenerated=/\b(?:image|picture|photo)\b.{0,40}\byou (?:just )?(?:made|created|generated)\b/i.test(input.message);
  if (explicitGenerated) {
    const generated=all.filter(g=>g[0].message.role==='assistant');
    if (!generated.length) return clarify('Which image I generated should I use?');
    group=generated.at(-1)!;
    if (group!==all.at(-1) && /\b(?:it|this|that)\b/i.test(input.message))
      return clarify('Do you mean the image I generated or the image you uploaded afterward?');
  }
  const position=input.history.indexOf(group[0].message);
  const intervening=input.history.slice(position+1).filter(m=>m.role==='user');
  const explicitlyVisual=/\b(?:image|picture|photo|version|portrait)\b/i.test(input.message);
  if (!explicitlyVisual && intervening.some(m=>!imageFollowupIntent(m.content))) return null;
  if (/\b(?:compare|both|all|each)\b/i.test(input.message))
    return clarify('Which exact images should I compare? Select their saved image messages.');
  const ord=input.message.match(/\b(first|second|third|fourth|fifth|original|previous)\b/i)?.[1]?.toLowerCase();
  if (ord) {
    const index=['first','second','third','fourth','fifth'].indexOf(ord);
    if (group.length>1 && index>=0) return group[index]
      ? {candidates:[group[index]],operation:operation!} : clarify('That image number is not in this generated set. Which image should I use?');
    // A version means the current image's actual edit lineage, never unrelated
    // older images that happen to be present in the same conversation.
    const current=group[0], lineage:Candidate[]=[current], seen=new Set<string>();
    let cursor=current.attachment;
    while(cursor?.generatedSource?.parents.length===1) {
      const parent=cursor.generatedSource.parents[0];
      if(parent.sourceChatId!==input.chatId || seen.has(parent.attachmentId)) break;
      seen.add(parent.attachmentId);
      const found=all.flat().find(c=>c.attachment?.id===parent.attachmentId);
      if(!found) break;
      lineage.unshift(found);cursor=found.attachment;
    }
    const chosen=ord==='original'?lineage[0]:ord==='previous'?lineage.at(-2):lineage[index];
    if (!chosen || (lineage.length===1 && index>0)) return clarify('I cannot identify that version from the saved image lineage. Select the image message.');
    return {candidates:[chosen],operation:operation!};
  }
  if (group.length!==1) return clarify(`There are ${group.length} images in that message. Which one should I inspect or edit?`);
  return {candidates:group,operation:operation!};
}
export async function resolveImageFollowup(input:Parameters<typeof chooseImageFollowup>[0],deps:{
  registerLegacy:(message:Message,index:number)=>Promise<ConversationAttachment>;
  read:(attachment:ConversationAttachment)=>Promise<ConversationAttachment>;
}):Promise<(AttachmentDecision & {operation:'inspect'|'edit'})|null> {
  const choice=chooseImageFollowup(input);
  if (!choice) return null;
  if (choice.clarification) return {method:'none',selections:[],clarification:choice.clarification,operation:choice.operation};
  const selected:ConversationAttachment[]=[];
  for (const c of choice.candidates) {
    try {
      const attachment=c.legacy ? await deps.registerLegacy(c.message,c.index) : c.attachment ? await deps.read(c.attachment) : null;
      if (!attachment || attachment.actorId!==input.actorId || attachment.chatId!==input.chatId) throw Error('source unavailable');
      selected.push(attachment);
    } catch {
      return {method:'none',selections:[],operation:choice.operation,
        clarification:'I found the saved image message, but its original cannot be reopened right now. I cannot inspect or edit missing pixels; no replacement image was selected.'};
    }
  }
  return {method:'continuity',selections:selected.map(attachment=>({attachment,mode:'source'})),operation:choice.operation,
    rationale:'Exact image source message and asset index in the authorized conversation'};
}
