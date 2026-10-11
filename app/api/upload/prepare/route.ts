import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prepareStoredUpload, getStoredUploadProcessingResult, UploadInputError } from "@/lib/uploads/stored-uploads";
import { authorizeHandoffUpload } from "@/lib/uploads/video-handoffs";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const input = await request.json();
    const handoff = input?.handoffRequestId;
    let result;
    if (handoff) {
      const meta = {
        requestId: z.string().uuid().parse(handoff),
        ordinal: z.number().int().min(0).max(4).parse(input.handoffIndex),
        name: input.name as string, type: input.type as string, size: input.size as number,
      };
      const prior = await authorizeHandoffUpload(meta);
      if (prior) {
        const completed = await getStoredUploadProcessingResult(prior.uploadToken);
        result = completed.status === "ready" ? { ...prior, fileReference: completed.fileReference } : prior;
      } else {
        const fresh = await prepareStoredUpload(input);
        result = await authorizeHandoffUpload(meta, fresh);
      }
    } else {
      result = await prepareStoredUpload(input);
    }
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to prepare attachment upload.";
    return NextResponse.json({ error: message }, {
      status: error instanceof UploadInputError || error instanceof SyntaxError || error instanceof z.ZodError ||
        /does not match|unavailable/.test(message) ? 400 : 500,
    });
  }
}
