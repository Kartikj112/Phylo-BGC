/**
 * The API origin the browser is allowed to talk to.
 *
 * Read here rather than hard-coded because the CSP has to name it explicitly:
 * `connect-src` is a deny-list-by-omission, so a policy that forgets the API
 * host breaks every fetch on the page. Falls back to the local dev API.
 */
const apiOrigin = (() => {
  const raw = process.env.NEXT_PUBLIC_API_URL?.trim() || "http://127.0.0.1:8000";
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
})();

/**
 * Content Security Policy.
 *
 * **`'unsafe-inline'` on script-src is a measured trade-off, not an oversight.**
 * It was written strict first (`script-src 'self'`), built, and loaded in
 * Chromium: every route threw React error #412 and two CSP violations per
 * page. Next's App Router ships hydration state in inline `<script>` tags
 * (`self.__next_f.push(...)`), so blocking them leaves the server-rendered
 * HTML on screen and the app dead — the tree does not pan, zoom or filter.
 *
 * The supported strict alternative is a per-request nonce, and Next's own
 * guidance is explicit that nonces require dynamic rendering. All eleven
 * routes here prerender as static, and the frontend is a shell that fetches
 * everything from the API at runtime, so going dynamic would trade CDN-cached
 * static delivery for a server invocation per request to protect a surface
 * that is close to empty: the app renders no user-supplied HTML anywhere.
 * There is no `dangerouslySetInnerHTML`, no `innerHTML` outside a test, no
 * `eval`, and no d3 `.html()` sink — every value from the API goes through
 * React's escaping.
 *
 * So the remaining directives are the ones doing the work here: `object-src
 * 'none'`, `base-uri 'self'` (which blocks the `<base>` hijack that would
 * otherwise repoint every relative script URL), `form-action 'self'`, and a
 * `connect-src` that names exactly one API origin. Revisit this if the app
 * ever renders untrusted markup or adds authentication — at that point the
 * nonce is worth the dynamic rendering.
 *
 * `'unsafe-inline'` on style-src is separate and unavoidable in the same way:
 * the tree is D3-driven SVG whose marks carry computed inline styles.
 */
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // data: covers the exported figure's inline raster previews; blob: is what
  // the SVG/PDF download is handed to the browser as.
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self'",
  `connect-src 'self' ${apiOrigin}`,
  "upgrade-insecure-requests",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Nothing here is served over plain HTTP in any deployment described in
  // DEPLOY.md (Vercel, Render and Fly all terminate TLS and redirect), so
  // these are belt-and-braces rather than the only enforcement — with the
  // exception of HSTS, which is the only one of them a browser remembers.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
          },
          {
            // Two years, subdomains included. NOT preloaded: submitting to
            // the preload list is effectively irreversible for the apex
            // domain and is the owner's decision, not a default.
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
