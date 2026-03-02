import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assembleContext } from "@/lib/memory/assemble-context";
import { maybeUpdateSummary } from "@/lib/memory/summarizer";
import { getAvailableProviders } from "@/lib/providers";
import { chooseProvider } from "@/lib/router/master-router";
import { saveMessage } from "@/lib/data/blob-store";
import { parseTextFiles, type ParsedAttachment } from "@/lib/uploads/parse-text-files";

// Use the naming convention from your Frontend and Zod schema
const requestSchema = z.object({
  actorId: z.string().min(1),
  chatId: z.string().min(1),
  message: z.string().min(1),
  images: z.array(z.string()).optional(),
  overrideProvider: z.string().min(1).optional(),
  overrideModel: z.string().min(1).optional()
});

type RequestPayload = z.infer<typeof requestSchema>;

function readOptionalString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function parseIncomingPayload(request: NextRequest): Promise<{ payload: RequestPayload; files: File[] }> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const imageValues = formData
      .getAll("images")
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    const payload = {
      actorId: readOptionalString(formData, "actorId") ?? "",
      chatId: readOptionalString(formData, "chatId") ?? "",
      message: readOptionalString(formData, "message") ?? "",
      images: imageValues.length ? imageValues : undefined,
      overrideProvider: readOptionalString(formData, "overrideProvider"),
      overrideModel: readOptionalString(formData, "overrideModel")
    };

    const parsed = requestSchema.safeParse(payload);

    if (!parsed.success) {
      console.error("[Chat API] Validation Failed:", parsed.error.format());
      throw new Error("Invalid request payload");
    }

    const files = formData.getAll("files").filter((value): value is File => value instanceof File);

    return { payload: parsed.data, files };
  }

  const body = await request.json();
  console.log(`[Chat API] Received request body:`, JSON.stringify(body));

  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    console.error("[Chat API] Validation Failed:", parsed.error.format());
    throw new Error("Invalid request payload");
  }

  return { payload: parsed.data, files: [] };
}

function extractImageUrl(part: { type?: string; [key: string]: unknown }): string | null {
  if (typeof part.url === "string") {
    return part.url;
  }

  if (typeof part.image_url === "string") {
    return part.image_url;
  }

  if (
    part.image_url &&
    typeof part.image_url === "object" &&
    "url" in part.image_url &&
    typeof (part.image_url as { url?: unknown }).url === "string"
  ) {
    return (part.image_url as { url: string }).url;
  }

  if (typeof part.b64_json === "string") {
    return `data:image/png;base64,${part.b64_json}`;
  }

  if (part.inlineData && typeof part.inlineData === "object") {
    const inlineData = part.inlineData as Record<string, unknown>;
    const data = typeof inlineData.data === "string" ? inlineData.data : null;

    if (!data) {
      return null;
    }

    const mimeType = typeof inlineData.mimeType === "string" ? inlineData.mimeType : "image/png";

    return `data:${mimeType};base64,${data}`;
  }

  return null;
}

