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

declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export function getDocument(input: { data: ArrayBuffer; disableWorker: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage: (pageNumber: number) => Promise<{
        getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
      }>;
    }>;
  };
}
