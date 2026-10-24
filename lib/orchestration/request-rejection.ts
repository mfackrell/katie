/** Only explicit HTTP rejections prove that generation never started. Transport
 * failures, aborts, 408/5xx and incomplete model responses retain their holds. */
export function rejectedBeforeInference(error:unknown){
 if(!error||typeof error!=='object')return false;
 const e=error as {status?:unknown;code?:unknown;error?:{code?:unknown};message?:unknown};
 const status=e.status;
 if([401,402,403,404,413,422,429].includes(Number(status)))return true;
 if(status!==400)return false;
 const code=String(e.code??e.error?.code??'');
 const message=String(e.message??'');
 return /invalid_request|invalid_argument|unsupported|bad_request/i.test(code)||/unsupported|invalid json payload|only supports .*api|credit balance|not supported/i.test(message);
}
export function boundedModelSupported(provider:string,model:string){
 if(/audio|realtime|transcrib|whisper|(?:^|[-_])tts(?:[-_]|$)|embedding|moderation|image|imagine|sora|lyria|nano-banana|computer-use|robotics/i.test(model))return false;
 // These long-running reasoning/research variants need a resumable background
 // response adapter. A synchronous 90-second call cannot safely provide that
 // capability; an observed GPT-5 Pro timeout retained an uncertain reservation.
 // This filter applies only to bounded orchestration, never ordinary chat.
 if(provider==='openai'&&/^(?:gpt-5(?:\.\d+)?-pro|o[13]-pro|o[34](?:-mini)?-deep-research)(?:-|$)/i.test(model))return false;
 // These are agent jobs served only by Interactions, not generateContent.
 return !(provider==='google'&&/^deep-research(?:-|$)/i.test(model.replace(/^models\//,'')));
}