export async function POST(request: NextRequest) {
  try {
    // LOG 1: Capture and normalize the incoming request
    const { payload, files } = await parseIncomingPayload(request);
    const { actorId, chatId, message, images, overrideProvider, overrideModel } = payload;
    let attachments: ParsedAttachment[] | undefined;

    if (files.length) {
      const nonImageFiles = files.filter((file) => !file.type.startsWith("image/"));
      if (nonImageFiles.length) {
        attachments = await parseTextFiles(nonImageFiles);
      }
    }

    const encoder = new TextEncoder();

    // LOG 2: Verification of IDs
    console.log(`[Chat API] Processing - Actor: ${actorId}, Chat: ${chatId}`);

    const providers = getAvailableProviders();
    if (!providers.length) {
      console.error("[Chat API] Error: No AI providers found in environment variables.");
      return NextResponse.json(
        { error: "No providers configured. Add OPENAI_API_KEY, GOOGLE_API_KEY, grok_api_key, and/or CLAUDE_API_KEY." },
        { status: 500 }
      );
    }

    // LOG 3: Context Assembly & Provider Selection
    console.log(`[Chat API] Assembling context and selecting provider...`);
    const { persona, summary, history } = await assembleContext(actorId);
    const historyForProvider = history.map(({ role, content }) => ({ role, content }));
    let provider = providers[0];
    let modelId = "";

    if (overrideProvider && overrideModel) {
      const manualProvider = providers.find((candidate) => candidate.name === overrideProvider);
      if (!manualProvider) {
        return NextResponse.json({ error: `Unknown override provider: ${overrideProvider}` }, { status: 400 });
      }

      provider = manualProvider;
      modelId = overrideModel;
      console.log(`[Chat API] Override active. Provider: ${provider.name}, Model: ${modelId}`);
    } else {
      const routingContext = `
  Persona: ${persona}
  Recent History: ${JSON.stringify(history.slice(-3))}
`;
      const routingDecision = await chooseProvider(message, routingContext, providers);
      provider = routingDecision.provider;
      modelId = routingDecision.modelId;
      console.log(`[Chat API] Selected Provider: ${provider.name}, Model: ${modelId}`);
      console.log(`[Chat API] Routing Model For UI: ${routingDecision.routerModel}`);
      console.log(`[Chat API] Routing Reasoning: ${routingDecision.reasoning}`);
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          try {
            const metadataChunk = JSON.stringify({
              type: "metadata",
              modelId,
              provider: provider.name
            });
            controller.enqueue(encoder.encode(`${metadataChunk}\n`));

            // LOG 4: Save User Message to Blob
            console.log(`[Chat API] Saving user message...`);
            await saveMessage(actorId, "user", message, chatId);

            // LOG 5: Generate AI Response
            console.log(`[Chat API] Requesting generation from ${provider.name} using model ${modelId}...`);
            const result = await provider.generate({
              persona,
              summary,
              history: historyForProvider,
              user: message,
              images,
              modelId,
              attachments
            });

            if (!result || (!result.text && !(result.content?.length))) {
              throw new Error(`AI Provider ${provider.name} returned an empty response.`);
            }

            const imageAssets =
              result.content
                ?.map((part) => {
                  const partType = typeof part.type === "string" ? part.type.toLowerCase() : "";
                  if (!partType.includes("image")) {
                    return null;
                  }

                  const url = extractImageUrl(part);
                  if (!url) {
                    return null;
                  }

                  return { type: "image", url };
                })
                .filter((asset): asset is { type: "image"; url: string } => Boolean(asset)) ?? [];

            const contentChunk = JSON.stringify({
              type: "content",
              text: result.text,
              assets: imageAssets,
              provider: result.provider,
              model: result.model
            });
            controller.enqueue(encoder.encode(`${contentChunk}\n`));

            // LOG 6: Save Assistant Response & Update Summary
            console.log(`[Chat API] Generation successful. Saving assistant response.`);
            await saveMessage(actorId, "assistant", result.text, chatId, result.model, imageAssets);

            // Non-blocking summary update
            void maybeUpdateSummary(actorId).catch((err: unknown) =>
              console.error("[Chat API] Background Summary Update Error:", err)
            );

            controller.close();
          } catch (error: unknown) {
            console.error("[Chat API] Stream Runtime Error:", error);
            controller.error(error);
          }
        })();
      }
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache"
      }
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unexpected error";

    if (errorMessage === "Invalid request payload" || errorMessage.includes("Unsupported file type") || errorMessage.includes("Too many files") || errorMessage.includes("too large")) {
      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    // LOG 8: Catch-all for 500 errors
    console.error("[Chat API] Fatal Runtime Error:", {
      message: errorMessage,
      stack: error instanceof Error ? error.stack : undefined
    });

    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
