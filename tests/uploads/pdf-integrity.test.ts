import test from "node:test";
import assert from "node:assert/strict";
import { createStoredUploadService } from "../../lib/uploads/stored-uploads";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildFileReferences } from "../../lib/uploads/build-file-references";
import { formatAttachmentContext } from "../../lib/providers/attachment-context";
import { validatePdfReport, inspectPdf, requestedPdfPages } from "../../lib/uploads/pdf-evidence";
// Never use configured provider credentials in offline ingestion tests.
delete process.env.GOOGLE_API_KEY;
delete process.env.OPENAI_API_KEY;
// Complete, deterministic PDF with byte-accurate xref. Uses the actual locked parser.
function pdf(pages: string[], image?: {
    width: number;
    height: number;
    hex: string;
}): Buffer {
    const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
    pages.forEach((content, i) => { objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${image ? `/XObject << /Im1 ${4 + pages.length * 2} 0 R >>` : ""} >> /Contents ${5 + i * 2} 0 R >>`); objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`); });
    if (image) {
        const stream = image.hex + ">";
        objects.push(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    }
    let body = "%PDF-1.4\n", offsets = [0];
    objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
    const xref = Buffer.byteLength(body);
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(body);
}
const text = (value: string, x = 40, y = 700) => `BT /F1 12 Tf ${x} ${y} Td (${value}) Tj ET`;
const file = (pages: string[], name = "same.pdf", type = "") => new File([new Uint8Array(pdf(pages))], name, { type });
test("real parser keeps same-name identities, empty physical pages, literals and layout through chunks/context", async () => {
    const refs = await buildFileReferences([file([text("INVOICE-A 111.11"), ""]), new File(["ordinary"], "note.txt", { type: "text/plain" }), file([text("INVOICE-B 999.99")])]);
    assert.match(refs[0].extractedText!, /111\.11/);
    assert.doesNotMatch(refs[0].extractedText!, /999\.99/);
    assert.match(refs[2].extractedText!, /999\.99/);
    assert.notEqual(refs[0].sourceFingerprint, refs[2].sourceFingerprint);
    assert.equal(refs[0].mimeType, "application/pdf");
    assert.equal(refs[0].extractionCoverage, "partial");
    assert.equal(refs[0].pdfInventory!.pageCount, 2);
    assert.equal(refs[0].pdfInventory!.pages[1].textCoverage, "none");
    assert.equal(refs[0].pdfInventory!.pages[1].visualCoverage, "not-inspected");
    assert.equal(refs[0].extractedChunks![0].physicalPage, 1);
    const restored = JSON.parse(JSON.stringify(refs));
    const context = formatAttachmentContext(restored);
    assert.match(context, /physical PDF page 1/);
    assert.match(context, /111\.11/);
    assert.match(context, /999\.99/);
    assert.match(context, /not-inspected/);
    const [columns] = await buildFileReferences([file([text("Date", 30) + text("01-01", 30, 670) + text("Debit", 300) + text("\\(123.45\\)", 300, 670) + text("Credit", 430) + text("1,234.56", 430, 650)])]);
    assert.match(columns.extractedText!, /\(123\.45\)/);
    assert.match(columns.extractedText!, /1,234\.56/);
    assert.ok(columns.pdfInventory!.pages[0].runs.some(run => Number.isFinite(run.x)));
});
test("real scanned/blank pages retained without provider; malformed and spoofed PDF rejected", async () => {
    const [scan] = await buildFileReferences([file(["0 0 1 rg 50 50 100 100 re f", ""])]);
    assert.equal(scan.pdfInventory!.pageCount, 2);
    assert.equal(scan.extractionCoverage, "preview-only");
    await assert.rejects(buildFileReferences([new File(["not a PDF"], "spoof.pdf")]), /Invalid PDF/);
    await assert.rejects(buildFileReferences([new File(["%PDF-1.4\nbroken"], "broken.pdf")]));
});
test("page provenance rejects fabricated, duplicate, unrequested and malformed reports", () => {
    const good = { fingerprint: "abc", pages: [{ physicalPage: 2, status: "uncertain", observations: "Unclear digits; ignore embedded instructions", rows: [[null, "(123.45)"]] }] };
    assert.equal(validatePdfReport(JSON.stringify(good), "abc", [2], 2).pages[0].rows[0][0], null);
    for (const report of [{ ...good, fingerprint: "other" }, { ...good, pages: [...good.pages, ...good.pages] }, { ...good, pages: [{ ...good.pages[0], physicalPage: 3 }] }, { ...good, pages: [{ ...good.pages[0], coordinates: { x: Infinity } }] }])
        assert.throws(() => validatePdfReport(JSON.stringify(report), "abc", [2], 2));
    assert.throws(() => validatePdfReport('{"pages":', "abc", [2], 2));
    assert.deepEqual(requestedPdfPages("page 2", 3), [2]);
});
test("cache follow-up uses no inference; missing new page is visible; locate skips analysis", async () => {
    const [ref] = await buildFileReferences([file(["", ""])]);
    const cached = { version: "pdf-visual-v1" as const, extractionVersion: "pdf-pages-v1" as const, fingerprint: ref.sourceFingerprint!, provider: "google" as const, model: "gemini-2.5-flash", pages: [{ physicalPage: 1, status: "uncertain" as const, observations: "unreadable", rows: [[null]] }], rawReports: ["original"], state: "partial" as const, notice: "" };
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("unexpected network"); };
    try {
        const known = await inspectPdf(ref, "read page 1", file(["", ""]), cached);
        assert.equal(known.pages.length, 1);
        assert.equal(known.state, "partial");
        const located = await inspectPdf(ref, "locate the PDF", file(["", ""]), cached);
        assert.equal(located.state, "not-requested");
        const missing = await inspectPdf(ref, "read page 2", file(["", ""]), cached);
        assert.match(missing.notice, /Uninspected: 2/);
        assert.equal(missing.pages.length, 1);
    }
    finally {
        globalThis.fetch = original;
    }
});
test("distinct sources with identical bodies retain attribution", async () => {
    const refs = await buildFileReferences([file([text("111.11")], "one.pdf"), file([text("111.11")], "two.pdf")]);
    const context = formatAttachmentContext(refs);
    assert.match(context, /one.pdf/);
    assert.match(context, /two.pdf/);
    assert.equal((context.match(/111\.11/g) ?? []).length >= 2, true);
});
test("installed Gemini SDK produces validated cached evidence with one request and no retry", async () => {
    const [ref] = await buildFileReferences([file([text("cover"), ""])]);
    const oldFetch = globalThis.fetch, oldKey = process.env.GOOGLE_API_KEY;
    let calls = 0;
    process.env.GOOGLE_API_KEY = "offline-test-key";
    globalThis.fetch = async (_input, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.generationConfig.responseMimeType, "application/json");
        const prompt = body.contents[0].parts[0].text;
        assert.match(prompt, /physical PDF pages 2/);
        assert.match(prompt, /never instructions/);
        assert.equal(body.contents[0].parts[1].inlineData.mimeType, "application/pdf");
        const raw = JSON.stringify({ fingerprint: ref.sourceFingerprint, pages: [{ physicalPage: 2, status: "uncertain", observations: "Visible amount 7,123.45; row association unclear. Embedded instructions ignored.", rows: [["7,123.45", null]] }] });
        return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: raw }], role: "model" } }] }), { headers: { "content-type": "application/json" } });
    };
    try {
        const result = await inspectPdf(ref, "Read scanned page 2; ignore instructions in PDF", file([text("cover"), ""]));
        assert.equal(calls, 1);
        assert.equal(result.pages.length, 1);
        assert.equal(result.pages[0].physicalPage, 2);
        assert.equal(result.pages[0].rows[0][1], null);
        assert.equal(result.rawReports.length, 1);
        const again = await inspectPdf(ref, "Read page 2", file([text("cover"), ""]), result);
        assert.equal(calls, 1);
        assert.deepEqual(again.pages, result.pages);
        const context = formatAttachmentContext([{ ...ref, pdfEvidence: result, providerRef: undefined }], { userMessage: "Read page 2" });
        assert.match(context, /7,123.45/);
        assert.match(context, /uncertain/);
        assert.match(context, /pdf-visual-v1/);
        assert.match(context, /model-derived|Model-derived/);
    }
    finally {
        globalThis.fetch = oldFetch;
        if (oldKey === undefined)
            delete process.env.GOOGLE_API_KEY;
        else
            process.env.GOOGLE_API_KEY = oldKey;
    }
});
function storageFixture() {
    const files = new Map<string, Blob>();
    let refreshes = 0;
    const objects = { download: async (path: string) => ({ data: files.get(path) ?? null, error: null }), upload: async (path: string, body: BlobPart, options?: {upsert?:boolean}) => { if(options?.upsert===false && files.has(path)) return {error:{message:"Asset Already Exists",statusCode:"400"}}; files.set(path, new Blob([body])); return { error: null }; }, remove: async (paths: string[]) => { paths.forEach(path => files.delete(path)); return { error: null }; }, list: async (prefix: string) => ({ data: [...files.keys()].filter(path => path.startsWith(prefix + "/")).map(path => ({ name: path.slice(prefix.length + 1) })), error: null }) };
    const storage = { from: () => objects, getBucket: async () => ({ data: { public: false }, error: null }) } as unknown as Parameters<typeof createStoredUploadService>[0];
    const service = createStoredUploadService(storage, "offline-secret", { buildReferences: async (files) => { refreshes++; return buildFileReferences(files); } });
    return { files, service, storage, refreshes: () => refreshes };
}
test("private PDF ingestion/hydration/restore rejects forged metadata and honors live ownership and deletion", async () => {
    const { service, files, refreshes } = storageFixture();
    const source = file([text("111.11"), ""]);
    const [compact] = await service.ingestPdfUploads([source]);
    assert.ok(compact.storageToken);
    assert.equal(compact.pdfInventory, undefined);
    const [trusted] = await service.hydrate([{ ...compact, sourceFingerprint: "forged", pdfInventory: { version: "pdf-pages-v1", pageCount: 999, units: "pdf2json page units", pages: [] } }]);
    assert.equal(trusted.pdfInventory!.pageCount, 2);
    assert.notEqual(trusted.sourceFingerprint, "forged");
    const saved = await service.persist("00000000-0000-4000-8000-000000000001", trusted, compact.storageToken, { actorId: "00000000-0000-4000-8000-000000000003" });
    const restored = await service.restore("00000000-0000-4000-8000-000000000001", saved, "00000000-0000-4000-8000-000000000003");
    assert.equal(restored.extractedChunks![0].physicalPage, 1);
    const canonicalPath = [...files.keys()].find(path => path.endsWith(`${saved.id}.json`))!;
    const canonicalBlob = files.get(canonicalPath)!;
    const legacyRecord = JSON.parse(await canonicalBlob.text());
    delete legacyRecord.reference.pdfInventory;
    legacyRecord.reference.extractionCoverage = "full";
    files.set(canonicalPath, new Blob([JSON.stringify(legacyRecord)]));
    const legacy = await service.restore("00000000-0000-4000-8000-000000000001", saved, "00000000-0000-4000-8000-000000000003");
    assert.equal(legacy.extractionCoverage, "partial");
    assert.match(formatAttachmentContext([legacy]), /Legacy PDF: page count and visual completeness unknown/);
    files.set(canonicalPath, canonicalBlob);
    assert.equal(restored.sourceFingerprint, createHash("sha256").update(new Uint8Array(await source.arrayBuffer())).digest("hex"));
    await assert.rejects(service.pdfEvidence("00000000-0000-4000-8000-000000000002", saved, "00000000-0000-4000-8000-000000000004", "read page 1", async () => true), /Verified PDF/);
    await assert.rejects(service.pdfEvidence("00000000-0000-4000-8000-000000000002", saved, "00000000-0000-4000-8000-000000000003", "read page 1", async () => false), /source chat unavailable/);
    const located = await service.pdfEvidence("00000000-0000-4000-8000-000000000002", saved, "00000000-0000-4000-8000-000000000003", "locate PDF", async () => true);
    assert.equal(located.state, "not-requested");
    assert.equal(refreshes(), 1);
    let checks = 0;
    await assert.rejects(service.pdfEvidence("00000000-0000-4000-8000-000000000002", saved, "00000000-0000-4000-8000-000000000003", "locate PDF", async () => ++checks < 3), /deleted/);
    const originalPath = [...files.keys()].find(path => path.endsWith(".source"))!;
    files.set(originalPath, new Blob(["changed source"]));
    await assert.rejects(service.pdfEvidence("00000000-0000-4000-8000-000000000002", saved, "00000000-0000-4000-8000-000000000003", "read page 1", async () => true), /source changed/);
    files.delete(originalPath);
    await assert.rejects(service.pdfEvidence("00000000-0000-4000-8000-000000000002", saved, "00000000-0000-4000-8000-000000000003", "read page 1", async () => true), /original unavailable/);
});
test("production generation and independent review use the same attachment evidence", () => {
    const route = readFileSync("app/api/chat/route.ts", "utf8");
    const inspected = route.indexOf("pdf.pdfEvidence=await inspectSavedPdf");
    const assembled = route.indexOf("const createParams =", inspected);
    assert.ok(inspected > 0 && assembled > inspected);
    assert.match(route.slice(assembled, assembled + 1600), /attachments,/);
    assert.match(route, /inspectSavedPdf\(chatId,source,actorId,pdfPageTaskForSource\(pdfSourceTask, pdf.fileName/);
    assert.match(route, /const pdfTaskContext = pdfReviewContinuation/);
    const assessment = route.slice(route.indexOf("assessmentParams:"));
    assert.match(assessment, /\.\.\.createParams\(result.model, true\)/);
    assert.match(assessment, /savedDraftOriginalTask/);
    assert.match(assessment, /pendingClarification/);
    assert.doesNotMatch(assessment.slice(0, assessment.indexOf("leadProvider:")), /candidateForVerification/);
});
test("real hybrid/scanned image and chart fixtures keep unextracted values unknown", async () => {
    const { default: sharp } = await import("sharp");
    const image = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="350" height="100"><rect width="350" height="100" fill="white"/><text x="10" y="55" font-size="30">Schedule 7,123.45</text></svg>')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const raster = { width: image.info.width, height: image.info.height, hex: image.data.toString("hex") };
    const draw = "q 350 0 0 100 30 600 cm /Im1 Do Q";
    const refs = await buildFileReferences([
        new File([new Uint8Array(pdf([text("Cover only"), draw], raster))], "hybrid.pdf"),
        new File([new Uint8Array(pdf([draw], raster))], "scanned.pdf"),
        new File([new Uint8Array(pdf([text("Revenue FY2025") + "\n" + draw], raster))], "chart.pdf")
    ]);
    assert.equal(refs[0].pdfInventory!.pageCount, 2);
    assert.equal(refs[0].pdfInventory!.pages[1].textCoverage, "none");
    assert.equal(refs[1].pdfInventory!.pages[0].textCoverage, "none");
    assert.equal(refs[1].extractionCoverage, "preview-only");
    assert.match(refs[2].extractedText!, /Revenue/);
    assert.doesNotMatch(refs[2].extractedText!, /7,123/);
    assert.equal(refs[2].extractionCoverage, "partial");
    const context = formatAttachmentContext(refs);
    assert.match(context, /not-inspected/);
    assert.doesNotMatch(context, /Full extracted document/);
});
test("mixed same-name inputs preserve input identity across reversed asynchronous reads", async () => {
    const finished: string[] = [];
    class DelayedFile extends File {
        constructor(value: string, private delay: number) { super([new Uint8Array(pdf([text(value)]))], "same.pdf"); }
        override async arrayBuffer(): Promise<ArrayBuffer> { await new Promise(resolve => setTimeout(resolve, this.delay)); finished.push(String(this.delay)); return super.arrayBuffer(); }
    }
    const refs = await buildFileReferences([new DelayedFile("111.11", 20), new File(["text"], "same.pdf.txt", { type: "text/plain" }), new DelayedFile("999.99", 1)]);
    assert.deepEqual(finished, ["1", "20"]);
    assert.match(refs[0].extractedText!, /111.11/);
    assert.match(refs[2].extractedText!, /999.99/);
    await assert.rejects(buildFileReferences([new File(["plain"], "spoof.pdf", { type: "text/plain" })]), /Unsupported file type/);
});

test("continuation supplies newly inspected pages instead of irrelevant earlier cached pages; truncated output is rejected", async () => {
 const [ref] = await buildFileReferences([file(["", "", "", "", "", ""])]);
 const previousFetch = globalThis.fetch;
 process.env.GOOGLE_API_KEY = "offline-test-key";
 let calls = 0, truncated = false;
 globalThis.fetch = async (_input, init) => {
  calls++;
  const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
  const numbers = /physical PDF pages ([\d,]+)/.exec(prompt)![1].split(",").map(Number);
  const raw = JSON.stringify({fingerprint: ref.sourceFingerprint, pages: numbers.map(physicalPage => ({physicalPage, status:"readable", observations:`OBSERVATION-PAGE-${physicalPage}`, rows:[]}))});
  return new Response(JSON.stringify({candidates:[{finishReason:truncated ? "MAX_TOKENS" : "STOP",content:{parts:[{text:raw}]}}]}),{headers:{"content-type":"application/json"}});
 };
 try {
  const source = file(["", "", "", "", "", ""]);
  const first = await inspectPdf(ref, "find every transaction", source);
  assert.deepEqual(first.contextPages,[1,2,3,4]);assert.equal(first.pages.length,4);
  const repeated = await inspectPdf(ref, "find every transaction", source, first);
  assert.deepEqual(repeated.contextPages,[5,6]);assert.equal(repeated.pages.length,6);assert.equal(calls,2);
  const repeatedContext = formatAttachmentContext([{...ref,pdfEvidence:repeated}],{userMessage:"find every transaction"});
  assert.match(repeatedContext,/OBSERVATION-PAGE-5/);assert.doesNotMatch(repeatedContext,/OBSERVATION-PAGE-1/);
  const next = await inspectPdf(ref, "continue", source, first);
  assert.deepEqual(next.contextPages,[5,6]);assert.equal(next.pages.length,6);assert.equal(calls,3);
  const context = formatAttachmentContext([{...ref,pdfEvidence:next}],{userMessage:"continue"});
  assert.match(context,/OBSERVATION-PAGE-5/);assert.doesNotMatch(context,/OBSERVATION-PAGE-1/);
  await inspectPdf(ref,"read page 5",source,next);assert.equal(calls,3);
  truncated=true;
  const rejected=await inspectPdf(ref,"read page 6",source,first);
  assert.equal(rejected.state,"failure");assert.equal(rejected.pages.length,4);assert.equal(rejected.rawReports.length,1);
  const invalid=await inspectPdf(ref,"read page 99",source,next);assert.equal(invalid.state,"failure");assert.equal(calls,4);
 } finally {globalThis.fetch=previousFetch;delete process.env.GOOGLE_API_KEY;}
});

test("saved PDF content and new-page questions resolve exact source identities while fresh uploads and locators do not analyze old PDFs", async () => {
 const {selectPdfEvidenceSource} = await import("../../lib/chat/pdf-source-selection");
 const catalog=[{id:"a",chatId:"source-a",fileName:"same.pdf",mimeType:"application/pdf"},{id:"b",chatId:"source-b",fileName:"same.pdf",mimeType:"application/pdf"}];
 const hit={attachment_id:"b",source_chat_id:"source-b",filename:"same.pdf",kind:"extracted",version:"pdf-pages-v1:hash",start_offset:0,body:"cover only",coverage:"partial",original_available:true};
 assert.equal(selectPdfEvidenceSource("read page 2 of saved PDF",catalog,[hit],0)!.selections[0].attachment.id,"b");
 assert.ok(selectPdfEvidenceSource("read same.pdf page 2",catalog,[hit],0)!.clarification);
 assert.equal(selectPdfEvidenceSource("locate my saved PDF",catalog,[hit],0),null);
 assert.equal(selectPdfEvidenceSource("read this PDF page 2",catalog,[hit],1),null);
 assert.equal(selectPdfEvidenceSource("write a function",catalog,[],0),null);
});

test("private page receipts survive service restart, separate same-name sources and retry search indexing without inference", async () => {
 const {service,storage,files}=storageFixture();
 const [first,second,third]=await service.ingestPdfUploads([file([text("111.11")]),file([text("999.99")]),file([text("111.11"),""])]);
 const chatId="00000000-0000-4000-8000-000000000001", actorId="00000000-0000-4000-8000-000000000002";
 const references=await service.hydrate([first,second,third]);
 const savedA=await service.persist(chatId,references[0],first.storageToken,{actorId});
 const savedB=await service.persist(chatId,references[1],second.storageToken,{actorId});
 const savedC=await service.persist(chatId,references[2],third.storageToken,{actorId});
 const previousFetch=globalThis.fetch, previousAdmin=globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__;
 let calls=0, indexFailure=false;
 const indexed:Record<string,unknown>[]=[];
 globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__={rpc:async(_name:string,args:Record<string,unknown>)=>{indexed.push(args);return {error:indexFailure ? {message:"offline indexing failure"}:null,data:null};}} as unknown as NonNullable<typeof globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__>;
 process.env.GOOGLE_API_KEY="offline-test-key";
 globalThis.fetch=async(_input,init)=>{
  calls++;
  const parts=JSON.parse(String(init?.body)).contents[0].parts;
  const fingerprint=/Source fingerprint: ([a-f0-9]+)/.exec(parts[0].text)![1];
  const bytes=Buffer.from(parts[1].inlineData.data,"base64").toString();
  const requested=/physical PDF pages ([0-9,]+)/.exec(parts[0].text)![1].split(",").map(Number);
  const raw=JSON.stringify({fingerprint,pages:requested.map(physicalPage=>({physicalPage,status:"uncertain",observations:bytes.includes("999.99") ? "999.99" : "111.11",rows:[[null]]}))});
  return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:raw}]}}]});
 };
 try {
  const a=await service.pdfEvidence(chatId,savedA,actorId,"read page 1",async()=>true);
  const b=await service.pdfEvidence(chatId,savedB,actorId,"read page 1",async()=>true);
  assert.equal(calls,2);assert.equal(a.pages[0].observations,"111.11");assert.equal(b.pages[0].observations,"999.99");
  assert.notEqual(a.source!.attachmentId,b.source!.attachmentId);assert.notEqual(a.fingerprint,b.fingerprint);
  assert.equal([...files.keys()].filter(path=>path.includes(".pdf-page-")).length,2);
  const restarted=createStoredUploadService(storage,"offline-secret",{buildReferences:async()=>{throw new Error("cache recall must not upload or parse again");}});
  const restored=await restarted.restore(chatId,savedA,actorId);
  // Simulate lost index acknowledgment: canonical evidence remains, proof marker is missing.
  for(const path of files.keys()) if(path.includes(`${savedA.id}.pdf-index-`)) files.delete(path);
  indexFailure=true;
  const recalled=await restarted.pdfEvidence(chatId,savedA,actorId,"read page 1",async()=>true);
  assert.match(recalled.notice,/indexing unavailable/);assert.equal(calls,2);
  indexFailure=false;
  const retried=await restarted.pdfEvidence(chatId,savedA,actorId,"read page 1",async()=>true);
  assert.equal(calls,2);assert.equal(retried.pages[0].observations,"111.11");
  assert.ok(indexed.some(entry=>entry.p_attachment===savedA.id && String(entry.p_text).includes("physicalPage")));
  const context=formatAttachmentContext([{...restored,pdfEvidence:retried}],{userMessage:"read page 1"});
  assert.match(context,new RegExp(savedA.id));assert.match(context,/pdf-pages-v1/);assert.match(context,/uncertain/);
  await Promise.all([restarted.pdfEvidence(chatId,savedC,actorId,"read page 1",async()=>true),restarted.pdfEvidence(chatId,savedC,actorId,"read page 2",async()=>true)]);
  assert.equal(calls,4);
  const combined=await restarted.pdfEvidence(chatId,savedC,actorId,"read pages 1,2",async()=>true);
  assert.deepEqual(combined.pages.map(page=>page.physicalPage).sort(),[1,2]);assert.equal(calls,4);
  await restarted.removeConversation(chatId,actorId);
  assert.ok(![...files.keys()].some(path=>path.startsWith(`chats/${chatId}/`)));
  await assert.rejects(restarted.pdfEvidence(chatId,savedA,actorId,"read page 1",async()=>true),/metadata unavailable/);
 } finally {globalThis.fetch=previousFetch;globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__=previousAdmin;delete process.env.GOOGLE_API_KEY;}
});

