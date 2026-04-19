declare module "mammoth" {
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
}

declare module "xlsx" {
  export function read(data: ArrayBuffer, opts: { type: string }): {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  export const utils: {
    sheet_to_csv(sheet: unknown, options: { FS: string }): string;
  };
}

declare module "pdf2json" {
  type PdfData = {
    Pages?: Array<{
      Texts?: Array<{
        R?: Array<{ T?: string }>;
      }>;
    }>;
  };

  export default class PDFParser {
    on(event: "pdfParser_dataError", cb: (err: { parserError?: string }) => void): void;
    on(event: "pdfParser_dataReady", cb: (data: PdfData) => void): void;
    parseBuffer(buffer: Buffer): void;
  }
}
