"""BiG-FAM per-GCF membership ingestion.

The fixture in `fixtures/bigfam_gcf_200948_members.tsv` reproduces the real
export's shape verbatim — `#`-prefixed header, six columns, `n/a` for absent
URLs, and the `<assembly>/<record>.regionNNN` member name — checked against
the live `/api/gcf/get_member_links?gcf_id=200948` endpoint rather than
invented. Its accessions are real ones so the cross-source joins asserted
here are the joins the feature actually performs.
"""
from __future__ import annotations

import gzip
import uuid
from pathlib import Path

import pytest

from bgcscape.ingest.bigfam import (
    DEFAULT_CORE_RADIUS,
    BigfamExportError,
    BigfamParseError,
    infer_gcf_id_from_filename,
    ingest_bigfam_gcf,
    parse_bigfam_member_row,
    read_bigfam_export,
)
from bgcscape.models import (
    BGC,
    BGCClass,
    BGCFamily,
    BGCFamilyMembership,
    EvidenceLevel,
    FamilyKind,
    Genome,
    Source,
    SourceType,
)
from bgcscape.models.genome import AssemblyLevel

FIXTURE = Path(__file__).parent / "fixtures" / "bigfam_gcf_200948_members.tsv"


@pytest.fixture()
def bigfam_source(session) -> Source:
    src = Source(
        id=uuid.uuid4(),
        name="BiG-FAM",
        source_type=SourceType.TOOL_RUN,
        version="1.0",
        url="https://bigfam.bioinformatics.nl/",
    )
    session.add(src)
    session.commit()
    return src


def _genome(session, source, accession, **kwargs):
    genome = Genome(
        accession=accession,
        assembly_level=AssemblyLevel.SCAFFOLD,
        is_mag=False,
        source_id=source.id,
        evidence_level=EvidenceLevel.OBSERVED_CURATED,
        **kwargs,
    )
    session.add(genome)
    session.flush()
    return genome


class TestParseMemberRow:
    def test_a_genome_member_splits_into_assembly_and_region(self):
        """The whole join turns on this split: the left half reaches GTDB
        and therefore the tree, the right half reaches `BGC.external_ref`."""
        member = parse_bigfam_member_row(
            {"BGC_NAME": "GCF_000156695.2/NZ_ABYX02000001.region019", "RADIUS": "430"}
        )
        assert member.genome_accession == "GCF_000156695.2"
        assert member.region_ref == "NZ_ABYX02000001.region019"
        assert member.mibig_accession is None
        assert member.radius == 430.0

    def test_the_region_half_is_antismashs_own_filename_convention(self):
        """Which is the point — it means an already-ingested region attaches
        to its existing BGC row rather than gaining a duplicate. The same
        string is what ingest/antismash.py stores and ingest/bigscape.py
        joins on."""
        member = parse_bigfam_member_row(
            {"BGC_NAME": "GCF_000156695.2/NZ_ABYX02000001.region019", "RADIUS": "430"}
        )
        assert member.region_ref == "NZ_ABYX02000001.region019"

    def test_a_mibig_member_has_no_assembly(self):
        """A MIBiG entry is a deposited locus, so BiG-FAM names it bare with
        no slash. It has no assembly to sit on, and inventing one would be
        the false-positive the namespace separation exists to prevent."""
        member = parse_bigfam_member_row({"BGC_NAME": "BGC0001522.1", "RADIUS": "812"})
        assert member.mibig_accession == "BGC0001522"
        assert member.genome_accession is None and member.region_ref is None

    def test_the_core_cut_is_at_bigfams_own_threshold(self):
        """Radius is a DISTANCE — lower is closer. BiG-FAM's GCF pages split
        core from putative at 900, and reading it the other way round would
        invert the entire membership."""
        assert parse_bigfam_member_row({"BGC_NAME": "BGC0001522.1", "RADIUS": "430"}).is_core()
        assert not parse_bigfam_member_row({"BGC_NAME": "BGC0001522.1", "RADIUS": "952"}).is_core()
        assert DEFAULT_CORE_RADIUS == 900.0

    @pytest.mark.parametrize(
        "name",
        ["", "   ", "some-thing-else", "GCF_000156695.2/", "/NZ_ABYX02000001.region019"],
    )
    def test_an_unusable_name_is_a_row_error_not_a_crash(self, name):
        with pytest.raises(BigfamParseError):
            parse_bigfam_member_row({"BGC_NAME": name, "RADIUS": "430"})

    def test_a_non_numeric_radius_is_a_row_error(self):
        with pytest.raises(BigfamParseError):
            parse_bigfam_member_row({"BGC_NAME": "BGC0001522.1", "RADIUS": "close"})


