/** Deterministic reconciliation of *textual* vision reports. No additional
 * provider call, no inference about pixels, and no hallucination scoring.
 * Unknown subject identity is never treated as agreement.
 */
export type ImageReportCoverage = 'full'|'sampled'|'metadata';
export type ImageAgreement = 'single'|'corroborated'|'conflict'|'unverified'|'policy-limited';
export interface ImageModelReport {
  model:string;
  sourceHash:string;
  text:string;
  coverage:ImageReportCoverage;
  disposition:'observation'|'policy-limited'|'unavailable';
}
type Reconciliation={text:string;agreement:ImageAgreement;coverage:ImageReportCoverage;limitations:string[];model:string};

const attributes=new Set([
  'a','an','the','and','or','of','is','are','was','were','its','it','this','that',
  'with','own','his','her','their','person','persons','people','human','visible',
  'primary','principal','main','central','focal','point','subject','image','photo',
  'photograph','picture','shows','showing','depicts','features','contains','appears',
  'close','up','view','perspective','first','foreground','background','object','thing',
  'item','scene','section','part','some','large','small','big','tiny','long','short',
  'dark','light','black','white','blue','green','red','brown','grey','gray','pink',
  'yellow','orange','purple','bright','pale','colored','coloured','color','colour',
  'glossy','matte','ceramic','wooden','plastic','metal','textured','clear','distinct',
  'erect','adult','young','older','aged','slightly','rounded','curved','plain',
  'nearby','center','centre','front','right','left','upper','lower','diagonal'
]);
const aliases:Record<string,string>={
  canine:'dog',puppy:'dog',feline:'cat',kitty:'cat',mug:'cup',
  smartphone:'phone',cellphone:'phone',automobile:'car',motorcar:'car',
  bicycle:'bike',cycle:'bike',television:'tv',
  genitalia:'genitals',genital:'genitals'
};

/** A focal clause is only a *claimed* subject, never independent verification. */
export function reportedFocalSubject(text:string):string|null {
  const s=text.replace(/\s+/g,' ').trim();
  const focal=/\b(?:primary|principal|main|central)\s+(?:visible\s+)?(?:focal\s+point|subject)(?:\s+of\s+(?:the|this)\s+(?:image|photo|photograph|picture))?\s*(?:is|:|shows?)\s*/i.exec(s);
  const imageClauses=[...s.matchAll(/\b(?:image|photo|photograph|picture)\b.{0,48}?\b(?:shows?|depicts?|features?|contains?)\s*/gi)];
  // A negative OCR/discovery preamble ("image does not contain text") is
  // not a claim about what the primary pictured subject actually is.
  const affirmative=imageClauses.find(match=>!/(?:\b(?:not|no|never|cannot|without|isn't|doesn't)\b|\bdoes\s+not\b)/i.test(match[0])&&
    !/^(?:no|any|unreadable|illegible)\b/i.test(s.slice(match.index!+match[0].length).trim()));
  const anchor=focal??affirmative??null;
  // Short Qwen observations commonly start "A cup on a table" without labels.
  // Only their first sentence can supply a fallback claimed subject.
  const shortUnlabelled=!anchor&&s.length<240&&
    /^(?:a|an|the)\s+(?!(?:image|picture|photo|photograph|scene|frame|text|words|letters|writing|subject|detail|contents?)\b)/i.test(s)&&
    !/\b(?:illegible|blurry|uncertain|unclear|unreadable|undiscernible|unrecognizable|unidentified|cannot|unable|indistinct|not visible|too small)\b/i.test(s);
  if(!anchor&&!shortUnlabelled)return null;
  let clause=anchor?s.slice(anchor.index+anchor[0].length,anchor.index+anchor[0].length+185):s.slice(0,185);
  clause=clause.split(/[.!?;:]/)[0];
  clause=clause.replace(/^(?:a|an|the)\s+(?:close[- ]up\s+(?:of|view|perspective)\s+(?:of\s+)?|first[- ]person\s+perspective\s+of\s+)+/i,'');
  clause=clause.replace(/^\s*(?:a|an|the|this|one|some)\s+/i,'');
  clause=clause.split(/\b(?:holding|wearing|standing|sitting|resting|lying|positioned|located|occupying|occupies|extending|extends|surrounded|against|alongside|near|beside|behind|under|above|with|on|at|in|while|which|that|whose)\b/i)[0];
  const tokens=(clause.toLowerCase().match(/[a-z]+/g)??[])
    .map(w=>aliases[w]??w).filter(w=>w.length>2&&!attributes.has(w));
  if(!tokens.length)return null;
  // Two words allow e.g. 'coffee cup' and 'golden retriever' to share a noun.
  return [...new Set(tokens.slice(-3))].join(' ');
}
function focalTerms(text:string):Set<string>{
  return new Set((reportedFocalSubject(text)??'').split(' ').filter(Boolean));
}
export function visualReportsAgree(primary:string,secondary:string):boolean|null {
  const a=focalTerms(primary),b=focalTerms(secondary);
  if(!a.size||!b.size)return null;
  for(const word of a)if(b.has(word))return true;
  return false;
}

