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
export function requestedPdfPages(message: string, count: number): number[] {
    const explicit: number[] = [];
    for (const match of message.matchAll(/\bpages?\s+([0-9]+(?:\s*(?:[-–]|to)\s*[0-9]+)?(?:\s*(?:,|and)\s*[0-9]+(?:\s*(?:[-–]|to)\s*[0-9]+)?)*)/gi)) {
        for (const part of match[1].split(/\s*(?:,|and)\s*/i)) {
            const range = /^(\d+)(?:\s*(?:[-–]|to)\s*(\d+))?$/.exec(part)!;
            const start = Number(range[1]), end = Number(range[2] ?? range[1]);
            if (start < 1 || end < start || end > count)
                throw new Error("Requested physical PDF page is outside the source inventory");
            for (let page = start; page <= end; page++) explicit.push(page);
        }
    }
    return explicit.length ? [...new Set(explicit)] : Array.from({ length: count }, (_, i) => i + 1);
}

/** File discovery differs from locating a value or extracting all rows inside it. */
export function isPdfLocatorRequest(message: string): boolean {
  return /\b(find|locate|where)\b/i.test(message) &&
    !/\b(pages?\s+\d|every|all|transactions?|charges?|amounts?|values?|totals?|rows?|columns?|read|extract|analy[sz]e|inside|within|scan\w*|charts?|tables?)\b/i.test(message);
}