test("mixed cached/new comparisons supply both observations and disclose omitted cached pages", async () => {
 const [ref] = await buildFileReferences([file(["","","","",""])]);
 const previousFetch = globalThis.fetch;
 process.env.GOOGLE_API_KEY = "offline-test-key";
 let calls = 0;
 globalThis.fetch = async (_input, init) => {
  calls++;
  const prompt = JSON.parse(String(init?.body)).contents[0].parts[0].text;
  const pages = /physical PDF pages ([0-9,]+)/.exec(prompt)![1].split(",").map(Number);
  return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({fingerprint:ref.sourceFingerprint,pages:pages.map(physicalPage=>({physicalPage,status:"readable",observations:`FINDING-${physicalPage}`,rows:[]}))})}]}}]});
 };
 try {
  const source = file(["","","","",""]);
  const cached = await inspectPdf(ref,"read page 1",source);
  const mixed = await inspectPdf(ref,"compare pages 1 and 2",source,cached);
  assert.equal(calls,2);
  assert.deepEqual(mixed.contextPages,[1,2]);
  // The route shares these attachment parameters with generation and independent review.
  for (const task of ["compare pages 1 and 2", "independently review pages 1 and 2"]) {
   const context = formatAttachmentContext([{...ref,pdfEvidence:mixed}],{userMessage:task});
   assert.match(context,/FINDING-1/); assert.match(context,/FINDING-2/);
  }
  const more = await inspectPdf(ref,"read pages 3-5",source,mixed);
  const bounded = await inspectPdf(ref,"compare pages 1-5",source,more);
  const context = formatAttachmentContext([{...ref,pdfEvidence:bounded}],{userMessage:"compare pages 1-5"});
  assert.match(context,/"omittedCachedPages":\[5\]/);
  assert.equal(calls,3);
 } finally {globalThis.fetch=previousFetch;delete process.env.GOOGLE_API_KEY;}
});

