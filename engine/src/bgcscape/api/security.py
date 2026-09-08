"""Transport-level protections for the public API.

Three things, none of which belong in a route handler:

1. **Security response headers** — the API serves JSON and file downloads to
   a browser, so the sniffing/framing headers apply to it as much as to the
   frontend.
2. **A request body ceiling** — `/api/v1/export` and the upload route both
   take bodies, and without a limit the only ceiling is the platform's.
3. **Rate limiting** — the write endpoints are unauthenticated by design
   (see DEPLOY.md 4b), so throughput is the only thing standing between a
   public deployment and someone filling the shared corpus.

**What the rate limiter is not.** It is an in-process, in-memory counter. It
resets when the container restarts, and two containers behind a load balancer
each get their own allowance. That is honest for the deployment this project
actually has — one free-tier container that idles out — and it is *not* a
defence against a distributed flood, which has to be handled upstream at the
CDN or platform. It is here to stop casual abuse and accidental loops, and
that is the whole claim.
"""
from __future__ import annotations

import os
import time
from collections import defaultdict, deque

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

#: Requests allowed per window, per client, for the endpoints that write or
#: render. Reads are not limited here: they are cheap, cached and gzipped, and
#: the tree endpoint is the entire point of the service.
WRITE_RATE_LIMIT = int(os.getenv("BGCSCAPE_WRITE_RATE_LIMIT", "20"))

#: Window length in seconds.
RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("BGCSCAPE_RATE_LIMIT_WINDOW", "300"))

#: Largest request body accepted, for any route. The upload route applies its
#: own smaller per-file cap (BGCSCAPE_MAX_UPLOAD_MB); this is the outer bound
#: that stops a body being read into memory at all.
MAX_REQUEST_BYTES = int(os.getenv("BGCSCAPE_MAX_REQUEST_MB", "160")) * 1024 * 1024

#: Path prefixes the limiter covers — everything that costs real work.
RATE_LIMITED_PREFIXES = ("/api/v1/ingest", "/api/v1/export")


def _client_key(request: Request) -> str:
    """Identify the caller for rate-limiting purposes.

    Behind Render/Fly/Vercel the socket peer is the platform's proxy, so the
    left-most `X-Forwarded-For` entry is the real client. That header is
    caller-supplied and trivially spoofed when it is *not* behind such a
    proxy, which is why this is only ever used for rate limiting and never
    for authorisation or logging that anything depends on.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


#: Live limiter instances, so the counters can be cleared between tests.
#:
#: The limiter is per-process by design, which means a test suite sharing one
#: app instance accumulates hits across unrelated tests and the twenty-first
#: upload test fails with a 429 that has nothing to do with what it asserts.
#: The fixture in tests/conftest.py calls `reset_rate_limits()`; keeping the
#: limiter ENABLED during tests rather than switching it off there means the
#: production path is the one being exercised.
_LIVE_LIMITERS: "list[RateLimitMiddleware]" = []


def reset_rate_limits() -> None:
    """Forget every recorded hit. For tests, and for nothing else."""
    for limiter in _LIVE_LIMITERS:
        limiter._hits.clear()


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Sliding-window rate limit over the writing/rendering routes."""

    def __init__(self, app, *, limit: int = WRITE_RATE_LIMIT, window: int = RATE_LIMIT_WINDOW_SECONDS):
        super().__init__(app)
        self._limit = limit
        self._window = window
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        _LIVE_LIMITERS.append(self)

    async def dispatch(self, request: Request, call_next):
        if not request.url.path.startswith(RATE_LIMITED_PREFIXES):
            return await call_next(request)
        # A preflight is not a request for the work, and refusing it would
        # surface as an opaque CORS failure rather than as "slow down".
        if request.method == "OPTIONS":
            return await call_next(request)

        now = time.monotonic()
        key = _client_key(request)
        hits = self._hits[key]
        while hits and now - hits[0] > self._window:
            hits.popleft()

        if len(hits) >= self._limit:
            retry_after = int(self._window - (now - hits[0])) + 1
            return JSONResponse(
                status_code=429,
                content={
                    "detail": (
                        f"Rate limit reached: {self._limit} requests per "
                        f"{self._window // 60} minutes for uploads and exports. "
                        f"Try again in {retry_after}s."
                    )
                },
                headers={"Retry-After": str(retry_after)},
            )

        hits.append(now)
        # Unbounded growth otherwise: one entry per distinct client, kept
        # forever. Cheap to sweep because the deques are already trimmed.
        if len(self._hits) > 4096:
            for stale in [k for k, v in self._hits.items() if not v]:
                del self._hits[stale]
        return await call_next(request)


class MaxBodySizeMiddleware(BaseHTTPMiddleware):
    """Refuse an oversized body on the declared Content-Length.

    Checked before the route reads anything, so a large upload is rejected
    with a 413 rather than being streamed into memory first. A request that
    lies about its length, or omits it entirely with chunked encoding, still
    meets the per-file caps inside the upload handler — this is the cheap
    outer guard, not the only one.
    """

    def __init__(self, app, *, max_bytes: int = MAX_REQUEST_BYTES):
        super().__init__(app)
        self._max = max_bytes

    async def dispatch(self, request: Request, call_next):
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > self._max:
            return JSONResponse(
                status_code=413,
                content={
                    "detail": (
                        f"Request body exceeds the {self._max // (1024 * 1024)} MB limit."
                    )
                },
            )
        return await call_next(request)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Response headers that cost nothing and close real classes of bug."""

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        # The API returns JSON, SVG and PDF. Sniffing an SVG as HTML is the
        # specific hazard: SVG can carry script, and /api/v1/export echoes a
        # caller-supplied document back. The Content-Disposition attachment
        # on that route already forces a download; this is the second lock.
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        # No route renders HTML, so nothing here should ever be framed.
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault(
            "Content-Security-Policy",
            # An API that serves no HTML needs no sources at all. `sandbox`
            # neuters any SVG a browser is talked into rendering inline.
            "default-src 'none'; frame-ancestors 'none'; sandbox",
        )
        response.headers.setdefault(
            "Permissions-Policy", "geolocation=(), microphone=(), camera=(), interest-cohort=()"
        )
        return response
