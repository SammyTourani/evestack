import { loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";

/* baseUrl is the route the docs mount at, and the site is served from the
   domain root, so it is also the full path. (It was written when the site
   still deployed under a /evestack prefix on GitHub Pages; that prefix is
   gone, and nothing here should ever hardcode a deploy prefix again.) */
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
