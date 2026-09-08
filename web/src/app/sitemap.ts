import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Five routes, listed by hand.
 *
 * The explorer is a single application route: the tree's deep links
 * (`?taxon=`, `?class=`) are query parameters over that same route, not
 * separate documents, so enumerating them would fill the sitemap with
 * thousands of URLs that all return the same page. The policy documents are
 * the only other real pages.
 *
 * `lastModified` is the date each document's text last changed, kept in step
 * with the "Last updated" line the page itself shows — a sitemap that claims
 * a policy changed today while the page says otherwise is worse than no date.
 */
const LAST_REVIEWED = "2026-09-08";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: LAST_REVIEWED,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/data-sources`,
      lastModified: LAST_REVIEWED,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified: LAST_REVIEWED,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/terms`,
      lastModified: LAST_REVIEWED,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/cookies`,
      lastModified: LAST_REVIEWED,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
