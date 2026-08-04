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
export async function POST(request: Request): Promise<Response> {
  const origin = (
    process.env.EVESTACK_PUBLIC_URL?.trim() || new URL(request.url).origin
  ).replace(/\/+$/, "");
  const back = (params: Record<string, string>) =>
    Response.redirect(`${origin}/integrations?${new URLSearchParams(params)}`, 303);

  const form = await request.formData();
  const toolkit = String(form.get("toolkit") ?? "").trim().toLowerCase();

  // Slugs land in a URL path, so refuse anything that is not one.
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(toolkit)) {
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
