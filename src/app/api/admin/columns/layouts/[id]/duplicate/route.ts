import { duplicateLayout } from "@/lib/columns/store";
import { requireSuperAdminApi, respond } from "@/lib/columns/api";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSuperAdminApi();
  if ("error" in auth) return auth.error;
  const { id } = await params;
  return respond(await duplicateLayout(auth.session.userId, id), 201);
}
