"""Regression tests for defects found by end-to-end stress testing.

Each test here corresponds to a bug that shipped, and each one failed
before its fix. They are grouped in one file deliberately: the common
thread is that every one of them was invisible to the existing suite
because the suite exercised the *function* while the bug lived on the path
a user (or the deploy pipeline) actually takes to it.
"""
from __future__ import annotations

import subprocess
import sys
import uuid

import pytest
from sqlalchemy import text

from bgcscape.api.flows import build_taxonomy_class_flow
from bgcscape.ingest.compound_groups import (
    GENERIC_PRODUCT_NAMES,
    _label_for,
    group_by_compound,
    is_generic_product,
    normalize_compound_name,
)
from bgcscape.models import (
    BGC,
    AssemblyLevel,
    BGCClass,
    BGCCompoundLink,
    BGCFamily,
    Compound,
    EvidenceLevel,
    FamilyKind,
    Genome,
    Source,
    SourceType,
    Taxon,
    TaxonRank,
)


# --- M2: the generic-product flag was dead code, and also wrong -------------


def test_every_generic_product_name_survives_the_label_round_trip():
    """`is_generic_product` must recognise every name in its own vocabulary.

    It did not: `_label_for` slugifies "o-antigen" to `CMPD_o-antigen`, and
    the old inverse turned hyphens back into spaces, producing "o antigen",
    which is not in the set. So the one hyphenated name in the vocabulary
    was silently unrecognised — and `CMPD_o-antigen` is an 11-member group
    in the real corpus. Wiring the function up without fixing this would
    have looked like a fix while still missing it.
    """
    unrecognised = [
        name
        for name in GENERIC_PRODUCT_NAMES
        if not is_generic_product(_label_for(normalize_compound_name(name)))
    ]
    assert unrecognised == []


def test_is_generic_product_does_not_flag_a_real_molecule():
    assert not is_generic_product("CMPD_vancomycin")
    assert not is_generic_product("CMPD_ectoine")


