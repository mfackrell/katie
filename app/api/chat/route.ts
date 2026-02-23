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
  const body = await request.json();
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
  }

  const { actorId, chatId, message } = parsed.data;

  try {
    const providers = getAvailableProviders();
    if (!providers.length) {
      return NextResponse.json(
        {
          error:
            "No providers configured. Add OPENAI_API_KEY and/or GOOGLE_API_KEY in Vercel project environment variables."
        },
        { status: 500 }
      );
    }

    const [systemContext, provider] = await Promise.all([
      assembleContext(actorId, chatId),
      chooseProvider(message, providers)
    ]);

    await saveMessage(chatId, "user", message);

    const result = await provider.generate({
      system: systemContext,
      user: message
    });

    await saveMessage(chatId, "assistant", result.text);
    void maybeUpdateSummary(chatId);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              provider: result.provider,
              model: result.model,
              text: result.text
            })
          )
        );
        controller.close();
      }
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache"
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unexpected error" },
      { status: 500 }
    );
  }
}