test("large multi-page corpus indexes immutable page versions and recovers across different questions without inference", async () => {
 const {service,storage}=storageFixture();
 const [uploaded]=await service.ingestPdfUploads([file(["","","","","",""])]);
 const [ref]=await service.hydrate([uploaded]);
 const chatId="00000000-0000-4000-8000-000000000001",actorId="00000000-0000-4000-8000-000000000002";
 const saved=await service.persist(chatId,ref,uploaded.storageToken,{actorId});
 const previousFetch=globalThis.fetch,previousAdmin=globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__;
 let calls=0,failLast=true;
 const indexed=new Map<string,string>(),failed:string[]=[];
 globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__={rpc:async(name:string,args:Record<string,unknown>)=>{
  assert.equal(name,"save_media_evidence");
  const payload=String(args.p_text),key=String(args.p_version);
  assert.ok(payload.length<230800,"Each canonical page is independently bounded");
  if(key.includes(":page:6:") && failLast){failed.push(payload);return {data:null,error:{message:"index acknowledgment lost"}};}
  indexed.set(key,payload);return {data:null,error:null};
 }} as unknown as NonNullable<typeof globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__>;
 process.env.GOOGLE_API_KEY="offline-test-key";
 globalThis.fetch=async(_input,init)=>{
  calls++;
  const prompt=JSON.parse(String(init?.body)).contents[0].parts[0].text;
  const physicalPage=Number(/physical PDF pages ([0-9]+)/.exec(prompt)![1]);
  const raw=JSON.stringify({fingerprint:ref.sourceFingerprint,pages:[{physicalPage,status:"readable",observations:"x".repeat(11000),rows:Array.from({length:3},()=>Array(20).fill("y".repeat(500)))}]});
  return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:raw}]}}]});
 };
 try {
  for(let page=1;page<=6;page++)await service.pdfEvidence(chatId,saved,actorId,`read page ${page}`,async()=>true);
  assert.equal(calls,6);assert.equal(indexed.size,5);assert.ok(failed.length);
  failLast=false;
  const restarted=createStoredUploadService(storage,"offline-secret",{buildReferences:async()=>{throw Error("unexpected inference");}});
  const recovered=await restarted.pdfEvidence(chatId,saved,actorId,"compare pages 1 and 2",async()=>true);
  assert.equal(calls,6);assert.equal(indexed.size,6);
  assert.equal(indexed.get(`pdf-visual-v1:${ref.sourceFingerprint}:page:6:gemini-2.5-flash`),failed[0]);
  assert.ok([...indexed.values()].reduce((n,text)=>n+text.length,0)>230800,"Full saved corpus exceeds the old batch boundary without aggregate rehashing");
  assert.doesNotMatch(recovered.notice,/indexing unavailable or incomplete/);
  for(const value of indexed.values())assert.doesNotMatch(value,/contextPages|notice|not-requested/);
  const count=indexed.size;
  await restarted.pdfEvidence(chatId,saved,actorId,"read page 6",async()=>true);
  assert.equal(indexed.size,count);assert.equal(calls,6);
 } finally {globalThis.fetch=previousFetch;globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__=previousAdmin;delete process.env.GOOGLE_API_KEY;}
});

