/**
 * The site's own canonical origin.
 *
 * Needed by three things that are wrong without it rather than merely
 * unstyled: `metadataBase` (which turns the Open Graph image into an
 * absolute URL — relative og:image is ignored by most crawlers), the
 * `sitemap.xml` entries, and the `Sitemap:` line in robots.txt.
 *
 * It is NOT `NEXT_PUBLIC_API_URL` — that is the API origin, which is a
 * different host in every deployment described in DEPLOY.md.
 *
 * Set `NEXT_PUBLIC_SITE_URL` in the hosting project's environment. Vercel
 * exposes `VERCEL_PROJECT_PRODUCTION_URL` for the production domain, which
 * is used as a fallback so a deploy that forgets the variable still emits
 * its real hostname rather than localhost. The final fallback is only
 * correct in local development.
 */
function resolveSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;

  return "http://localhost:3000";
}

export const SITE_URL = resolveSiteUrl();

/** True once a real origin is configured — i.e. not the dev fallback. */
export const SITE_URL_IS_CONFIGURED = SITE_URL !== "http://localhost:3000";
