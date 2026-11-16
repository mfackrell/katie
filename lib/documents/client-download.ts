/** Strictly scoped client-side navigation for Katie's private documents.
 * The bearer token is sent in a request header, never a public link. */
const idPattern=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const receiptPattern=/^[a-f0-9]{64}$/;

export type DocumentDownloadTarget={
  path:string;
  format:'docx'|'pdf';
  filename:string;
  mime:string;
};

export function resolveDocumentDownload(href:string, origin:string):DocumentDownloadTarget|null {
  if (!href.startsWith('/api/documents/download?')) return null;
  try {
    const url=new URL(href,origin);
    if(url.origin!==origin || url.pathname!=='/api/documents/download' || url.hash) return null;
    const keys=[...url.searchParams.keys()];
    if(keys.length!==4 || new Set(keys).size!==4 ||
       keys.some(key=>!['actorId','chatId','id','format'].includes(key))) return null;
    const actorId=url.searchParams.get('actorId')??'';
    const chatId=url.searchParams.get('chatId')??'';
    const receiptId=url.searchParams.get('id')??'';
    const format=url.searchParams.get('format');
    if(!idPattern.test(actorId) || !idPattern.test(chatId) ||
       !receiptPattern.test(receiptId) || (format!=='docx'&&format!=='pdf')) return null;
    return {
      path:url.pathname+url.search,
      format, filename:'document.'+format,
      mime:format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  }catch{return null;}
}
