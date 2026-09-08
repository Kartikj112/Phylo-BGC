"""The transport-level protections, exercised through the real HTTP layer.

These are all things that only exist as middleware, so a unit test of the
route functions would pass with every one of them removed. They go through
TestClient for the same reason the CORS preflight test does: the failure mode
being guarded against is one the in-process call never reaches.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from bgcscape.api.app import app
from bgcscape.api.security import (
    RATE_LIMITED_PREFIXES,
    WRITE_RATE_LIMIT,
    reset_rate_limits,
)


@pytest.fixture()
def client() -> TestClient:
    reset_rate_limits()
    return TestClient(app)


# --- response headers ------------------------------------------------------


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ],
)
def test_security_headers_are_present_on_every_response(client, header, expected):
    response = client.get("/api/v1/health")
    assert response.headers.get(header) == expected


def test_csp_forbids_everything_because_the_api_renders_no_html(client):
    """`default-src 'none'` is correct here in a way it would not be on a page.

    The API returns JSON, SVG and PDF and never a document, so there is no
    legitimate resource for a CSP to allow. The `sandbox` directive is the
    load-bearing part: /api/v1/export echoes a caller-supplied SVG back, and
    SVG can carry script if a browser is ever persuaded to render it inline
    rather than download it.
    """
    csp = client.get("/api/v1/health").headers.get("Content-Security-Policy", "")
    assert "default-src 'none'" in csp
    assert "frame-ancestors 'none'" in csp
    assert "sandbox" in csp


# --- rate limiting ---------------------------------------------------------


def test_export_is_rate_limited_after_the_allowance(client):
    """The write/render routes stop answering once the window is spent."""
    body = {"svg": "<svg xmlns='http://www.w3.org/2000/svg'/>", "view_config": {}, "format": "svg"}

    statuses = [client.post("/api/v1/export", json=body).status_code for _ in range(WRITE_RATE_LIMIT + 5)]

    assert 429 in statuses, "the limiter never fired"
    # Everything after the first 429 stays limited: the window has not moved.
    first_limited = statuses.index(429)
    assert all(s == 429 for s in statuses[first_limited:])
    assert first_limited <= WRITE_RATE_LIMIT


def test_a_rate_limited_response_says_when_to_retry(client):
    body = {"svg": "<svg xmlns='http://www.w3.org/2000/svg'/>", "view_config": {}, "format": "svg"}
    for _ in range(WRITE_RATE_LIMIT + 1):
        response = client.post("/api/v1/export", json=body)

    assert response.status_code == 429
    assert response.headers.get("Retry-After", "").isdigit()
    assert "Rate limit" in response.json()["detail"]


def test_reads_are_never_rate_limited(client):
    """The tree is the product; limiting it would break the app, not protect it."""
    reset_rate_limits()
    statuses = {client.get("/api/v1/health").status_code for _ in range(WRITE_RATE_LIMIT * 3)}
    assert statuses == {200}


def test_the_limiter_covers_both_write_paths():
    """Guards the prefix list against a new write route being added outside it."""
    assert "/api/v1/ingest" in RATE_LIMITED_PREFIXES
    assert "/api/v1/export" in RATE_LIMITED_PREFIXES


def test_clients_are_counted_separately(client):
    """One noisy caller must not lock everyone else out.

    X-Forwarded-For is what identifies a caller behind the platform proxy, so
    this also pins the header actually being read.
    """
    body = {"svg": "<svg xmlns='http://www.w3.org/2000/svg'/>", "view_config": {}, "format": "svg"}
    for _ in range(WRITE_RATE_LIMIT + 1):
        client.post("/api/v1/export", json=body, headers={"X-Forwarded-For": "198.51.100.7"})

    other = client.post("/api/v1/export", json=body, headers={"X-Forwarded-For": "203.0.113.9"})
    assert other.status_code != 429


# --- body size -------------------------------------------------------------


def test_an_oversized_body_is_refused_on_content_length(client):
    """Refused before the route reads it, so nothing large is ever buffered."""
    from bgcscape.api.security import MAX_REQUEST_BYTES

    response = client.post(
        "/api/v1/export",
        content=b"x",  # the declared length is the lie being caught
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(MAX_REQUEST_BYTES + 1),
        },
    )
    assert response.status_code == 413


# --- crawlability ----------------------------------------------------------


def test_the_api_asks_not_to_be_indexed(client):
    """The API is a different origin, so the site's robots.txt cannot cover it."""
    response = client.get("/robots.txt")
    assert response.status_code == 200
    assert "Disallow: /" in response.text
