"""Shared helpers for ingestion loaders.

Ingestion has to be safe to re-run: pulling a newer MIBiG export or
re-classifying a genome shouldn't duplicate rows, and *should* refresh
stale fields so the database reflects the latest source data. That's a
different default than a typical web app's "create once" flow, so it gets
its own small helper rather than relying on `session.merge()` (which keys
off the primary key, not a natural/business key — not useful here since
callers never know a row's UUID in advance).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, TypeVar

from sqlalchemy.orm import Session

if TYPE_CHECKING:  # pragma: no cover - import cycle only matters to type checkers
    from bgcscape.models import BGCClass

ModelT = TypeVar("ModelT")


def hybrid_subtype(mapped: "list[BGCClass]") -> str:
    """Canonical `nrps+pks`-style subtype for a hybrid — the frontend splits
    `subtype` on `+` and expects BGCClass *values*, not a source's own
    product vocabulary (MIBiG's "NRP"/"Polyketide", antiSMASH's
    "NRPS"/"PKS").

    De-duped and **sorted**: MIBiG records the same hybrid in whichever
    order the curator listed the classes, so the real 4.0 release contains
    both `nrps+pks` (358 entries) and `pks+nrps` (36). Unsorted, those read
    as two different subtypes in the class filter, the donut and the clade
    comparison — the same cluster type counted twice under different names.

    Lives here rather than in one loader because it is a cross-source
    contract, and the one time it was not shared it broke silently:
    antiSMASH ingestion joined antiSMASH's OWN category names instead
    ("NRPS+PKS"), so an uploaded hybrid matched no entry in the frontend's
    lowercase class list and was dimmed out of the tree it had just been
    added to.
    """
    return "+".join(sorted({cls.value for cls in mapped}))


def get_or_create_or_update(
    session: Session,
    model: type[ModelT],
    lookup: dict[str, Any],
    values: dict[str, Any],
    *,
    update_existing: bool = True,
    fallback_lookups: list[dict[str, Any]] | None = None,
) -> tuple[ModelT, bool]:
    """Find a row by `lookup` (a natural/business key), and either return it
    (optionally refreshed with `values`) or create it.

    Returns `(instance, created)`. Does not commit — callers decide
    transaction boundaries. In this codebase that's one commit *per
    ingested record* (see ingest/mibig.py, ingest/gtdb.py), not one commit
    per batch: a single all-encompassing transaction would mean one bad
    record's rollback silently discards every good record processed
    earlier in the same run.

    On update, a `None` in `values` never overwrites an existing non-None
    value. This matters more than it looks: when two different sources'
    natural keys happen to collide on the same row (e.g. MIBiG and GTDB
    both describing "Streptomyces testomycini" — MIBiG keyed by
    `ncbi_taxid`, GTDB keyed by `(rank, name)`), the second source's loader
    doesn't carry every field the first one set. Without this guard, GTDB's
    `TaxonCreate` (which never sets `ncbi_taxid`) would silently null out
    the `ncbi_taxid` MIBiG had already recorded — a real data-loss bug this
    project caught in its own ingestion tests. `source_id`/`evidence_level`
    still shift to "whichever source touched the row most recently" in
    that scenario, which is a documented, deliberate simplification (see
    ARCHITECTURE.md) rather than full multi-source provenance — that would
    need per-field attribution, which is future work, not this chunk's.

    `fallback_lookups`: additional natural-key dicts tried in order if
    `lookup` matches nothing. This is what makes the MIBiG/GTDB Taxon
    collision above actually symmetric: MIBiG-first-then-GTDB merges fine
    on a plain single-key lookup (GTDB's `(rank, name)` key was always set
    by MIBiG too), but GTDB-first-then-MIBiG did NOT merge without this —
    MIBiG's primary key (`ncbi_taxid`) is never populated on a
    GTDB-created row, so a bare lookup silently created a duplicate Taxon
    instead of finding GTDB's. `ingest/mibig.py` passes
    `fallback_lookups=[{"rank": ..., "name": ...}]` to close that gap. When
    a fallback match is used, every field named in the *primary* `lookup`
    is written onto the found row (unconditionally — it's the strongest
    identifying information the caller has), or the fix wouldn't do
    anything: the row would still lack `ncbi_taxid` afterward.
    """
    instance = session.query(model).filter_by(**lookup).one_or_none()
    matched_via_fallback = False
    if instance is None:
        for fallback in fallback_lookups or []:
            instance = session.query(model).filter_by(**fallback).one_or_none()
            if instance is not None:
                matched_via_fallback = True
                break

    if instance is not None:
        if update_existing:
            for key, value in values.items():
                if value is None and getattr(instance, key, None) is not None:
                    continue
                setattr(instance, key, value)
            if matched_via_fallback:
                for key, value in lookup.items():
                    if value is not None:
                        setattr(instance, key, value)
        return instance, False

    instance = model(**lookup, **values)
    session.add(instance)
    return instance, True


@dataclass
class IngestReport:
    """Per-run outcome counters for a bulk ingestion call.

    Ingestion over real reference data is never all-or-nothing in practice
    — a handful of malformed/retired/unparseable entries among thousands of
    good ones shouldn't abort the whole run. Callers get a full accounting
    instead of a single crash on entry #4,812.
    """

    created: int = 0
    updated: int = 0
    skipped: int = 0
    errors: list[tuple[str, str]] = field(default_factory=list)  # (identifier, message)
    #: Decisions a reader needs to see that are not counts — which genome an
    #: accession resolved to and how, whether a new genome was created for
    #: it. Counts alone made "created=0, updated=3" the entire report of an
    #: ingest that had just moved three regions onto the wrong genome.
    notes: list[str] = field(default_factory=list)

    def record_error(self, identifier: str, message: str) -> None:
        self.errors.append((identifier, message))

    @property
    def total_ok(self) -> int:
        return self.created + self.updated

    def __str__(self) -> str:  # pragma: no cover - human-readable summary only
        parts = [f"created={self.created}", f"updated={self.updated}", f"skipped={self.skipped}"]
        if self.errors:
            parts.append(f"errors={len(self.errors)}")
        return ", ".join(parts)
