// Only an explicitly bounded primary deliverable is measured against a cap.
// A limit on an executive summary or other subsection stays section-specific.
export function measureDeliverable(objective:string,text:string){
 const bounds=[...objective.matchAll(/(?:^|[.!?]\s+)(?:deliver|return|write|produce|give|provide)\s+(?:a |an |the )?(?:(?:final|complete|whole|entire|concise|source-supported)\s+)*(?:recommendation|response|answer|report|memo|brief|analysis|deliverable|plan|findings)\b\s+(?:(?:of|in|with)\s+)?(?:no more than|at most|maximum(?: of)?|max(?: of)?)\s+(\d{1,5})\s+words?\b/gi)];
 const last=bounds.at(-1);
 return {wordCount:text.trim().split(/\s+/u).filter(Boolean).length,wordLimit:last?Number(last[1]):null,method:'whitespace-separated words across the entire candidate'};
}
