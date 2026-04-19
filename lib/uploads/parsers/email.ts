import { buildPreview, sanitizeExtractedText, stripMarkupToText, type IngestionContext, type IngestedFile } from "@/lib/uploads/parsers/shared";

type ParsedEml = {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
  textBody: string;
};

function parseEml(raw: string): ParsedEml {
  const normalized = raw.replace(/\r\n/g, "\n");
  const [headerPart, ...bodyParts] = normalized.split("\n\n");
  const headers = headerPart.split("\n");
  const bodyRaw = bodyParts.join("\n\n");

  const map = new Map<string, string>();
  let currentKey: string | null = null;
  for (const line of headers) {
    if (/^\s+/.test(line) && currentKey) {
      map.set(currentKey, `${map.get(currentKey) ?? ""} ${line.trim()}`.trim());
      continue;
    }

    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    currentKey = line.slice(0, idx).trim().toLowerCase();
    map.set(currentKey, line.slice(idx + 1).trim());
  }

  const contentType = (map.get("content-type") ?? "").toLowerCase();
  const textBody = contentType.includes("text/html") ? stripMarkupToText(bodyRaw) : bodyRaw.trim();

  return {
    from: map.get("from"),
    to: map.get("to"),
    cc: map.get("cc"),
    subject: map.get("subject"),
    date: map.get("date"),
    textBody
  };
}

export async function parseEmail(context: IngestionContext): Promise<IngestedFile> {
  if (context.extension === ".msg") {
    throw new Error(`Outlook .msg is not yet supported for "${context.file.name}". Please export to .eml or PDF and retry.`);
  }

  try {
    const raw = await context.file.text();
    const parsed = parseEml(raw);
    const extractedText = sanitizeExtractedText(
      [
        `From: ${parsed.from ?? "(unknown)"}`,
        `To: ${parsed.to ?? "(unknown)"}`,
        parsed.cc ? `CC: ${parsed.cc}` : "",
        `Subject: ${parsed.subject ?? "(no subject)"}`,
        `Date: ${parsed.date ?? "(unknown)"}`,
        "",
        parsed.textBody
      ]
        .filter(Boolean)
        .join("\n")
    );

    return {
      fileName: context.file.name,
      mimeType: context.mimeType,
      sourceFormat: "email",
      attachmentKind: "text",
      extractedText,
      preview: buildPreview(extractedText),
      structuredData: {
        headers: {
          from: parsed.from,
          to: parsed.to,
          cc: parsed.cc,
          subject: parsed.subject,
          date: parsed.date
        }
      },
      ingestionQuality: parsed.textBody.length > 0 ? "high" : "medium",
      parseWarnings: parsed.textBody.length > 0 ? undefined : ["Email body was empty after parsing."]
    };
  } catch {
    throw new Error(`Failed to parse email file "${context.file.name}".`);
  }
}
