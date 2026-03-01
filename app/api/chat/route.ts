import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assembleContext } from "@/lib/memory/assemble-context";
import { maybeUpdateSummary } from "@/lib/memory/summarizer";
import { getAvailableProviders } from "@/lib/providers";
import { chooseProvider } from "@/lib/router/master-router";
import { saveMessage } from "@/lib/data/blob-store";

// Use the naming convention from your Frontend and Zod schema
const requestSchema = z.object({
  actorId: z.string().min(1),
  chatId: z.string().min(1),
  message: z.string().min(1),
  overrideProvider: z.string().min(1).optional(),
  overrideModel: z.string().min(1).optional()
});

export async function POST(request: NextRequest) {
  try {
    // LOG 1: Capture the incoming request
    const body = await request.json();
    console.log(`[Chat API] Received request body:`, JSON.stringify(body));

    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      console.error("[Chat API] Validation Failed:", parsed.error.format());
      return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
    }

    const { actorId, chatId, message, overrideProvider, overrideModel } = parsed.data;
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
              modelId
            });

            if (!result || (!result.text && !(result.content?.length))) {
              throw new Error(`AI Provider ${provider.name} returned an empty response.`);
            }

            const imageAssets =
              result.content
                ?.filter((part) => part.type === "image" && typeof part.url === "string")
                .map((part) => ({ type: "image", url: part.url as string })) ?? [];

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
    // LOG 8: Catch-all for 500 errors
    const errorMessage = error instanceof Error ? error.message : "Unexpected error";
    console.error("[Chat API] Fatal Runtime Error:", {
      message: errorMessage,
      stack: error instanceof Error ? error.stack : undefined
    });

    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
