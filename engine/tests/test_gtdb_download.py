"""The GTDB downloader, against a local mirror of a release's layout.

Uses file:// URLs so the suite never touches the network; the real server
layout (release<N>/<N>.0/<file>) and MD5SUM.txt format are reproduced.
"""
from __future__ import annotations

import gzip
import hashlib
from pathlib import Path

import pytest
from typer.testing import CliRunner

from bgcscape.ingest.gtdb_download import (
    GtdbDownloadError,
    download,
    fetch_release_metadata,
    parse_md5sum,
    release_url,
)

HEADER = "accession\tgtdb_taxonomy\tgtdb_genome_representative\n"
BAC = HEADER + (
    "RS_GCF_000000001.1\td__Bacteria;p__Actinomycetota;c__Actinomycetes;o__Streptomycetales;"
    "f__Streptomycetaceae;g__Streptomyces;s__Streptomyces alpha\tRS_GCF_000000001.1\n"
)
AR = HEADER + (
    "RS_GCF_000000002.1\td__Archaea;p__Methanobacteriota;c__Methanobacteria;o__Methanobacteriales;"
    "f__Methanobacteriaceae;g__Methanobrevibacter;s__Methanobrevibacter beta\tRS_GCF_000000002.1\n"
)


@pytest.fixture()
def mirror(tmp_path) -> str:
    """A release-999 mirror; returns its base URL."""
    release_dir = tmp_path / "server" / "release999" / "999.0"
    release_dir.mkdir(parents=True)
    lines = []
    for name, body in (("bac120_metadata_r999.tsv.gz", BAC), ("ar53_metadata_r999.tsv.gz", AR)):
        path = release_dir / name
        path.write_bytes(gzip.compress(body.encode()))
        lines.append(f"{hashlib.md5(path.read_bytes()).hexdigest()}  ./{name}")
    (release_dir / "MD5SUM.txt").write_text("\n".join(lines) + "\n")
    return (tmp_path / "server").as_uri()


def test_release_url_matches_the_gtdb_server_layout():
    assert release_url("232", "MD5SUM.txt") == (
        "https://data.gtdb.ecogenomic.org/releases/release232/232.0/MD5SUM.txt"
    )


def test_parse_md5sum_keys_by_file_name():
    text = "0ba4237077b65cfc5556e1d8be797485  ./bac120_metadata_r232.tsv.gz\nnot a line\n"
    assert parse_md5sum(text) == {"bac120_metadata_r232.tsv.gz": "0ba4237077b65cfc5556e1d8be797485"}


def test_fetches_both_files_and_verifies_them(mirror, tmp_path):
    cache = tmp_path / "cache"
    paths = fetch_release_metadata("999", cache, base_url=mirror, progress_factory=None)
    assert [p.name for p in paths] == ["bac120_metadata_r999.tsv.gz", "ar53_metadata_r999.tsv.gz"]
    assert gzip.decompress(paths[0].read_bytes()).decode() == BAC
    assert not list(cache.glob("*.part"))


def test_a_verified_file_in_the_cache_is_not_fetched_again(mirror, tmp_path):
    cache = tmp_path / "cache"
    first = fetch_release_metadata("999", cache, base_url=mirror, progress_factory=None)
    before = first[0].stat().st_mtime_ns
    second = fetch_release_metadata("999", cache, base_url=mirror, progress_factory=None)
    assert second[0].stat().st_mtime_ns == before


def test_a_corrupt_download_is_rejected_and_not_left_behind(mirror, tmp_path):
    source = mirror + "/release999/999.0/bac120_metadata_r999.tsv.gz"
    dest = tmp_path / "cache" / "bac.tsv.gz"
    with pytest.raises(GtdbDownloadError, match="MD5"):
        download(source, dest, expected_md5="0" * 32)
    assert not dest.exists()
    assert not dest.with_name(dest.name + ".part").exists()


def test_unknown_release_or_server_says_so(mirror, tmp_path):
    with pytest.raises(GtdbDownloadError, match="could not reach GTDB release 123"):
        fetch_release_metadata("123", tmp_path / "cache", base_url=mirror, progress_factory=None)


def test_cli_downloads_and_loads_the_backbone(mirror, tmp_path, monkeypatch, engine, session):
    from sqlalchemy.orm import sessionmaker

    from bgcscape.cli.main import app
    from bgcscape.db import session as db_session
    from bgcscape.models import BackboneNode

    monkeypatch.setattr(db_session, "_engine", engine)
    monkeypatch.setattr(db_session, "_SessionLocal", sessionmaker(bind=engine, future=True))

    result = CliRunner().invoke(
        app,
        ["fetch-gtdb-backbone", "--release", "999", "--base-url", mirror, "--cache-dir", str(tmp_path / "c")],
    )
    assert result.exit_code == 0, result.output
    assert "Backbone for GTDB RS999: 14 clades, 2 genomes counted" in result.output
    roots = {n.name for n in session.query(BackboneNode).filter(BackboneNode.parent_id.is_(None))}
    assert roots == {"Bacteria", "Archaea"}


def test_cli_reports_a_download_failure_without_a_traceback(tmp_path):
    from bgcscape.cli.main import app

    missing = (tmp_path / "nowhere").as_uri()
    result = CliRunner().invoke(
        app, ["fetch-gtdb-backbone", "--release", "1", "--base-url", missing, "--cache-dir", str(tmp_path)]
    )
    assert result.exit_code == 1
    assert "could not reach GTDB release 1" in result.output
