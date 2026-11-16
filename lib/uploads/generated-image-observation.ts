import { createHash } from 'node:crypto';
import type { ConversationAttachment } from '@/lib/chat/attachment-continuity';
import type { FileReference } from '@/lib/providers/types';
import { verifiedKatieVisualEpisode } from '@/lib/chat/visual-memory';
import { cachedWorkflowValue } from '@/lib/standalone-accounting/workflow';
import { readGeneratedImage, updateSavedImageObservation, withGeneratedImageObservation } from './stored-uploads';
import { observeStandaloneStillImages, reusableImageObservation, imageObservationHash,
  STILL_IMAGE_OBSERVATION_VERSION, type ImageObservation } from './still-image-observations';

export const generalGeneratedImageQuestion = (question:string):boolean =>
  /^(?:what do you think(?: of (?:it|this|that))?|(?:please )?describe (?:it|this|that|the (?:image|picture)(?: you (?:just )?(?:made|created|generated))?)|does (?:this|that|it) look (?:natural|real|good)|how does (?:it|this|that) look|is (?:it|this|that) (?:natural|realistic|attractive))[?!. ]*$/i.test(question.trim());

type Result = {observation:ImageObservation;descriptor:ConversationAttachment};
export function createGeneratedImageObserver(deps:{
  read:typeof readGeneratedImage;
  update:typeof updateSavedImageObservation;
  claim:typeof withGeneratedImageObservation;
  observe:typeof observeStandaloneStillImages;
  checkpoint:typeof cachedWorkflowValue;
}={read:readGeneratedImage,update:updateSavedImageObservation,claim:withGeneratedImageObservation,
  observe:observeStandaloneStillImages,checkpoint:cachedWorkflowValue}) {
  return async (input:{actorId:string;chatId:string;requestId:string;attachment:ConversationAttachment;
    reference:FileReference;question:string;onStatus?:(stage:string)=>void}):Promise<Result> => {
    const sourceChatId=input.attachment.chatId!;
    if (input.attachment.actorId!==input.actorId || sourceChatId!==input.chatId)
      throw Error('Generated-image inspection is not authorized for this conversation.');
    const latest=await deps.read(input.actorId,sourceChatId,input.attachment.id);
    if (latest.reference.imageDataUrl!==input.reference.imageDataUrl)
      throw Error('Generated-image rendering changed before observation.');
    const keyQuestion=generalGeneratedImageQuestion(input.question)?'':input.question.trim();
    const reinspection=/\b(?:reinspect|reopen|look.{0,40}again|inspect.{0,40}again|look closer)\b/i.test(input.question);
    const sourceHash=imageObservationHash(input.reference.imageDataUrl!);
    const prior=reusableImageObservation(input.reference,[latest.descriptor],keyQuestion);
    if (!reinspection && prior && verifiedKatieVisualEpisode(latest.descriptor)?.sourceHash===sourceHash &&
      latest.descriptor.summaryCoverage==='full' &&
      (keyQuestion==='' || latest.descriptor.observationQuestion===keyQuestion))
      return {observation:prior,descriptor:latest.descriptor};
    const key=STILL_IMAGE_OBSERVATION_VERSION+':'+createHash('sha256').update(keyQuestion).digest('hex')+
      (reinspection ? ':requested-reinspection:'+input.requestId : '');
    // Claims coordinate different requests. Checkpoints coordinate replay of
    // this request's provider accounting ordinal and completed inspection.
    return deps.checkpoint(`generated-observation:${input.attachment.id}:${key}`,()=>deps.claim({
      actorId:input.actorId,chatId:sourceChatId,id:input.attachment.id,requestId:input.requestId,key,
    },async()=>{
      const result=await deps.observe([input.reference],{question:keyQuestion,
        // Relevance was checked above. Supplying the old summary here would
        // let the generic observer reuse it for a NEW uncovered question.
        saved:[],onStatus:input.onStatus});
      const observation=result.get(input.reference.fileId);
      if (!observation || observation.observationSourceHash!==sourceHash)
        throw Error('Generated-image inspection returned no source-bound evidence.');
      const descriptor=await deps.update(sourceChatId,latest.descriptor,input.actorId,observation);
      return {observation,descriptor};
    }));
  };
}
export const observeGeneratedImage = createGeneratedImageObserver();
