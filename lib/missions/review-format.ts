// Transport schemas constrain syntax; the independent review validators still
// enforce source citations, every acceptance ID, and the substantive verdict.
const string={type:'string'};
const strings={type:'array',items:string};
const object=(properties:Record<string,unknown>)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const nullable=(schema:unknown)=>({anyOf:[schema,{type:'null'}]});
const citation=object({sourceId:string});
const assessment=object({
 objective:string,qualifications:strings,strongestEvidence:strings,criteria:strings,
 synthesis:object({conclusion:string,dimensions:{type:'array',items:object({dimension:string,supportedScope:string,evidence:strings})},emphasis:string}),
 taskContract:object({deliverable:string,requirements:{type:'array',items:object({id:string,requirement:string,sourceId:string,status:{type:'string',enum:['active','superseded']},supersededBy:nullable(citation)})},conflicts:{type:'array',items:object({sourceIds:strings,resolution:string})}}),
});
const comparison=object({verdict:{type:'string',enum:['approve','revise']},findings:string,optionalSuggestions:string,checks:{type:'array',items:object({id:string,passed:{type:'boolean'},evidence:string})},clarification:nullable(object({question:string,missingFact:string,essential:{type:'boolean'}}))});
const source=object({verdict:{type:'string',enum:['pass','changes_requested','blocked']},findings:strings,summary:string});
export type ReviewFormat='assessment'|'comparison'|'source';
export function missionReviewFormat(phase:ReviewFormat){return{type:'json_schema' as const,name:'mission_review_'+phase,strict:true,schema:{assessment,comparison,source}[phase]};}
