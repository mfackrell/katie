import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assembleContext } from "@/lib/memory/assemble-context";
import { maybeUpdateSummary } from "@/lib/memory/summarizer";
import { getAvailableProviders } from "@/lib/providers";
import { chooseProvider } from "@/lib/router/master-router";
import { saveMessage } from "@/lib/data/blob-store";

const requestSchema = z.object({
  actorId: z.string().min(1),
  chatId: z.string().min(1),
  message: z.string().min(1)
});

export async function POST(request: NextRequest) {
  try {
    // LOG 1: Capture the raw incoming request
    const body = await request.json();
    console.log(`[Chat API] Incoming request body:`, JSON.stringify(body));

    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      console.error("[Chat API] Validation Failed:", parsed.error.format());
      return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
    }

    const { actorId, chatId, message } = parsed.data;

    // LOG 2: Verify IDs are extracted correctly
    console.log(`[Chat API] Processing - Actor: ${actorId}, Chat: ${chatId}`);

    const providers = getAvailableProviders();
    if (!providers.length) {
      console.error("[Chat API] Error: No providers configured in environment variables.");
      return NextResponse.json(
        { error: "No providers configured. Add OPENAI_API_KEY and/or GOOGLE_API_KEY." },
        { status: 500 }
      );
    }

    // LOG 3: Track context assembly and provider selection
    console.log(`[Chat API] Assembling context and selecting provider...`);
    const [systemContext, provider] = await Promise.all([
      assembleContext(actorId, chatId),
      chooseProvider(message, providers)
    ]);
    console.log(`[Chat API] Selected Provider: ${provider.name}`);

    // Save User Message
    await saveMessage(chatId, "user", message);

    // LOG 4: Start AI Generation
    console.log(`[Chat API] Sending request to AI provider...`);
    const result = await provider.generate({
      system: systemContext,
      user: message
    });

    if (!result || !result.text) {
      throw new Error("AI Provider returned an empty response.");
    }

    // LOG 5: Save Assistant Response
    console.log(`[Chat API] Generation successful. Saving assistant response.`);
    await saveMessage(chatId, "assistant", result.text);
    
    // Background task (doesn't block response)
    void maybeUpdateSummary(chatId).catch(err => 
      console.error("[Chat API] Background Summary Error:", err)
    );

    return NextResponse.json({ text: result.text }, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache"
      }
    });

  } catch (error: any) {
    // LOG 6: Global Catch-All for any crash in the route
    console.error("[Chat API] Fatal Runtime Error:", {
      message: error.message,
      stack: error.stack,
    });
    
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Unexpected error",
        details: error?.message 
      },
      { status: 500 }
    );
  }
}