/** A policy-limited reply may still contain a neutral first-hand observation.
 * Keep factual lines only. Never convert a refusal into authority to send a
 * second model or to generate content the first model declined.
 */
export function isPolicyLimitedVisionResponse(text:string):boolean {
  return /\b(?:cannot fulfill this request|cannot (?:generate|describe) (?:sexually explicit|explicit)|content policy|safety (?:policy|guidelines|restrictions)|policy (?:prohibits|does not allow|restriction)|not (?:appropriate|permitted) for this platform|cannot comply with this request)\b/i.test(text);
}
export function neutralFactsFromPolicyLimitedReply(text:string):string|null {
  const sentences=text.replace(/\r/g,'').split(/(?<=[.!?])\s+|\n+/).map(x=>x.trim()).filter(Boolean);
  const facts=sentences.filter(line=>
    /\b(?:image|photo|photograph|picture)\b.{0,90}\b(?:shows?|depicts?|features?|contains?)\b/i.test(line)||
    /\b(?:primary|principal|main|central)\s+(?:focal\s+point|subject)\s*(?:is|:)\s*/i.test(line)
  ).filter(line=>!/\b(?:cannot|can't|must refuse|not appropriate|policy|guidelines)\b/i.test(line));
  return facts.length ? facts.slice(0,3).join(' ').slice(0,1200) : null;
}

export function reconcileImageReports(primary:ImageModelReport,secondary:ImageModelReport):Reconciliation {
  // Caller must compute this from the unchanged base64 pixels for each report.
  if(!primary.sourceHash || primary.sourceHash!==secondary.sourceHash)
    throw new Error('Different source image identities cannot be reconciled.');
  if(primary.disposition==='policy-limited')
    return {text:primary.text,agreement:'policy-limited',coverage:'sampled',
      limitations:['Primary model declined detailed analysis; no fallback was authorized by that refusal.'],
      model:primary.model};
  const first=primary.text.trim(),second=secondary.text.trim();
  const matched=visualReportsAgree(first,second);
  if(matched===false){
    return {text:first,agreement:'conflict',coverage:primary.coverage,model:primary.model,
      limitations:['Visual-model disagreement about the primary subject. The secondary model report was retained separately but EXCLUDED from conversational facts. Neither report is independently pixel-verified.']};
  }
  if(matched===true){
    return {text:('Primary model observation:\n'+first+
      '\n\nSecondary model details (same reported principal subject; secondary details are not independently verified):\n'+second).slice(0,20000),
      agreement:'corroborated',coverage:primary.coverage==='full'&&secondary.coverage==='full'?'full':'sampled',
      model:primary.model+' + '+secondary.model,
      limitations:['Models agree on a named subject; other visual details are still unverified observations.']};
  }
  if(focalTerms(first).size){
    return {text:first,agreement:'unverified',coverage:primary.coverage,model:primary.model,
      limitations:['The secondary model supplied no independently comparable principal-subject claim. Its report was retained separately, not merged.']};
  }
  return {text:second,agreement:'unverified',coverage:secondary.coverage,model:secondary.model,
    limitations:['Primary model did not identify a verifiable focal subject; the secondary model is the only source of the detailed observation.']};
}