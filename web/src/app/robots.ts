import type { MetadataRoute } from "next";
import { SITE_URL, SITE_URL_IS_CONFIGURED } from "@/lib/site";

/**
 * Everything here is public and meant to be found, so the rules are open.
 *
 * The one exception is the API origin, which is a different host entirely
 * and therefore cannot be governed from this file — it needs its own
 * robots.txt, served by the API. See engine/src/bgcscape/api/app.py.
 */
export default function robots(): MetadataRoute.Robots {
  // A deploy that forgets NEXT_PUBLIC_SITE_URL falls back to localhost, and
  // every absolute URL in robots.txt and sitemap.xml then points somewhere
  // no crawler can reach. Publishing that is worse than publishing nothing:
  // it advertises a sitemap that 404s from the outside. Disallow instead,
  // so a misconfigured origin fails visibly rather than into the index.
  if (!SITE_URL_IS_CONFIGURED) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