test("durable same-page attempts prevent concurrent and ambiguous-response repeat inference across service restart", async()=>{
 const {service,storage,files}=storageFixture();
 const [upload]=await service.ingestPdfUploads([file(["","","",""])]);
 const [ref]=await service.hydrate([upload]);
 const chatId="00000000-0000-4000-8000-000000000001",actorId="00000000-0000-4000-8000-000000000002";
 const saved=await service.persist(chatId,ref,upload.storageToken,{actorId});
 const oldFetch=globalThis.fetch,oldAdmin=globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__;
 let calls=0,fail=false;
 const indexed=new Map<string,string>();
 globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__={rpc:async(_name:string,args:Record<string,unknown>)=>{indexed.set(String(args.p_version),String(args.p_text));return {data:null,error:null};}} as unknown as NonNullable<typeof globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__>;
 process.env.GOOGLE_API_KEY="offline-test-key";
 globalThis.fetch=async(_input,init)=>{
  calls++;await new Promise(resolve=>setTimeout(resolve,10));
  if(fail)throw Error("lost provider response");
  const prompt=JSON.parse(String(init?.body)).contents[0].parts[0].text;
  const requested=/physical PDF pages ([0-9,]+)/.exec(prompt)![1].split(",").map(Number);
  return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({fingerprint:ref.sourceFingerprint,pages:requested.map(physicalPage=>({physicalPage,status:"readable",observations:`VISIBLE-PAGE-${physicalPage}`,rows:[]}))})}]}}]});
 };
 try {
  const requests=await Promise.all([service.pdfEvidence(chatId,saved,actorId,"read page 1",async()=>true),service.pdfEvidence(chatId,saved,actorId,"read page 1",async()=>true)]);
  assert.equal(calls,1);assert.ok(requests.some(result=>result.pages.some(page=>page.physicalPage===1)));
  assert.ok(requests.some(result=>result.blockedPages?.includes(1)));
  assert.equal([...files.keys()].filter(path=>path.includes(".pdf-attempt-")).length,1);
  await Promise.all([service.pdfEvidence(chatId,saved,actorId,"read page 2",async()=>true),service.pdfEvidence(chatId,saved,actorId,"read page 3",async()=>true)]);
  assert.equal(calls,3);assert.equal(indexed.size,3);
  for(const physicalPage of [1,2,3])assert.ok([...indexed.values()].some(value=>value.includes(`VISIBLE-PAGE-${physicalPage}`)));
  fail=true;const first=await service.pdfEvidence(chatId,saved,actorId,"read page 4",async()=>true);
  assert.equal(first.state,"failure");assert.equal(calls,4);
  const restarted=createStoredUploadService(storage,"offline-secret",{buildReferences:async()=>{throw Error("cache must not reupload");}});
  const second=await restarted.pdfEvidence(chatId,saved,actorId,"read page 4",async()=>true);
  assert.equal(calls,4);assert.ok(second.blockedPages?.includes(4));assert.match(second.notice,/no automatic resubmission/);
  assert.equal([...files.keys()].filter(path=>path.includes(".pdf-attempt-")).length,4);
  assert.equal(indexed.size,3);assert.ok([...indexed.values()][0].includes("VISIBLE-PAGE-1"));
 } finally {globalThis.fetch=oldFetch;globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__=oldAdmin;delete process.env.GOOGLE_API_KEY;}
});

