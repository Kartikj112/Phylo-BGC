import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Everything here is public and meant to be found, so the rules are open.
 *
 * The one exception is the API origin, which is a different host entirely
 * and therefore cannot be governed from this file — it needs its own
 * robots.txt, served by the API. See engine/src/bgcscape/api/app.py.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
