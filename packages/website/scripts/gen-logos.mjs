/* Generates local brand SVGs from simple-icons into public/logos/, each
   filled with the brand's OFFICIAL hex color (si.hex). Rendered on white
   tiles in the UI so dark marks (GitHub, Notion) work in both themes.
   Nominative use: identifying the third-party services the agent
   integrates with. Slack's mark was removed from simple-icons at the
   brand's request — Slack stays text-only in copy. */
import * as icons from "simple-icons";
import { mkdir, writeFile } from "node:fs/promises";

const outDir = new URL("../public/logos/", import.meta.url).pathname;
await mkdir(outDir, { recursive: true });

const wanted = [
  ["siGmail", "gmail"],
  ["siGithub", "github"],
  ["siNotion", "notion"],
  ["siLinear", "linear"],
  ["siGooglecalendar", "googlecalendar"],
  ["siAirtable", "airtable"],
  ["siDiscord", "discord"],
  ["siJira", "jira"],
  ["siHubspot", "hubspot"],
  ["siStripe", "stripe"],
  ["siFigma", "figma"],
  ["siDropbox", "dropbox"],
  ["siGoogledrive", "googledrive"],
  ["siGooglesheets", "googlesheets"],
  ["siAsana", "asana"],
  ["siTrello", "trello"],
  ["siClickup", "clickup"],
  ["siTodoist", "todoist"],
  ["siZendesk", "zendesk"],
  ["siCalendly", "calendly"],
  ["siShopify", "shopify"],
  ["siMailchimp", "mailchimp"],
  ["siZoom", "zoom"],
  ["siReddit", "reddit"],
];

for (const [key, slug] of wanted) {
  const icon = icons[key];
  if (!icon) {
    console.log("MISSING", key);
    continue;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#${icon.hex}" d="${icon.path}"/></svg>\n`;
  await writeFile(`${outDir}${slug}.svg`, svg);
  console.log("wrote", slug, `#${icon.hex}`);
}