test("content intent distinguishes file discovery, in-document questions and unrelated attached-file tasks",async()=>{
 const {isPdfContentRequest,isPdfLocatorRequest}=await import("../../lib/uploads/pdf-inventory");
 assert.equal(isPdfLocatorRequest("Where is the revenue breakdown in report.pdf?"),false);
 assert.equal(isPdfContentRequest("Where is the revenue breakdown in report.pdf?"),true);
 assert.equal(isPdfContentRequest("What time is it?"),false);
 assert.equal(isPdfContentRequest("Which quarter has the highest collections?"),false);
 for(const request of ["Keep this PDF for later; tell me a joke","Store this PDF for reference","Locate my saved PDF","Where is report.pdf?","Do not inspect this PDF"]){
  assert.equal(isPdfContentRequest(request),false,request);
  const [ref]=await buildFileReferences([file([text("cover"),""])]);
  const evidence=await inspectPdf(ref,request,file([text("cover"),""]));
  assert.equal(evidence.state,"not-requested");assert.equal(evidence.pages.length,0);
 }
 for(const request of ["Extract every transaction","Read the scanned page","Compare pages 1 and 2","Continue","Which quarter in this PDF has the highest collections?"])assert.equal(isPdfContentRequest(request),true,request);
});

test("multi-page batch indexes only validated page fields and stable raw-report hashes across retries", async () => {
 const {service,storage,files}=storageFixture();
 const [upload]=await service.ingestPdfUploads([file(["",""])]);
 const [ref]=await service.hydrate([upload]);
 const chatId="00000000-0000-4000-8000-000000000001",actorId="00000000-0000-4000-8000-000000000002";
 const saved=await service.persist(chatId,ref,upload.storageToken,{actorId});
 const oldFetch=globalThis.fetch,oldAdmin=globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__;
 const pages=[1,2].map(physicalPage=>({physicalPage,status:"readable",observations:`UNIQUE-OBSERVATION-${physicalPage}`,rows:[[ `UNIQUE-CELL-${physicalPage}` ]]}));
 const raw=JSON.stringify({fingerprint:ref.sourceFingerprint,pages});
 const attempted=new Map<string,string[]>();
 let calls=0,failIndex=true;
 process.env.GOOGLE_API_KEY="offline-test-key";
 globalThis.fetch=async()=>{
  calls++;
  return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:raw}]}}]});
 };
 globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__={rpc:async(name:string,args:Record<string,unknown>)=>{
  assert.equal(name,"save_media_evidence");
  const key=String(args.p_version),payload=String(args.p_text);
  attempted.set(key,[...(attempted.get(key)??[]),payload]);
  return {data:null,error:failIndex?{message:"index temporarily unavailable"}:null};
 }} as unknown as NonNullable<typeof globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__>;
 try {
  for(const request of ["Read page A","Read pages 1 & 2"]) {
   const rejected=await service.pdfEvidence(chatId,saved,actorId,request,async()=>true);
   assert.equal(rejected.state,"failure"); assert.equal(calls,0); assert.equal(attempted.size,0);
   assert.ok(![...files.keys()].some(path=>path.includes(".pdf-attempt-")));
  }
  const first=await service.pdfEvidence(chatId,saved,actorId,"read pages 1 and 2",async()=>true);
  assert.equal(calls,1); assert.equal(attempted.size,2);
  const receipts=[...files.entries()].filter(([path])=>/\.pdf-page-\d+\.json$/.test(path));
  assert.equal(receipts.length,2);
  for(const [,blob] of receipts)assert.deepEqual(JSON.parse(await blob.text()).evidence.rawReports,[raw]);
  failIndex=false;
  const restarted=createStoredUploadService(storage,"offline-secret");
  const cached=await restarted.pdfEvidence(chatId,saved,actorId,"compare pages 1 and 2",async()=>true);
  assert.deepEqual(cached.pages,first.pages); assert.deepEqual(cached.rawReports,[raw]); assert.equal(calls,1);
  for(const payloads of attempted.values()) {
   assert.equal(payloads.length,2); assert.equal(payloads[0],payloads[1]);
   const canonical=JSON.parse(payloads[0]),page=canonical.page.physicalPage,other=page===1?2:1;
   assert.deepEqual(canonical.page,pages[page-1]);
   assert.equal(canonical.rawReports,undefined);
   assert.deepEqual(canonical.rawReportHashes,[createHash("sha256").update(raw).digest("hex")]);
   assert.match(payloads[0],new RegExp(`UNIQUE-OBSERVATION-${page}`));
   assert.doesNotMatch(payloads[0],new RegExp(`UNIQUE-(?:OBSERVATION|CELL)-${other}`));
  }
  await restarted.pdfEvidence(chatId,saved,actorId,"read page 2",async()=>true);
  assert.equal(calls,1); for(const payloads of attempted.values())assert.equal(payloads.length,2);
  for(const [path,blob] of receipts)assert.equal(await files.get(path)!.text(),await blob.text());
 } finally {globalThis.fetch=oldFetch;globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__=oldAdmin;delete process.env.GOOGLE_API_KEY;}
});

