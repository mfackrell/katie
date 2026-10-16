/** pdf2json coordinates are parser page units (not CSS pixels or source render boxes). */
export type PdfInventory = {
    version: "pdf-pages-v1";
    pageCount: number;
    units: "pdf2json page units";
    pages: Array<{
        physicalPage: number;
        text: string;
        textCoverage: "present" | "none";
        visualCoverage: "not-inspected";
        runs: Array<{
            text: string;
            x?: number;
            y?: number;
            w?: number;
        }>;
        lines: Array<Record<string, number>>;
        layoutTruncated: boolean;
    }>;
};
export function inventoryPdf(pages: Array<{
    Texts?: Array<{
        R?: Array<{
            T?: string;
        }>;
        [key: string]: unknown;
    }>;
    [key: string]: unknown;
}>): PdfInventory {
    if (pages.length > 10000) throw new Error(`PDF inventory limit exceeded: parser reported ${pages.length} pages; no validated inventory retained.`);
    let runBudget = 50000, lineBudget = 20000;
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
    return { version: "pdf-pages-v1", pageCount: pages.length, units: "pdf2json page units", pages: pages.map((page, index) => {
            const runs = (page.Texts ?? []).map(run => ({ text: (run.R ?? []).map(segment => { try {
                    return decodeURIComponent(segment.T ?? "");
                }
                catch {
                    return segment.T ?? "";
                } }).join(""), x: number(run.x), y: number(run.y), w: number(run.w) }));
            const rawLines = [page.HLines, page.VLines].flatMap(value => Array.isArray(value) ? value : []);
            const lineLimit = Math.min(4000, lineBudget);
            const runLimit = Math.min(10000, runBudget);
            const lines = rawLines.slice(0, lineLimit).map(line => Object.fromEntries(Object.entries(line).filter(([key, value]) => ["x", "y", "w", "l"].includes(key) && number(value) !== undefined)) as Record<string, number>);
            const text = runs.map(run => run.text).join("\n");
            const keptRuns = runs.slice(0, runLimit);
            runBudget -= keptRuns.length;
            lineBudget -= lines.length;
            return { physicalPage: index + 1, text, textCoverage: text.trim() ? "present" : "none", visualCoverage: "not-inspected", runs: keptRuns, lines, layoutTruncated: runs.length > runLimit || rawLines.length > lineLimit };
        }) };
}
/** Source names are data, including any page-like words inside them. */
export function maskPdfSourceNames(message: string, sourceNames: string[]): string {
    for (const name of [...new Set(sourceNames)].sort((a, b) => b.length - a.length)) {
        if (!name) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        message = message.replace(new RegExp(escaped, "gi"), "PDF source");
    }
    return message;
}
/** Resolve leading or trailing source-specific selectors before page validation. */
export function pdfPageTaskForSource(message: string, sourceName: string, sourceNames: string[]): string {
    const names = [...new Set(sourceNames)].sort((a, b) => b.length - a.length);
    const pageMentions = maskPdfSourceNames(message, names).match(/\b(?:pages?\s+[-+−\d]|(?:first|last)\s+page\b)/gi) ?? [];
    if (names.length < 2) {
        if (sourceNames.length > 1 && pageMentions.length > 1 && !/\b(?:both|all|each)\b/i.test(message))
            throw new Error("Please specify the physical pages for each PDF separately; I could not associate the page selectors with their sources.");
        return maskPdfSourceNames(message, names);
    }
    let marked = message;
    names.forEach((name, index) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        marked = marked.replace(new RegExp(escaped, "gi"), `PDF_SOURCE_${index}`);
    });
    const spans = [...marked.matchAll(/PDF_SOURCE_(\d+)/g)];
    if (spans.length < 2) {
        if (pageMentions.length > 1 && !/\b(?:both|all|each)\b/i.test(message))
            throw new Error("Please specify the physical pages for each PDF separately; I could not associate the page selectors with their sources.");
        return maskPdfSourceNames(message, names);
    }
    const segments = [marked.slice(0, spans[0].index!), ...spans.map((span, index) =>
        marked.slice(span.index! + span[0].length, spans[index + 1]?.index ?? marked.length))];
    const pageLike = (text: string) => /\b(?:pages?\s+(?:[-+−\d]|zero\b|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b|[a-z](?:\d+)?\b)|(?:first|last)\s+page\b)/i.test(text);
    const scoped = segments.map(pageLike);
    if (!scoped.some(Boolean)) return maskPdfSourceNames(message, names);
    // A single leading selector, or an explicit final "on page", qualifies the set.
    if (scoped[0] && scoped.slice(1).every(value => !value) && /\b(?:both|all|each)\b/i.test(marked) ||
        scoped.at(-1) && scoped.slice(0, -1).every(value => !value) && /^\s*["'”’»`]?\s+on\s+(?:physical\s+)?pages?\s/i.test(segments.at(-1)!))
        return maskPdfSourceNames(message, names);
    const prefixStyle = scoped[0];
    if (prefixStyle) {
        if (scoped.at(-1) || segments.slice(0, -1).some((text, i) => scoped[i] && !/\b(?:of|in|from)\s*["'“‘«`]?\s*$/i.test(text)))
            throw new Error("Please specify the physical pages for each PDF separately; I could not associate the page selectors with their sources.");
    } else if (segments.slice(1, -1).some((text, i) => scoped[i + 1] && /\b(?:of|in|from)\s*["'“‘«`]?\s*$/i.test(text))) {
        throw new Error("Please specify the physical pages for each PDF separately; I could not associate the page selectors with their sources.");
    }
    const indices = spans.map((span, index) => Number(span[1]) === names.indexOf(sourceName) ? index : -1).filter(index => index >= 0);
    if (indices.length !== 1) throw new Error("Please specify one page scope for each PDF source.");
    const segment = segments[indices[0] + (prefixStyle ? 0 : 1)];
    return `Read this PDF. ${pageLike(segment) ? segment : ""}`;
}

export function requestedPdfPages(message: string, count: number, sourceNames: string[] = []): number[] {
    message = maskPdfSourceNames(message, sourceNames);
    const invalid = () => new Error("Please use physical PDF page numbers, for example pages 2-4, within the source inventory.");
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw invalid();
    const explicit: number[] = [];
    const numberWord = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|hundred|thousand|NaN|Infinity|[ivxlcdm]+)\b/i;
    if (/\bpages?\b/i.test(message) && /\b(?:except|excluding)\b|\b(?:first|last)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+pages?\b/i.test(message)) throw invalid();
    for (const match of message.matchAll(/\b(first|last)\s+page\b/gi)) explicit.push(match[1].toLowerCase() === "first" ? 1 : count);
    for (const match of message.matchAll(/\bpages?\s+/gi)) {
        const tail = message.slice(match.index! + match[0].length);
        if (/^[-+−]/.test(tail) || numberWord.test(tail)) throw invalid();
        if (!/^\d/.test(tail)) {
            // Nonnumeric task prose ("pages mention revenue") is not a selector.
            // Reject recognizable unsupported labels, not an allowlist of verbs.
            if (/^(?:[a-z](?:\d+)?|[a-z]+\d+)(?=\s|$|[-–—,;.!?&+/])|^["'“‘«`[(]/i.test(tail)) throw invalid();
            continue;
        }
        const selector = /^(\d+(?:\s*(?:[-–—]|to\b|through\b)\s*\d+)?(?:\s*(?:,\s*(?:and\b)?|and\b)\s*\d+(?:\s*(?:[-–—]|to\b|through\b)\s*\d+)?)*)/i.exec(tail)!;
        const rest = tail.slice(selector[0].length);
        // Do not accept a valid-looking prefix of a fractional, signed, exponent,
        // malformed-range, or partly unsupported page list.
        if (/^\s*(?:[&+]|;\s*\d|or\b)|^[\w/]|^\.(?:\d|\.)|^\s*(?:[-–—]|to\b|through\b)/i.test(rest)) throw invalid();
        const continuation = /^\s*(?:,\s*(?:and\b)?|and\b)\s*(.*)/i.exec(rest)?.[1];
        if (continuation !== undefined && (!continuation.trim() || /^(?:[,&+]|or\b)/i.test(continuation) || /^[-+−\d]/.test(continuation) || numberWord.test(continuation) || /^[a-z]\s*(?:$|[,;.!?&–—-])/i.test(continuation))) throw invalid();
        for (const part of selector[0].split(/\s*(?:,\s*(?:and\b)?|and\b)\s*/i)) {
            const range = /^(\d+)(?:\s*(?:[-–—]|to\b|through\b)\s*(\d+))?$/i.exec(part)!;
            const start = Number(range[1]), end = Number(range[2] ?? range[1]);
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > count) throw invalid();
            for (let page = start; page <= end; page++) explicit.push(page);
        }
    }
    return explicit.length ? [...new Set(explicit)] : Array.from({ length: count }, (_, i) => i + 1);
}

/** File discovery differs from locating a value or extracting all rows inside it. */
export function isPdfLocatorRequest(message: string): boolean {
  const request = message.trim().replace(/^(?:please|can you|could you|would you)\s+/i, "");
  // A complete filename is a discovery target, including spaces and words
  // such as "transactions" that would otherwise signal a content question.
  const target = /^(?:find|locate|show(?:\s+me)?|where\s+(?:is|are|can\s+I\s+find))\s+(?:(?:my|the|a|an|that|this|saved|uploaded|original)\s+)*(.*?)[?!.]*$/i.exec(request)?.[1];
  if (target && /^(?:"[^"\n]+\.pdf"|“[^”\n]+\.pdf”|'[^'\n]+\.pdf'|‘[^’\n]+\.pdf’|`[^`\n]+\.pdf`|«[^»\n]+\.pdf»|[^\n"“”'‘’`«»?;]+\.pdf)$/i.test(target)
      && !/\b(?:in|inside|within|from|for|of|about)\s+/i.test(target.replace(/^(?:"|“|'|‘|`|«)[\s\S]*$/, ""))) return true;
  if (target && /\.pdf\b/i.test(target)) {
    const tail = target.slice(target.toLowerCase().lastIndexOf(".pdf") + 4).replace(/^["'”’»`]/, "").trim();
    return /^(?:(?:that|which)\s+(?:I\s+)?)?(?:uploaded|saved|attached|from|on|during|in)\b[^;?!]*$/i.test(tail);
  }
  // Locating a file is not the same task as locating a value or section IN a file.
  if (/\b(?:pages?\s+\d|every|transactions?|charges?|amounts?|values?|totals?|rows?|columns?|read|extract|analy[sz]e|inside|within|scan\w*|charts?|tables?|breakdown)\b/i.test(request)) return false;
  return /^(?:find|locate|show(?:\s+me)?|where\s+(?:is|are|can\s+I\s+find))\s+(?:(?:my|the|a|an|that|this|saved|uploaded|original)\s+)*(?:pdf|file|document)(?:\s+(?:(?:that|which)\s+(?:I\s+)?)?(?:uploaded|saved|attached|from|on|during|in|about|named|called)\b[^;?!]*)?[?!.]*$/i.test(request);
}

/** Called only after source selection. An attachment is not permission to analyze unrelated tasks. */
export function isPdfContentRequest(message: string): boolean {
  if (!message.trim() || isPdfLocatorRequest(message)) return false;
  const sourceReference = /\b(?:pdfs?|documents?|attachments?|files?|pages?|statements?|reports?|sources?|this|these|those)\b|\.pdf\b/i.test(message);
  const explicit = /\b(?:read|extract|analy[sz]e|inspect|review|summari[sz]e|compare|explain|interpret|calculate|reconcile)\b/i.test(message)
    || (sourceReference && /\b(?:ocr|transcribe|scan|check|examine|describe|audit|process|look\s+(?:at|through|over))\b/i.test(message));
  const storedForLater = /\b(?:keep|save|store|retain|upload|attach)\b.{0,100}\b(?:later|reference|storage|only|do not|don't)\b/i.test(message);
  if (storedForLater && !explicit) return false;
  if (/\b(?:do not|don't|without)\s+(?:read|analy[sz]e|inspect|process)\b/i.test(message)) return false;
  if (/\b(?:tell me a joke|write (?:me )?a (?:joke|poem)|weather|codebase|repository)\b/i.test(message) && !explicit) return false;
  return explicit || /\b(?:find|list|identify)\b.{0,80}\b(?:transactions?|rows?|values?|amounts?|totals?|pages?|charts?|tables?)\b/i.test(message) || /^\s*(?:continue|go on|proceed|next(?: pages?)?)\s*[.!?]?\s*$/i.test(message)
    || (/\b(?:what|where|which|how|why|when|is|are|does|did|list|identify|find)\b/i.test(message)
      && /\b(?:pdfs?|documents?|attachments?|files?|pages?|statements?|reports?|tables?|charts?|figures?|scans?|this|these|those)\b|\.pdf\b|__PDF_SOURCE__/i.test(message));
}
