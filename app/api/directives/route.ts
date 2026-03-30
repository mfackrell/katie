import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deactivateDirective,
  listDirectivesForActor,
  saveDirective,
  syncActorSystemPromptWithDirectives,
} from "@/lib/data/persistence-store";
import { DIRECTIVE_KINDS, type DirectiveKind } from "@/lib/types/directives";

const createDirectiveSchema = z.object({
  actorId: z.string().min(1),
  userId: z.string().min(1),
  directive: z.string().trim().min(1),
  kind: z.enum(DIRECTIVE_KINDS).optional(),
});

const listDirectiveQuerySchema = z.object({
  actorId: z.string().min(1),
  userId: z.string().min(1).optional(),
});

const deactivateDirectiveSchema = z.object({
  directiveId: z.string().min(1),
  actorId: z.string().min(1),
  userId: z.string().min(1).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const parsed = listDirectiveQuerySchema.parse({
      actorId: url.searchParams.get("actorId"),
      userId: url.searchParams.get("userId") ?? undefined,
    });

    const directives = await listDirectivesForActor(parsed.actorId, parsed.userId);
    return NextResponse.json({ directives }, { headers: { "Cache-Control": "no-cache" } });
  } catch {
    return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = createDirectiveSchema.parse(await request.json());
    const kind: DirectiveKind = parsed.kind ?? "preference";
    const result = await saveDirective({
      actorId: parsed.actorId,
      userId: parsed.userId,
      directive: parsed.directive,
      kind,
      scope: "actor",
    });

    await syncActorSystemPromptWithDirectives(parsed.actorId, parsed.userId);
    return NextResponse.json({ directive: result.directive, created: result.created }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const parsed = deactivateDirectiveSchema.parse(await request.json());
    await deactivateDirective(parsed.directiveId);
    await syncActorSystemPromptWithDirectives(parsed.actorId, parsed.userId);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Invalid request payload" }, { status: 400 });
  }
}
