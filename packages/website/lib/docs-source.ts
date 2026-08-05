import { loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";

/* baseUrl is the route, NOT the deploy prefix — Next's basePath prepends
   /evestack on top of this at build time. Hardcoding the prefix here would
   double it. */
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
