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
  message: z.string().min(1)
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

    const { actorId, chatId, message } = parsed.data;

    // LOG 2: Verification of IDs
    console.log(`[Chat API] Processing - Actor: ${actorId}, Chat: ${chatId}`);

    const providers = getAvailableProviders();
    if (!providers.length) {
      console.error("[Chat API] Error: No AI providers found in environment variables.");
      return NextResponse.json(
        { error: "No providers configured. Add OPENAI_API_KEY and/or GOOGLE_API_KEY." },
        { status: 500 }
      );
    }

    // LOG 3: Context Assembly & Provider Selection
    console.log(`[Chat API] Assembling context and selecting provider...`);
    const { persona, summary, history } = await assembleContext(actorId, chatId);
    const historyForProvider = history.map(({ role, content }) => ({ role, content }));
    const routingContext = `${persona}\n\nCONVERSATION SUMMARY:\n${summary}`;
    const [provider, modelId] = await chooseProvider(message, routingContext, providers);
    console.log(`[Chat API] Selected Provider: ${provider.name}, Model: ${modelId}`);

    // LOG 4: Save User Message to Blob
    console.log(`[Chat API] Saving user message...`);
    await saveMessage(chatId, "user", message);

    // LOG 5: Generate AI Response
    console.log(`[Chat API] Requesting generation from ${provider.name} using model ${modelId}...`);
    const result = await provider.generate({
      persona,
      summary,
      history: historyForProvider,
      user: message,
      modelId
    });

    if (!result || !result.text) {
      throw new Error(`AI Provider ${provider.name} returned an empty response.`);
    }

    // LOG 6: Save Assistant Response & Update Summary
    console.log(`[Chat API] Generation successful. Saving assistant response.`);
    await saveMessage(chatId, "assistant", result.text);
    
    // Non-blocking summary update
    void maybeUpdateSummary(chatId).catch((err: unknown) => 
      console.error("[Chat API] Background Summary Update Error:", err)
    );

    // LOG 7: Return final response
    // Note: Since your provider returns the full text, we return it as JSON.
    // If your frontend useChat hook requires a stream, we can wrap this text in one.
    return NextResponse.json({
      text: result.text,
      provider: result.provider,
      model: result.model
    }, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache"
      }
    });

  } catch (error: unknown) {
    // LOG 8: Catch-all for 500 errors
    const errorMessage = error instanceof Error ? error.message : "Unexpected error";
    console.error("[Chat API] Fatal Runtime Error:", {
      message: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });
    
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
