import type {LlmProvider} from '@/lib/providers/types';

// This executor uses synchronous Responses/messages/generateContent calls.
// Google's Deep Research agents require the Interactions API and a durable
// background lifecycle; they cannot execute on this transport. Keep them in
// the shared registry for compatible executors, but never reserve here.
export function supportsBoundedModel(provider:LlmProvider['name'],modelId:string){
 return !(provider==='google'&&/(?:^|[-/])deep-research(?:-|$)/i.test(modelId.replace(/^models\//,'')));
}