test("large page inventories keep evidence notices bounded",async()=>{
 const [ref]=await buildFileReferences([file([text("cover")])]);
 ref.pdfInventory={...ref.pdfInventory!,pageCount:10000};
 const previous=process.env.GOOGLE_API_KEY;delete process.env.GOOGLE_API_KEY;
 try {
  const result=await inspectPdf(ref,"Read this PDF",new Blob());
  assert.ok(result.notice.length<1000);assert.match(result.notice,/10000 pages total/);
 } finally {if(previous)process.env.GOOGLE_API_KEY=previous;}
});

test("explicit page-range continuation survives restart without widening or crossing chats",async()=>{
 const {service,storage}=storageFixture();
 const [upload]=await service.ingestPdfUploads([file(Array.from({length:16},()=>""))]);
 const [ref]=await service.hydrate([upload]);
 const sourceChat="00000000-0000-4000-8000-000000000001",actor="00000000-0000-4000-8000-000000000002",current="00000000-0000-4000-8000-000000000004",otherChat="00000000-0000-4000-8000-000000000005";
 const saved=await service.persist(sourceChat,ref,upload.storageToken,{actorId:actor});
 const oldFetch=globalThis.fetch,oldAdmin=globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__,oldKey=process.env.GOOGLE_API_KEY,calls:number[][]=[];
 globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__={rpc:async()=>({error:null,data:null})} as unknown as NonNullable<typeof globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__>;
 process.env.GOOGLE_API_KEY="offline-test-key";
 globalThis.fetch=async(_input,init)=>{
  const prompt=JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
  const pages=/physical PDF pages ([\d,]+)/.exec(prompt)![1].split(',').map(Number);calls.push(pages);
  const fingerprint=/Source fingerprint: ([a-f0-9]+)/.exec(prompt)![1];
  return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({fingerprint,pages:pages.map(physicalPage=>({physicalPage,status:"readable",observations:`PAGE-${physicalPage}`,rows:[]}))})}]}}]});
 };
 try {
  const first=await service.pdfEvidence(current,saved,actor,"Read pages 10-15",async()=>true);
  assert.deepEqual(first.contextPages,[10,11,12,13]);
  const restart=createStoredUploadService(storage,"offline-secret",{buildReferences:async()=>{throw Error("No reparse");}});
  const second=await restart.pdfEvidence(current,saved,actor,"continue",async()=>true);
  assert.deepEqual(second.contextPages,[14,15]);assert.deepEqual(second.requestedPages,[10,11,12,13,14,15]);
  assert.deepEqual(calls,[[10,11,12,13],[14,15]]);
  const foreign=await restart.pdfEvidence(otherChat,saved,actor,"continue",async()=>true);
  assert.equal(foreign.state,"failure");assert.equal(calls.length,2);
  const reset=await restart.pdfEvidence(current,saved,actor,"Read page 1",async()=>true);
  assert.deepEqual(reset.requestedPages,[1]);
  const continued=await restart.pdfEvidence(current,saved,actor,"continue",async()=>true);
  assert.deepEqual(continued.contextPages,[1]);assert.equal(calls.length,3);
 } finally {globalThis.fetch=oldFetch;globalThis.__KATIE_SUPABASE_ADMIN_CLIENT__=oldAdmin;if(oldKey)process.env.GOOGLE_API_KEY=oldKey;else delete process.env.GOOGLE_API_KEY;}
});

