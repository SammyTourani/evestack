/* Generates local monochrome brand SVGs (fill=currentColor) from
   simple-icons into public/logos/. Nominative use: identifying the
   third-party services the agent integrates with. */
import * as icons from "simple-icons";
import { mkdir, writeFile } from "node:fs/promises";

const outDir = new URL("../public/logos/", import.meta.url).pathname;
await mkdir(outDir, { recursive: true });

const wanted = [
  ["siGmail", "gmail"],
  ["siGithub", "github"],
  ["siSlack", "slack"],
  ["siNotion", "notion"],
  ["siLinear", "linear"],
  ["siGooglecalendar", "googlecalendar"],
  ["siAirtable", "airtable"],
  ["siDiscord", "discord"],
  ["siJira", "jira"],
  ["siHubspot", "hubspot"],
  ["siStripe", "stripe"],
];

for (const [key, slug] of wanted) {
  const icon = icons[key];
  if (!icon) {
    console.log("MISSING", key);
    continue;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="${icon.path}"/></svg>\n`;
  await writeFile(`${outDir}${slug}.svg`, svg);
  console.log("wrote", slug);
}