class TestReadExport:
    def test_the_real_export_shape_reads(self):
        """`#`-prefixed header, six columns, tab separated."""
        columns, rows = read_bigfam_export(FIXTURE)
        assert columns == ["BGC_ID", "BGC_NAME", "RADIUS", "MIBIG_URL", "NCBI_URL", "ASDB_URL"]
        assert len(rows) == 5
        assert rows[0]["BGC_NAME"] == "GCF_000156695.2/NZ_ABYX02000001.region019"

    def test_a_gzipped_export_reads_identically(self, tmp_path):
        """The rest of the reference data in data/ ships gzipped."""
        gz = tmp_path / "gcf_200948.tsv.gz"
        gz.write_bytes(gzip.compress(FIXTURE.read_bytes()))
        assert read_bigfam_export(gz) == read_bigfam_export(FIXTURE)

    def test_a_missing_file_names_the_path_and_where_to_get_it(self, tmp_path):
        """The failure this whole error class exists for: an empty result is
        indistinguishable from a GCF whose members this corpus does not
        hold, and those are opposite conclusions."""
        with pytest.raises(BigfamExportError) as exc:
            read_bigfam_export(tmp_path / "absent.tsv")
        message = str(exc.value)
        assert "absent.tsv" in message
        assert "get_member_links" in message

    def test_an_empty_file_is_an_error(self, tmp_path):
        empty = tmp_path / "gcf_1.tsv"
        empty.write_text("")
        with pytest.raises(BigfamExportError, match="empty"):
            read_bigfam_export(empty)

    def test_a_wrong_file_reports_the_columns_it_actually_found(self, tmp_path):
        """Naming the real header is what turns 'this didn't work' into
        'you downloaded the wrong thing'."""
        wrong = tmp_path / "gcf_1.tsv"
        wrong.write_text("Record\tGBK\tFamily\nx\ty\tz\n")
        with pytest.raises(BigfamExportError) as exc:
            read_bigfam_export(wrong)
        message = str(exc.value)
        assert "BGC_NAME" in message and "RADIUS" in message
        assert "Record, GBK, Family" in message

    def test_a_header_with_no_rows_is_an_error(self, tmp_path):
        """A truncated download, not a real GCF — BiG-FAM does not publish
        empty families."""
        truncated = tmp_path / "gcf_1.tsv"
        truncated.write_text("#BGC_ID\tBGC_NAME\tRADIUS\n")
        with pytest.raises(BigfamExportError, match="no member rows"):
            read_bigfam_export(truncated)


class TestInferGcfId:
    def test_reads_the_id_out_of_a_saved_filename(self):
        assert infer_gcf_id_from_filename("gcf_200948.tsv") == "200948"
        assert infer_gcf_id_from_filename("200948.tsv.gz") == "200948"

    def test_returns_none_rather_than_inventing_one(self):
        """The export does not carry its own GCF id, so a name with no
        number must make the caller say which family this is."""
        assert infer_gcf_id_from_filename("members.tsv") is None


