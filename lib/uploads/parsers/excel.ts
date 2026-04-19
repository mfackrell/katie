import { buildPreview, sanitizeExtractedText, type IngestionContext, type IngestedFile } from "@/lib/uploads/parsers/shared";

type XlsxWorkbook = {
  SheetNames: string[];
  Sheets: Record<string, unknown>;
};

type XlsxModule = {
  read(data: ArrayBuffer, opts: { type: "array" }): XlsxWorkbook;
  utils: {
    sheet_to_json(sheet: unknown, opts: { header: 1; raw: false; blankrows: false }): unknown[][];
  };
};

export type ExcelParserDeps = {
  xlsx: () => Promise<XlsxModule>;
};

const MAX_SHEETS = 20;
const MAX_ROWS_PER_SHEET = 500;
const PREVIEW_ROWS_PER_SHEET = 20;

const DEFAULT_DEPS: ExcelParserDeps = {
  xlsx: async () => (await import("xlsx")) as unknown as XlsxModule
};

let DEPS = DEFAULT_DEPS;

export function __setExcelParserDepsForTests(overrides: Partial<ExcelParserDeps>): void {
  DEPS = { ...DEPS, ...overrides };
}

export async function parseExcel(context: IngestionContext): Promise<IngestedFile> {
  try {
    const xlsx = await DEPS.xlsx();
    const workbook = xlsx.read(await context.file.arrayBuffer(), { type: "array" });
    const warnings: string[] = [];

    if (workbook.SheetNames.length > MAX_SHEETS) {
      warnings.push(`Workbook has ${workbook.SheetNames.length} sheets; only first ${MAX_SHEETS} were parsed.`);
    }

    const parsedSheets = workbook.SheetNames.slice(0, MAX_SHEETS).map((name) => {
      const rows = xlsx.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, blankrows: false });
      if (rows.length > MAX_ROWS_PER_SHEET) {
        warnings.push(`Sheet "${name}" has ${rows.length} rows; truncated to ${MAX_ROWS_PER_SHEET} rows.`);
      }
      const bounded = rows.slice(0, MAX_ROWS_PER_SHEET).map((row) => row.map((cell) => String(cell ?? "")));
      return {
        name,
        rowCount: rows.length,
        previewRows: bounded.slice(0, PREVIEW_ROWS_PER_SHEET),
        rows: bounded
      };
    });

    const extractedText = sanitizeExtractedText(
      parsedSheets
        .map((sheet) => `--- sheet: ${sheet.name} ---\n${sheet.rows.map((r) => r.join("\t")).join("\n")}`)
        .join("\n\n")
    );

    return {
      fileName: context.file.name,
      mimeType: context.mimeType,
      sourceFormat: "excel",
      attachmentKind: "text",
      extractedText,
      preview: buildPreview(extractedText),
      structuredData: {
        workbook: {
          sheetNames: parsedSheets.map((sheet) => sheet.name),
          sheets: parsedSheets.map((sheet) => ({
            name: sheet.name,
            rowCount: sheet.rowCount,
            previewRows: sheet.previewRows
          }))
        }
      },
      parseWarnings: warnings.length ? warnings : undefined,
      ingestionQuality: warnings.length ? "medium" : "high"
    };
  } catch {
    throw new Error(`Failed to parse Excel document "${context.file.name}".`);
  }
}
