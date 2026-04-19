import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildPreview, compactWhitespace, sanitizeExtractedText, type IngestionContext, type IngestedFile } from "@/lib/uploads/parsers/shared";

const execFileAsync = promisify(execFile);

export type PowerPointParserDeps = {
  extractSlideXmlFiles: (buffer: ArrayBuffer) => Promise<string[]>;
};

async function extractSlideXmlFilesDefault(buffer: ArrayBuffer): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "katie-pptx-"));
  const pptxPath = join(dir, "input.pptx");

  try {
    await writeFile(pptxPath, Buffer.from(buffer));
    const { stdout: listOut } = await execFileAsync("unzip", ["-Z1", pptxPath]);
    const slidePaths = listOut
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^ppt\/slides\/slide\d+\.xml$/i.test(line))
      .sort((a, b) => Number(a.match(/slide(\d+)\.xml/i)?.[1] ?? "0") - Number(b.match(/slide(\d+)\.xml/i)?.[1] ?? "0"));

    const xmls: string[] = [];
    for (const path of slidePaths) {
      const { stdout } = await execFileAsync("unzip", ["-p", pptxPath, path], { maxBuffer: 4 * 1024 * 1024 });
      xmls.push(stdout);
    }

    return xmls;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let DEPS: PowerPointParserDeps = {
  extractSlideXmlFiles: extractSlideXmlFilesDefault
};

export function __setPowerPointParserDepsForTests(overrides: Partial<PowerPointParserDeps>): void {
  DEPS = { ...DEPS, ...overrides };
}

function extractSlideText(xml: string): string {
  const textNodes = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]);
  return compactWhitespace(textNodes.join("\n"));
}

export async function parsePowerPoint(context: IngestionContext): Promise<IngestedFile> {
  if (context.extension === ".ppt") {
    throw new Error(`Legacy .ppt not supported for "${context.file.name}". Please convert the file to .pptx and retry.`);
  }

  try {
    const slidesXml = await DEPS.extractSlideXmlFiles(await context.file.arrayBuffer());
    const slides = slidesXml.map((xml, idx) => `--- slide ${idx + 1} ---\n${extractSlideText(xml)}`);
    const extractedText = sanitizeExtractedText(slides.join("\n\n"));

    return {
      fileName: context.file.name,
      mimeType: context.mimeType,
      sourceFormat: "powerpoint",
      attachmentKind: "text",
      extractedText,
      preview: buildPreview(extractedText),
      ingestionQuality: extractedText.length > 0 ? "high" : "low",
      parseWarnings: extractedText.length > 0 ? undefined : ["No extractable slide text found in this presentation."]
    };
  } catch {
    throw new Error(`Failed to parse PowerPoint document "${context.file.name}".`);
  }
}