def test_generic_groups_are_flagged_in_the_grouping_report(session):
    """The flag must actually be called during grouping — it never was."""
    source = Source(name="MIBiG", source_type=SourceType.REFERENCE_DATABASE, version="4.0")
    session.add(source)
    session.flush()
    genome = Genome(
        accession="GCF_GEN_1",
        assembly_level=AssemblyLevel.COMPLETE_GENOME,
        is_mag=False,
        source_id=source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(genome)
    session.flush()

    for i, compound_name in enumerate(["carotenoid", "carotenoid", "vancomycin", "vancomycin"]):
        bgc = BGC(
            genome_id=genome.id,
            bgc_class=BGCClass.PKS,
            source_id=source.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
        session.add(bgc)
        session.flush()
        compound = Compound(
            name=compound_name,
            source_id=source.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
            mibig_compound_ref=f"ref-{i}",
        )
        session.add(compound)
        session.flush()
        session.add(
            BGCCompoundLink(
                bgc_id=bgc.id,
                compound_id=compound.id,
                source_id=source.id,
                evidence_level=EvidenceLevel.OBSERVED_CURATED,
            )
        )
    session.flush()

    group_source = Source(
        name="MIBiG shared compound", source_type=SourceType.TOOL_RUN, version=None
    )
    session.add(group_source)
    session.flush()

    report = group_by_compound(session, group_source)
    assert report.groups_created == 2
    assert report.generic_groups == 1, "the carotenoid group is a product category"
    assert report.generic_clusters == 2


# --- B1 / M1: compound groups are typed, and typed as a derived tool run ----


def test_compound_groups_are_written_with_the_compound_group_kind(session):
    source = Source(name="MIBiG", source_type=SourceType.REFERENCE_DATABASE, version="4.0")
    session.add(source)
    session.flush()
    genome = Genome(
        accession="GCF_KIND_1",
        assembly_level=AssemblyLevel.COMPLETE_GENOME,
        is_mag=False,
        source_id=source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(genome)
    session.flush()
    for i in range(2):
        bgc = BGC(
            genome_id=genome.id,
            bgc_class=BGCClass.PKS,
            source_id=source.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
        session.add(bgc)
        session.flush()
        compound = Compound(
            name="vancomycin",
            source_id=source.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
            mibig_compound_ref=f"kindref-{i}",
        )
        session.add(compound)
        session.flush()
        session.add(
            BGCCompoundLink(
                bgc_id=bgc.id,
                compound_id=compound.id,
                source_id=source.id,
                evidence_level=EvidenceLevel.OBSERVED_CURATED,
            )
        )
    session.flush()

    group_source = Source(
        name="MIBiG shared compound", source_type=SourceType.TOOL_RUN, version=None
    )
    session.add(group_source)
    session.flush()
    group_by_compound(session, group_source)

    groups = session.query(BGCFamily).all()
    assert groups
    assert all(g.kind == FamilyKind.COMPOUND_GROUP for g in groups)


def test_source_metadata_types_compound_groups_as_a_tool_run():
    """The grouping is DERIVED by Phylo-BGC, so its Source is a TOOL_RUN.

    Typing it `reference_database` claimed MIBiG had published the
    grouping, and that claim travelled into every exported figure's
    provenance block — the archival record attached to a paper.
    """
    from bgcscape.cli.main import SOURCE_METADATA

    assert "MIBiG shared compound" in SOURCE_METADATA
    src = __import__("bgcscape.cli.main", fromlist=["main"])
    # The CLI constructs it with TOOL_RUN; assert the literal in the source
    # so a future edit back to REFERENCE_DATABASE fails here.
    import inspect

    body = inspect.getsource(src.group_by_compound_cmd)
    assert "SourceType.TOOL_RUN" in body
    assert "SourceType.REFERENCE_DATABASE" not in body


# --- M6: provenance carries licence and citation ----------------------------


def test_known_sources_carry_licence_and_citation():
    """GTDB is CC BY-SA 4.0 — a ShareAlike licence obliging attribution on
    any derived view, including an exported figure. Every shipped build had
    these null, so the publication artifact attributed nothing."""
    from bgcscape.cli.main import SOURCE_METADATA

    for name in ("GTDB", "MIBiG"):
        assert SOURCE_METADATA[name]["license"]
        assert SOURCE_METADATA[name]["citation"]
        assert SOURCE_METADATA[name]["url"]
    assert "CC BY-SA 4.0" in SOURCE_METADATA["GTDB"]["license"]


# --- M5: the Sankey's hybrid double-count must reconcile the flows ----------


def _flow_corpus(session) -> None:
    source = Source(name="antiSMASH", source_type=SourceType.TOOL_RUN, version="7.1.0")
    session.add(source)
    session.flush()
    phylum = Taxon(
        name="Actinomycetota",
        rank=TaxonRank.PHYLUM,
        source_id=source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(phylum)
    session.flush()
    genus = Taxon(
        name="Streptomyces",
        rank=TaxonRank.GENUS,
        parent_id=phylum.id,
        source_id=source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(genus)
    session.flush()
    genome = Genome(
        accession="GCF_FLOW_1",
        taxon_id=genus.id,
        assembly_level=AssemblyLevel.COMPLETE_GENOME,
        is_mag=False,
        source_id=source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
    )
    session.add(genome)
    session.flush()
    # One simple cluster, one two-way hybrid, one THREE-way hybrid. The
    # three-way is the case that was miscounted.
    for bgc_class, subtype in [
        (BGCClass.NRPS, None),
        (BGCClass.HYBRID, "nrps+pks"),
        (BGCClass.HYBRID, "nrps+pks+saccharide"),
    ]:
        session.add(
            BGC(
                genome_id=genome.id,
                bgc_class=bgc_class,
                subtype=subtype,
                source_id=source.id,
                evidence_level=EvidenceLevel.PREDICTED,
            )
        )
    session.flush()


def test_hybrid_double_count_reconciles_the_sankey_flows(session):
    """`hybrid_double_counted` must be the EXCESS link units, not the
    number of hybrid clusters.

    Counting clusters under-reported by one per three-way hybrid, leaving a
    reader who tried to reconcile the two flow stages with an unexplained
    gap — exactly the arithmetic this field exists to close.
    """
    _flow_corpus(session)
    flow = build_taxonomy_class_flow(session)

    by_id = {n["id"]: n for n in flow["nodes"]}
    phylum_genus = sum(
        link["value"] for link in flow["links"] if by_id[link["source"]]["stage"] == "phylum"
    )
    genus_class = sum(
        link["value"] for link in flow["links"] if by_id[link["source"]]["stage"] == "genus"
    )

    # 3 clusters in, 1 + 2 + 3 = 6 class links out -> excess of 3.
    assert phylum_genus == 3
    assert genus_class == 6
    assert flow["hybrid_double_counted"] == genus_class - phylum_genus == 3


# --- B2: autogenerate must never emit a CHECK-constraint drop ---------------


def test_autogenerate_excludes_check_constraints():
    """Alembic reports every named CHECK constraint as "removed" and emits a
    drop for it while recreating none — even with no model changes at all.
    Applying one such migration took the schema from 12 CHECK constraints to
    1 and made an invalid `source_type` insertable by raw SQL.

    `include_object` in migrations/env.py is what makes that structurally
    impossible rather than a rule someone has to remember.
    """
    from sqlalchemy import CheckConstraint

    sys.path.insert(0, "migrations")
    import importlib.util

    spec = importlib.util.spec_from_file_location("_alembic_env_probe", "migrations/env.py")
    # env.py runs migrations on import, so read the function out of source
    # instead of importing it.
    source = open("migrations/env.py", encoding="utf-8").read()
    namespace: dict = {"CheckConstraint": CheckConstraint}
    start = source.index("def include_object(")
    end = source.index("\ndef get_url(")
    exec(source[start:end], namespace)  # noqa: S102 - reading our own repo file
    include_object = namespace["include_object"]

    assert include_object(None, "ck_source_source_type_valid", "check_constraint", True, None) is False
    assert include_object(CheckConstraint("1=1"), "anything", "unique_constraint", True, None) is False
    # Everything else still diffs normally, or real schema changes would be
    # silently dropped from autogenerate too.
    assert include_object(None, "bgc_family", "table", True, None) is True
    assert include_object(None, "kind", "column", True, None) is True


def test_enum_check_constraints_are_enforced_by_the_database(session):
    """The protection those constraints provide, asserted directly.

    Bypasses the ORM entirely — the whole point of a CHECK constraint is
    that it holds against anything that writes to the database.
    """
    if session.bind.dialect.name != "sqlite":  # pragma: no cover - dialect-dependent
        pytest.skip("raw-SQL insert shape is dialect-specific; SQLite is the portable check")
    with pytest.raises(Exception):
        session.execute(
            text(
                "INSERT INTO source (id, name, source_type, created_at, updated_at) "
                "VALUES (:i, 'BOGUS', 'totally_invalid', :t, :t)"
            ),
            {"i": uuid.uuid4().hex, "t": "2026-01-01 00:00:00"},
        )
        session.flush()
