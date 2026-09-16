import { listMemories } from "@/lib/memories";
import { handleRouteError, jsonError, jsonOk } from "@/app/api/control/_http";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const search = params.get("q")?.trim() ?? "";
  const limit = Number(params.get("limit") ?? 50);
  const offset = Number(params.get("offset") ?? 0);
  if (
    search.length > 200 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1_000_000
  )
    return jsonError(
      "Use a search of at most 200 characters, limit 1–100 and offset 0–1,000,000.",
      400,
      "bad_request",
    );
  try {
    const page = await listMemories({ search, limit, offset });
    return jsonOk({
      ...page,
      limit,
      offset,
      nextOffset:
        page.rows.length > 0 && offset + page.rows.length < page.total
          ? offset + page.rows.length
          : null,
    });
  } catch (error) {
    return handleRouteError(error, request);
  }
}
