import {
  ComposioError,
  composioApiKey,
  composioUserId,
  createConnectLink,
  resolveAuthConfigId,
} from "../composio";

/**
 * Starts the one-click sign-in.
 *
 * POST, not GET, because this creates records on Composio's side — a GET would
 * be fired by link prefetching. Returns 303 so the browser follows with a GET
 * to whatever authorization page the app uses.
 */
/** Composio's own slugs are short; this is generous and still bounded. */
const MAX_TOOLKIT_SLUG_LENGTH = 64;

/**
 * A form POST is a CORS-simple request, so any page the user visits can submit
 * this one cross-origin and create real records on their Composio account. The
 * dashboard ships no session cookie to hang a CSRF token off, so the check is
 * the request's own provenance: same-origin, or no Origin at all (curl, an
 * OTLP-style client). `Sec-Fetch-Site` is sent by every current browser and is
 * not settable from script.
 */
function isCrossSite(request: Request, expectedOrigin: string): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin.replace(/\/+$/, "") !== expectedOrigin;
}

export async function POST(request: Request): Promise<Response> {
  const requestOrigin = new URL(request.url).origin;
  const origin = (process.env.EVESTACK_PUBLIC_URL?.trim() || requestOrigin).replace(/\/+$/, "");
  const back = (params: Record<string, string>) =>
    Response.redirect(`${origin}/integrations?${new URLSearchParams(params)}`, 303);

  if (isCrossSite(request, origin) && isCrossSite(request, requestOrigin)) {
    return Response.json(
      { error: "Cross-site connect requests are refused." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }

  const form = await request.formData();
  const toolkit = String(form.get("toolkit") ?? "").trim().toLowerCase();

  // Slugs land in a URL path, so refuse anything that is not one. Length is
  // bounded because the pattern alone happily accepted 5,000 characters.
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(toolkit) || toolkit.length > MAX_TOOLKIT_SLUG_LENGTH) {
    return back({ error: "That is not a valid app id." });
  }

  const apiKey = composioApiKey();
  if (!apiKey) {
    return back({ error: "COMPOSIO_API_KEY is not set on the dashboard." });
  }

  try {
    const authConfigId = await resolveAuthConfigId(apiKey, toolkit);
    const url = await createConnectLink(apiKey, {
      authConfigId,
      userId: composioUserId(),
      callbackUrl: `${origin}/integrations?connected=${encodeURIComponent(toolkit)}`,
    });

    // The URL comes from an authenticated API call, but it is still a redirect
    // target read off the wire — refuse anything that is not plain https.
    if (!URL.parse(url)?.protocol.startsWith("https")) {
      return back({ toolkit, error: "Composio returned an authorization URL we will not follow." });
    }
    return Response.redirect(url, 303);
  } catch (error) {
    const message =
      error instanceof ComposioError || error instanceof Error ? error.message : String(error);
    return back({ toolkit, error: message.slice(0, 300) });
  }
}
