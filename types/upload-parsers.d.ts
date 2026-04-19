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

declare module "pdf-parse" {
  export default function pdfParse(input: Uint8Array): Promise<{ text?: string }>;
}
