import { NextRequest, NextResponse } from "next/server";
import { buildFileReferences } from "@/lib/uploads/build-file-references";

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") ?? "";

    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json({ error: "Expected multipart/form-data request." }, { status: 400 });
    }

    const formData = await request.formData();
    const files = formData.getAll("files").filter((value): value is File => value instanceof File);

    if (files.length === 0) {
      return NextResponse.json({ error: "No files were uploaded." }, { status: 400 });
    }

    const fileReferences = await buildFileReferences(files);

    return NextResponse.json({ fileReferences }, { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected upload error.";
    const isClientError =
      message.includes("Unsupported file type") ||
      message.includes("Too many files") ||
      message.includes("too large") ||
      message.includes("empty") ||
      message.includes("Failed to parse");

    return NextResponse.json({ error: message }, { status: isClientError ? 400 : 500 });
  }
}
