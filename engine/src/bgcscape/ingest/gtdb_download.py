"""Fetch a GTDB release's metadata files, so the backbone needs no manual download.

`bgcscape fetch-gtdb-backbone` uses this, then hands the files to
`ingest/backbone.py`. Only the two metadata tables are fetched
(`bac120_metadata_r<release>.tsv.gz`, ~290 MB, and `ar53_metadata_...`,
~7 MB); nothing else in a release is needed for the backbone.

Every file is checked against the MD5 GTDB publishes in the release's own
`MD5SUM.txt`. A truncated download is the likely failure on a slow
connection, and a truncated gzip would otherwise surface much later as a
parse error halfway through 900,000 rows. A file already in the cache that
passes the check is not fetched again, so a second run costs nothing.

Verified against GTDB release 232 (April 2026): the URLs below answer, and
the published MD5s match the files.
"""
from __future__ import annotations

import hashlib
import shutil
import sys
import urllib.request
from collections.abc import Callable
from pathlib import Path

DEFAULT_BASE_URL = "https://data.gtdb.ecogenomic.org/releases"

#: Metadata files the backbone reads, per domain.
METADATA_FILES = ("bac120_metadata_r{release}.tsv.gz", "ar53_metadata_r{release}.tsv.gz")


class GtdbDownloadError(RuntimeError):
    pass


def release_url(release: str, filename: str, base_url: str = DEFAULT_BASE_URL) -> str:
    """URL of one file in a GTDB release, e.g. release "232" -> .../release232/232.0/<file>."""
    return f"{base_url.rstrip('/')}/release{release}/{release}.0/{filename}"


def parse_md5sum(text: str) -> dict[str, str]:
    """`MD5SUM.txt` lines ("<md5>  ./<path>") -> {basename: md5}."""
    sums: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and len(parts[0]) == 32:
            sums[Path(parts[1]).name] = parts[0].lower()
    return sums


def file_md5(path: Path) -> str:
    digest = hashlib.md5()  # noqa: S324 - integrity check against GTDB's published MD5, not security
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _default_progress(name: str) -> Callable[[int, int | None], None]:
    last = [-1]

    def report(done: int, total: int | None) -> None:
        if total:
            pct = done * 100 // total
            if pct != last[0] and pct % 5 == 0:
                last[0] = pct
                print(f"\r  {name}: {pct:3d}% of {total / 1e6:.0f} MB", end="", file=sys.stderr, flush=True)
        if total and done >= total:
            print(file=sys.stderr)

    return report


def download(
    url: str,
    dest: Path,
    expected_md5: str | None = None,
    progress: Callable[[int, int | None], None] | None = None,
) -> Path:
    """Fetch `url` to `dest` unless a copy with the right MD5 is already there.

    Written to `<dest>.part` and renamed only once complete and verified, so
    an interrupted run never leaves a file that looks finished.
    """
    if dest.exists() and expected_md5 and file_md5(dest) == expected_md5:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    try:
        with urllib.request.urlopen(url, timeout=60) as response, part.open("wb") as out:  # noqa: S310 - fixed GTDB/https or caller-supplied URL
            # From the header rather than `.length`, which only HTTP responses have.
            total = int(response.headers.get("Content-Length") or 0) or None
            done = 0
            while True:
                block = response.read(1 << 20)
                if not block:
                    break
                out.write(block)
                done += len(block)
                if progress:
                    progress(done, total)
    except OSError as exc:
        part.unlink(missing_ok=True)
        raise GtdbDownloadError(f"could not download {url}: {exc}") from exc
    if expected_md5 and file_md5(part) != expected_md5:
        part.unlink(missing_ok=True)
        raise GtdbDownloadError(f"{dest.name} failed its MD5 check; the download was incomplete. Run again.")
    shutil.move(part, dest)
    return dest


def fetch_release_metadata(
    release: str,
    cache_dir: Path,
    base_url: str = DEFAULT_BASE_URL,
    progress_factory: Callable[[str], Callable[[int, int | None], None]] | None = _default_progress,
) -> list[Path]:
    """Download (or reuse) both metadata files of `release`; return their paths."""
    try:
        with urllib.request.urlopen(release_url(release, "MD5SUM.txt", base_url), timeout=60) as r:  # noqa: S310
            sums = parse_md5sum(r.read().decode("utf-8", errors="replace"))
    except OSError as exc:
        raise GtdbDownloadError(
            f"could not reach GTDB release {release} at {base_url} ({exc}). Check the release number "
            "and your connection."
        ) from exc

    paths = []
    for template in METADATA_FILES:
        name = template.format(release=release)
        if name not in sums:
            raise GtdbDownloadError(f"release {release} lists no {name}; is this a GTDB release number?")
        progress = progress_factory(name) if progress_factory else None
        paths.append(download(release_url(release, name, base_url), cache_dir / name, sums[name], progress))
    return paths
