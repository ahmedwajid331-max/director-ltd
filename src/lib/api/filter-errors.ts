import { NextResponse } from "next/server";
import { FilterValidationError } from "@/lib/filters/validate";

// Turns a filter validation failure into a controlled 400 response. Returns
// null for any other error so the caller can rethrow it.
export function filterErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof FilterValidationError) {
    return NextResponse.json({ error: "Invalid filter.", details: err.details.slice(0, 10) }, { status: 400 });
  }
  return null;
}
