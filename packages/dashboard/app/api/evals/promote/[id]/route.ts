import { readRecentEvents } from "@/lib/agent-client";
import { generateEval } from "@/lib/promote-eval";
import { getSession } from "@/lib/queries";
import { handleRouteError, jsonError } from "../../../control/_http";

export const dynamic = "force-dynamic";

/**
 * GET /api/evals/promote/:id — turn a real session into an eve eval file.
 *
 * Returns the generated source as a download rather than writing it into the
 * user's repo. The dashboard runs in a container and does not know where the
 * agent project lives, and a generated test appearing unannounced in a working
 * tree is a bad surprise. The user saves it under `evals/` and sharpens the
 * suggested assertions.
 *
 * `?format=json` returns the same source plus the warnings, which is what the
 * browser UI uses so it can show them.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    if (!id) return jsonError("Missing session id.", 400, "bad_request");

    const session = await getSession(id);
    if (!session) return jsonError(`No session ${id}.`, 404, "not_found");

    // 4096 rather than the default lookback: a promoted eval must replay the
    // session from its first message, and a chatty session with tool calls
    // produces far more events than turns.
    const { events } = await readRecentEvents(id, { lookback: 4096, signal: request.signal });

    const generated = generateEval({ sessionId: id, title: session.title, events });

    if (new URL(request.url).searchParams.get("format") === "json") {
      return Response.json(generated);
    }

    return new Response(generated.source, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${generated.filename}"`,
      },
    });
  } catch (error) {
    return handleRouteError(error, request);
  }
}