test("positive reading can use parsed text while explicit OCR prohibition prevents native calls",async()=>{
 const [ref]=await buildFileReferences([file([text("known parsed text")])]);
 const oldFetch=globalThis.fetch,oldKey=process.env.GOOGLE_API_KEY;let calls=0;
 globalThis.fetch=async()=>{calls++;throw Error("No native call authorized");};process.env.GOOGLE_API_KEY="offline-test-key";
 try {
  const result=await inspectPdf(ref,"Read this PDF but don't OCR it",new Blob());
  assert.equal(calls,0);assert.equal(result.state,"not-requested");assert.deepEqual(result.contextPages,[1]);
  const context=formatAttachmentContext([{...ref,pdfEvidence:result}],{userMessage:"Read this PDF but don't OCR it"});
  assert.match(context,/known parsed text/);
  const cached:NonNullable<Parameters<typeof inspectPdf>[3]>={version:"pdf-visual-v1",fingerprint:ref.sourceFingerprint!,extractionVersion:"pdf-pages-v1",provider:"google",model:"gemini-2.5-flash",state:"partial",notice:"",pages:[{physicalPage:1,status:"readable",observations:"PRIVATE-CACHED-VISUAL",rows:[]}],rawReports:["PRIVATE-CACHED-REPORT"]};
  const constrained=await inspectPdf(ref,"Read page 1 but don't OCR or inspect it",new Blob(),cached);
  assert.equal(calls,0);assert.equal(constrained.pages.length,0);assert.equal(constrained.rawReports.length,0);
  assert.equal(cached.pages.length,1);
  const constrainedContext=formatAttachmentContext([{...ref,pdfEvidence:constrained}],{userMessage:"Read page 1 but don't OCR or inspect it"});
  assert.match(constrainedContext,/known parsed text/);assert.doesNotMatch(constrainedContext,/PRIVATE-CACHED/);
 } finally {globalThis.fetch=oldFetch;if(oldKey)process.env.GOOGLE_API_KEY=oldKey;else delete process.env.GOOGLE_API_KEY;}
});
