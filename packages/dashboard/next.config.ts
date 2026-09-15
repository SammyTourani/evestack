import type { NextConfig } from "next";

/**
 * Response headers every page and route carries.
 *
 * WHY THESE THREE AND NOT A FULL POLICY. The dashboard renders session
 * transcripts — model output, tool arguments, whatever a page the agent
 * scraped happened to contain — so "the browser decides what this bytes is"
 * and "anyone may frame this" are not positions worth holding. A complete
 * Content-Security-Policy is a separate, measured pass: Next injects inline
 * bootstrap scripts, recharts writes inline styles, and a guessed
 * `script-src` that breaks the chat page is a worse outcome than the headers
 * below not existing. So the CSP here carries `frame-ancestors` and nothing
 * else — the one directive with no false-positive surface, because the
 * dashboard frames nothing and is framed by nothing (measured: no <iframe> in
 * app/ or components/).
 *
 * `frame-ancestors 'self'` is the clickjacking fix, and the reason it is not
 * redundant with the session cookie's SameSite=Lax is worth writing down.
 * Lax withholds the cookie from cross-SITE requests, and a site is scheme +
 * registrable domain — THE PORT IS NOT PART OF IT. A page served from
 * http://localhost:3000, which on a developer's machine is whatever else they
 * happen to be running, is same-site with this dashboard on :4000: it can
 * frame /chat, and the operator's cookie IS sent into that frame, so the
 * framed page is fully logged in. Overlay something clickable on the Approve
 * button and the operator approves a tool call they never saw. CSP's 'self' is
 * an ORIGIN test, not a site test, so it refuses :3000 where SameSite does
 * not. X-Frame-Options rides along for browsers that predate frame-ancestors;
 * browsers that support both ignore it.
 *
 * `Referrer-Policy: same-origin` and not the `strict-origin-when-cross-origin`
 * that packages/website ships. That one still sends the origin off-site, and
 * this origin is usually an internal hostname; the paths it protects are the
 * ones carrying session ids. The dashboard reads no Referer of its own
 * (grepped), so withholding it entirely costs nothing here. The website wants
 * referrers for attribution and has no session ids in its URLs, which is why
 * the two packages disagree on purpose.
 *
 * NOT HERE, DELIBERATELY: Strict-Transport-Security. The documented deployment
 * is http://localhost:4000, where it does nothing, and on the one where it
 * would apply — a dashboard published under a shared domain — it would also be
 * inherited by every sibling host under that name. That is the operator's
 * call to make at their proxy, not ours to make from inside a container.
 *
 * THESE VALUES ARE BAKED AT BUILD TIME, which is why none of them reads an
 * environment variable. Next resolves `headers()` during `next build` into
 * routes-manifest.json, and the published image runs `next build` in its
 * builder stage (packages/dashboard/Dockerfile), so an env var consulted here
 * would work under `next dev` and be silently frozen in the container — the
 * worst shape a knob can have. An operator who must embed the dashboard in
 * another origin's page overrides the header at the proxy in front of it.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "same-origin" },
];

const config: NextConfig = {
  // `pg` is a native-ish Node driver; keep it out of the bundler so Next does
  // not try to trace or inline it into a server bundle.
  serverExternalPackages: ["pg"],
  async headers() {
    // `/:path*` and not `/(.*)`: the same spelling packages/website uses, and it
    // matches every route including the API ones, which is where the nosniff
    // matters most — a JSON body sniffed as HTML is the shape of a stored-XSS.
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