class TestIngest:
    """The end-to-end join, over a corpus deliberately holding only some of
    the export's members — which is the normal case for a BiG-FAM GCF."""

    @pytest.fixture()
    def corpus(self, session, gtdb_source, mibig_source):
        # Named exactly as the export spells it.
        exact = _genome(session, gtdb_source, "GCF_000156695.2")
        # Stored RefSeq, named GenBank in the export: the fold across
        # NCBI's GCF/GCA pairing rule.
        folded = _genome(session, gtdb_source, "GCF_000006745.1")
        # A MIBiG locus, with its BGC already ingested.
        locus = _genome(session, mibig_source, "AACD01000015.1")
        mibig_bgc = BGC(
            genome_id=locus.id,
            bgc_class=BGCClass.PKS,
            mibig_accession="BGC0001522",
            external_ref="BGC0001522",
            predicted_by_tool="MIBiG",
            source_id=mibig_source.id,
            evidence_level=EvidenceLevel.OBSERVED_CURATED,
        )
        session.add(mibig_bgc)
        session.commit()
        return {"exact": exact, "folded": folded, "locus": locus, "mibig_bgc": mibig_bgc}

    def test_members_land_on_the_genomes_that_will_be_highlighted(
        self, session, bigfam_source, corpus
    ):
        _, rows = read_bigfam_export(FIXTURE)
        report, coverage = ingest_bigfam_gcf(
            session, bigfam_source, rows, gcf_label="GCF_200948"
        )

        # 5 rows: 4 core, 1 putative (radius 952) excluded by default.
        assert coverage.members_total == 5
        assert coverage.members_core == 4
        assert coverage.members_putative_skipped == 1

        # Of the 4 core members, 3 reach a genome this corpus holds and one
        # sits on GCF_999999999.1, which it does not.
        assert coverage.placed == 3
        assert coverage.genome_not_in_corpus == 1
        assert coverage.placed_genome_accessions == {
            "GCF_000156695.2",
            "GCF_000006745.1",
            "AACD01000015.1",
        }
        assert report.created == 3

    def test_the_family_is_a_sequence_family_not_a_compound_group(
        self, session, bigfam_source, corpus
    ):
        """The distinction the whole `FamilyKind` column exists for. BiG-SLiCE
        compares gene content and domain architecture, so these are the real
        thing — the only kind the prioritization scorer reads."""
        _, rows = read_bigfam_export(FIXTURE)
        ingest_bigfam_gcf(session, bigfam_source, rows, gcf_label="GCF_200948")

        family = session.query(BGCFamily).filter_by(label="GCF_200948").one()
        assert family.kind is FamilyKind.SEQUENCE_FAMILY
        assert family.evidence_level is EvidenceLevel.COMPUTED
        assert family.clustering_method.startswith("BiG-SLiCE")

    def test_a_genbank_spelled_member_reaches_a_refseq_stored_genome(
        self, session, bigfam_source, corpus
    ):
        """The trap plain prefix-and-version stripping walks into: the
        export names `GCA_000006745.1`, the corpus stores
        `GCF_000006745.1`, and no amount of stripping makes those two
        strings equal. It resolves through the shared normalizer's
        namespace fold, not through anything this module does itself."""
        _, rows = read_bigfam_export(FIXTURE)
        ingest_bigfam_gcf(session, bigfam_source, rows, gcf_label="GCF_200948")

        created = (
            session.query(BGC)
            .filter_by(genome_id=corpus["folded"].id, external_ref="NZ_KZ679082.1.region020")
            .one()
        )
        assert created.genome.accession == "GCF_000006745.1"

    def test_an_existing_mibig_bgc_is_reused_not_duplicated(
        self, session, bigfam_source, corpus
    ):
        """`BGC0001522.1` in the export is the MIBiG entry already in the
        corpus. Membership must attach to that row — a second row would
        double-count the cluster everywhere it is counted."""
        _, rows = read_bigfam_export(FIXTURE)
        _, coverage = ingest_bigfam_gcf(session, bigfam_source, rows, gcf_label="GCF_200948")

        assert coverage.matched_existing_bgc == 1
        assert session.query(BGC).filter_by(mibig_accession="BGC0001522").count() == 1
        membership = (
            session.query(BGCFamilyMembership).filter_by(bgc_id=corpus["mibig_bgc"].id).one()
        )
        assert membership.similarity_score == 631.0

    def test_created_rows_say_they_came_from_bigfam_and_claim_no_class(
        self, session, bigfam_source, corpus
    ):
        """The export states no biosynthetic class, so OTHER is the honest
        value — the same fallback mibig.py and antismash.py use for a source
        that does not say — and the member name is kept so the row can be
        traced back to the line that created it."""
        _, rows = read_bigfam_export(FIXTURE)
        ingest_bigfam_gcf(session, bigfam_source, rows, gcf_label="GCF_200948")

        created = session.query(BGC).filter_by(external_ref="NZ_ABYX02000001.region019").one()
        assert created.bgc_class is BGCClass.OTHER
        assert created.evidence_level is EvidenceLevel.PREDICTED
        assert created.predicted_by_tool == "antiSMASH (via BiG-FAM)"
        # The record accession, with the region suffix parsed off by the
        # shared normalizer rather than by a second inline rule here.
        assert created.contig == "NZ_ABYX02000001"
        assert created.raw_annotation["bigfam_member_name"].endswith("region019")

    def test_a_member_on_an_absent_assembly_is_counted_never_invented(
        self, session, bigfam_source, corpus
    ):
        """Creating the genome would mean inventing the taxonomy that places
        it, putting a node on the tree no source put there."""
        _, rows = read_bigfam_export(FIXTURE)
        _, coverage = ingest_bigfam_gcf(session, bigfam_source, rows, gcf_label="GCF_200948")

        assert coverage.genome_not_in_corpus == 1
        assert session.query(Genome).filter_by(accession="GCF_999999999.1").count() == 0
        assert session.query(BGC).filter_by(external_ref="NZ_CP010833.1.region011").count() == 0

    def test_putative_members_are_excluded_unless_asked_for(
        self, session, bigfam_source, corpus
    ):
        """Radius 952 is beyond BiG-FAM's own core cut. Folding it in
        silently would overstate the family's distribution in exactly the
        way a reader cannot see."""
        _, rows = read_bigfam_export(FIXTURE)
        _, default = ingest_bigfam_gcf(session, bigfam_source, rows, gcf_label="GCF_200948")
        assert default.members_putative_skipped == 1
        assert session.query(BGC).filter_by(external_ref="NZ_KZ819154.1.region009").count() == 0

        _, rows_again = read_bigfam_export(FIXTURE)
        _, opted_in = ingest_bigfam_gcf(
            session, bigfam_source, rows_again, gcf_label="GCF_200948", include_putative=True
        )
        assert opted_in.members_putative_skipped == 0
        assert opted_in.placed == 4
        assert session.query(BGC).filter_by(external_ref="NZ_KZ819154.1.region009").count() == 1

    def test_coverage_states_the_limit_rather_than_implying_completeness(
        self, session, bigfam_source, corpus
    ):
        _, rows = read_bigfam_export(FIXTURE)
        _, coverage = ingest_bigfam_gcf(session, bigfam_source, rows, gcf_label="GCF_200948")

        assert coverage.considered == 4
        assert coverage.coverage_fraction == pytest.approx(0.75)
        described = coverage.describe()
        assert "3 of 4" in described
        assert "not shown" in described

    def test_re_ingesting_the_same_export_is_idempotent(
        self, session, bigfam_source, corpus
    ):
        """Ingestion is safe to re-run over a refreshed download — the same
        guarantee every other loader in this package gives."""
        for _ in range(2):
            _, rows = read_bigfam_export(FIXTURE)
            ingest_bigfam_gcf(session, bigfam_source, rows, gcf_label="GCF_200948")

        assert session.query(BGCFamily).filter_by(label="GCF_200948").count() == 1
        assert session.query(BGCFamilyMembership).count() == 3
        assert session.query(BGC).filter_by(external_ref="NZ_ABYX02000001.region019").count() == 1

    def test_one_bad_row_does_not_abort_the_run(self, session, bigfam_source, corpus):
        _, rows = read_bigfam_export(FIXTURE)
        rows.insert(0, {"BGC_NAME": "nonsense", "RADIUS": "1"})
        report, coverage = ingest_bigfam_gcf(
            session, bigfam_source, rows, gcf_label="GCF_200948"
        )
        assert coverage.unparsable == 1
        assert len(report.errors) == 1
        assert coverage.placed == 3

    def test_a_family_with_nothing_placed_leaves_no_empty_row(
        self, session, bigfam_source, gtdb_source
    ):
        """A BiG-FAM family is defined over 1.2M BGCs, so "none of its
        members are in this corpus" is an ordinary outcome, not an error.
        It must leave no trace: an empty family would sit in the browser
        reading "0 members" and invite a click that shows nothing."""
        rows = [
            {"BGC_NAME": "GCF_999999991.1/NZ_AAA00000001.region001", "RADIUS": "100"},
            {"BGC_NAME": "GCF_999999992.1/NZ_AAA00000002.region002", "RADIUS": "200"},
        ]
        report, coverage = ingest_bigfam_gcf(
            session, bigfam_source, rows, gcf_label="GCF_555"
        )

        assert coverage.placed == 0
        assert coverage.genome_not_in_corpus == 2
        assert report.skipped == 2
        assert session.query(BGCFamily).filter_by(label="GCF_555").count() == 0
