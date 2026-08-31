"""Cross-source accession normalization.

The cases below are taken from the real files on disk, not invented: the
GTDB release in `data/gtdb/` (r232), and the accessions actually present
in `engine/gtdb_mibig_bundled.db`. Each one is a join that silently
returns nothing if the normalization is wrong, which is the failure mode
this module exists to prevent — a GCF whose members appear absent from the
corpus because the accession was spelled another way.
"""
from __future__ import annotations

import csv
import gzip
import os
import re
from pathlib import Path

import pytest

from bgcscape.ingest.accession import (
    AccessionNamespace,
    AccessionParseError,
    GenomeMatch,
    build_genome_accession_index,
    normalize_accession,
    resolve_genome,
    strip_gtdb_prefix,
)


class TestNormalizeAccession:
    def test_gtdb_tip_labels_lose_prefix_and_version(self):
        """GTDB's tree tips and metadata `accession` column both look like
        this. `bac120.tree` on disk holds 189,801 of them."""
        assert normalize_accession("RS_GCF_051534235.1").value == "GCF_051534235"
        assert normalize_accession("GB_GCA_947493065.1").value == "GCA_947493065"

    def test_a_prefix_only_appears_at_the_start(self):
        """`GB_` and `RS_` are stripped as prefixes, not substrings. An
        accession containing those letters mid-string must survive."""
        assert normalize_accession("CP_RS_001.1").value == "CP_RS_001"

    def test_version_is_parsed_off_but_retained(self):
        parsed = normalize_accession("GCF_000006945.2")
        assert (parsed.value, parsed.version) == ("GCF_000006945", 2)

    def test_versions_disagree_across_gtdbs_own_two_columns(self):
        """The concrete reason the join must be version-insensitive.

        In the r232 metadata on disk, `accession = RS_GCF_000227705.2` is
        paired with `ncbi_genbank_assembly_accession = GCA_000227705.3`.
        A version-sensitive join drops this genome, and it is GTDB's own
        file disagreeing with itself — not a foreign source being sloppy.
        """
        refseq = normalize_accession("RS_GCF_000227705.2")
        genbank = normalize_accession("GCA_000227705.3")
        assert refseq.value != genbank.value  # the conservative key keeps them apart
        assert refseq.join_key == genbank.join_key == "ASM:000227705"

    def test_refseq_and_genbank_fold_to_one_assembly_key(self):
        """The trap a strip-prefix-and-version normalizer walks into.

        GTDB holds 444,524 bacterial genomes under `GCF_` and 434,474
        under `GCA_`. A source naming an assembly the GenBank way will
        never string-equal GTDB's RefSeq spelling, however much is
        stripped, so the fold is a separate key rather than a stronger
        version of the first one.
        """
        assert normalize_accession("GCF_000006945").join_key == "ASM:000006945"
        assert normalize_accession("GCA_000006945").join_key == "ASM:000006945"

    def test_region_suffixes_are_parsed_off(self):
        """antiSMASH's per-region convention, which BiG-SCAPE and BiG-FAM
        inherit. The region number is not part of the genome's identity,
        so it must not defeat the join to a genome."""
        parsed = normalize_accession("NC_003888.3.region012")
        assert (parsed.value, parsed.version, parsed.region) == ("NC_003888", 3, 12)
        assert normalize_accession("NC_003888.3_region4").region == 4

    def test_a_region_suffix_is_not_read_as_a_version(self):
        """`.region012` ends in digits after a dot; the version parser must
        not claim it, or every region identifier normalizes to the wrong
        thing while still looking plausible."""
        parsed = normalize_accession("CP002271.region005")
        assert (parsed.value, parsed.version, parsed.region) == ("CP002271", None, 5)

    def test_mibig_locus_accessions_are_nucleotide_records(self):
        """551 of the 1,542 genome rows in the shipped bundle are keyed
        this way, because MIBiG entries are loci rather than genomes."""
        for raw in ("AB072893.1", "AACD01000015.1", "NC_003888.3", "NZ_CP012345.1"):
            assert normalize_accession(raw).namespace is AccessionNamespace.NUCLEOTIDE

    def test_nucleotide_records_never_fold_into_assemblies(self):
        """A record and an assembly are different objects. No amount of
        string rewriting relates them, so the namespaces must not collide
        in the folded key — a false positive here would attach a GCF
        member to the wrong genome, which is worse than not placing it.
        """
        assert normalize_accession("AACD01000015.1").join_key.startswith("NUC:")
        assert normalize_accession("GCA_000006945.1").join_key.startswith("ASM:")

    def test_case_and_whitespace_are_normalized(self):
        assert normalize_accession("  rs_gcf_000006945.2 ").value == "GCF_000006945"

    def test_an_unrecognized_shape_is_not_an_error(self):
        """A new source naming genomes some other way should surface as
        unmatched rows in an ingest report, not abort a bulk load."""
        parsed = normalize_accession("my-own-genome-42")
        assert parsed.namespace is AccessionNamespace.UNKNOWN
        assert parsed.join_key == "RAW:MY-OWN-GENOME-42"
        assert not parsed.is_recognized

    @pytest.mark.parametrize("bad", ["", "   ", None])
    def test_an_empty_accession_is_an_error(self, bad):
        with pytest.raises(AccessionParseError):
            normalize_accession(bad)

    def test_original_is_preserved_for_display(self):
        """The UI and error messages must show what the user gave, not the
        canonical form — `GCF_000006945` is not an accession anyone can
        look up at NCBI."""
        assert normalize_accession("RS_GCF_000006945.2").original == "RS_GCF_000006945.2"


class TestStripGtdbPrefix:
    def test_keeps_the_version(self):
        """GTDB ingestion stores the versioned accession, because that is
        what a user looks up. Normalization is for joining, not storage."""
        assert strip_gtdb_prefix("RS_GCF_000203835.1") == "GCF_000203835.1"
        assert strip_gtdb_prefix("GCF_000203835.1") == "GCF_000203835.1"


class TestResolveGenome:
    ACCESSIONS = [
        ("g-refseq", "GCF_000006745.1"),
        ("g-genbank", "GCA_000203835.1"),
        ("g-locus", "AACD01000015.1"),
    ]

    @pytest.fixture()
    def index(self):
        return build_genome_accession_index(self.ACCESSIONS)

    def test_exact_spelling_wins_and_is_labelled_as_such(self, index):
        assert resolve_genome(index, "GCF_000006745.1") == ("g-refseq", GenomeMatch.EXACT)

    def test_a_different_version_still_resolves(self, index):
        assert resolve_genome(index, "GCF_000006745.3") == (
            "g-refseq",
            GenomeMatch.VERSION_INSENSITIVE,
        )

    def test_a_gtdb_tip_label_resolves_to_the_stored_accession(self, index):
        """The join the feature actually needs: a tip label off
        `bac120.tree` reaching the genome row ingested from the metadata."""
        assert resolve_genome(index, "RS_GCF_000006745.1") == (
            "g-refseq",
            GenomeMatch.VERSION_INSENSITIVE,
        )

    def test_the_other_namespace_resolves_but_says_it_folded(self, index):
        """A GenBank-spelled accession reaching a RefSeq-stored genome.
        This is the match that rests on NCBI's pairing rule, so the caller
        is told it did."""
        assert resolve_genome(index, "GCA_000006745.1") == (
            "g-refseq",
            GenomeMatch.FOLDED_NAMESPACE,
        )

    def test_a_region_identifier_resolves_to_its_genome(self, index):
        assert resolve_genome(index, "AACD01000015.1.region003") == (
            "g-locus",
            GenomeMatch.VERSION_INSENSITIVE,
        )

    def test_an_absent_accession_is_unmatched_not_an_error(self, index):
        assert resolve_genome(index, "GCF_999999999.1") == (None, GenomeMatch.UNMATCHED)

    def test_the_exact_namespace_is_preferred_over_the_fold(self):
        """With both spellings of one assembly ingested as separate
        genomes, a RefSeq query must reach the RefSeq row rather than
        becoming ambiguous — the conservative key is tried first precisely
        so the fold is never consulted when it does not need to be."""
        index = build_genome_accession_index(
            [("a", "GCF_000006745.1"), ("b", "GCA_000006745.1")]
        )
        assert resolve_genome(index, "GCF_000006745.9") == (
            "a",
            GenomeMatch.VERSION_INSENSITIVE,
        )

    def test_two_versions_of_one_assembly_as_separate_rows_are_ambiguous(self):
        """Choosing either would fabricate a placement, so the caller gets
        nothing and a reason. This is the reachable duplicate case: a
        corpus that ingested two releases of the same assembly."""
        index = build_genome_accession_index(
            [("a", "GCF_000006745.1"), ("b", "GCF_000006745.2")]
        )
        assert resolve_genome(index, "GCF_000006745.9")[1] is GenomeMatch.AMBIGUOUS

    def test_the_fold_can_be_ambiguous_too(self):
        """Two GenBank versions ingested separately, queried the RefSeq
        way: the conservative key misses, and the fold is the step that
        must refuse."""
        index = build_genome_accession_index(
            [("a", "GCA_000006745.1"), ("b", "GCA_000006745.2")]
        )
        assert resolve_genome(index, "GCF_000006745.1")[1] is GenomeMatch.AMBIGUOUS

    def test_the_same_genome_indexed_twice_is_not_ambiguous(self):
        """Deduplication matters: one genome under two accession versions
        is one answer, not a conflict."""
        index = build_genome_accession_index(
            [("a", "GCF_000006745.1"), ("a", "GCF_000006745.2")]
        )
        assert resolve_genome(index, "GCF_000006745.9") == (
            "a",
            GenomeMatch.VERSION_INSENSITIVE,
        )

    def test_blank_accessions_are_skipped_when_indexing(self):
        index = build_genome_accession_index([("a", ""), ("b", "GCF_000006745.1")])
        assert len(index) == 1


class TestAgainstTheRealCorpus:
    """The normalization checked against real cross-source data rather than
    hand-written examples.

    `engine/data/gtdb_mibig_subset.tsv` is committed, so the first test
    always runs. The GTDB Newick trees are ~2.5 GB uncompressed and live
    outside the repo, so the join they verify is asserted only where they
    have actually been downloaded — skipped, never quietly passed.
    """

    SUBSET = Path(__file__).resolve().parents[1] / "data" / "gtdb_mibig_subset.tsv"

    @staticmethod
    def _tree_dir():
        """Where the reference trees were placed by hand.

        `BGCSCAPE_GTDB_DIR` names it outright; otherwise every ancestor of
        this file is checked for a `data/gtdb/`, because the trees are far
        too large to live in the repo and how far outside it they sit is
        the checkout's business, not this test's.
        """
        override = os.environ.get("BGCSCAPE_GTDB_DIR")
        candidates = [Path(override)] if override else []
        here = Path(__file__).resolve()
        candidates += [parent / "data" / "gtdb" for parent in here.parents]
        for path in candidates:
            if (path / "bac120.tree.gz").exists() or (path / "bac120.tree").exists():
                return path
        return None

    @staticmethod
    def _tip_labels(path: Path) -> set[str]:
        opener = gzip.open if path.suffix == ".gz" else open
        with opener(path, "rt", encoding="utf-8") as fh:  # type: ignore[operator]
            newick = fh.read()
        # Tips are the labels that follow an opening paren or a comma; every
        # GTDB tip carries a branch length, so the trailing colon anchors it.
        return set(re.findall(r"[(,]([A-Za-z0-9_.]+):", newick))

    def test_every_real_accession_normalizes_to_an_assembly_key(self):
        """991 real GTDB accessions in three spellings — `RS_`, `GB_`, and
        bare — must all land in the ASSEMBLY namespace. A single one falling
        through to UNKNOWN would be a genome silently unjoinable."""
        rows = list(csv.DictReader(self.SUBSET.open(encoding="utf-8"), delimiter="\t"))
        assert len(rows) > 900, "the committed GTDB subset looks truncated"

        for row in rows:
            for column in ("accession", "gtdb_genome_representative"):
                parsed = normalize_accession(row[column])
                assert parsed.namespace is AccessionNamespace.ASSEMBLY, (
                    f"{row[column]!r} (column {column}) did not read as an assembly accession"
                )
                assert parsed.join_key.startswith("ASM:")

    def test_the_prefix_is_the_only_difference_between_the_two_columns(self):
        """A representative that names itself must normalize to exactly its
        own accession — the case that makes an is-representative branch
        unnecessary everywhere downstream."""
        rows = list(csv.DictReader(self.SUBSET.open(encoding="utf-8"), delimiter="\t"))
        self_naming = [r for r in rows if r["gtdb_genome_representative"] == r["accession"]]
        assert self_naming, "expected some genomes to be their own representative"
        for row in self_naming:
            assert (
                normalize_accession(row["gtdb_genome_representative"]).value
                == normalize_accession(row["accession"]).value
                == strip_gtdb_prefix(row["accession"]).split(".")[0]
            )

    def test_every_corpus_genome_reaches_a_real_tree_tip(self):
        """The end-to-end join this feature rests on, against the actual
        r232 Newick files.

        Measured when this was written: of the 991 assembly accessions in
        the subset, 651 are species representatives and are their own tip,
        340 are not and reach a tip through `gtdb_genome_representative`,
        and 0 reach neither. The last number is the assertion that matters —
        `bac120.tree` holds 189,801 tips against the metadata's 878,998
        genomes, so a normalization that ignored the representative column
        would drop a third of the corpus without erroring.
        """
        tree_dir = self._tree_dir()
        if tree_dir is None:
            pytest.skip(
                "GTDB reference trees not downloaded — place bac120.tree(.gz) and "
                "ar53.tree(.gz) in data/gtdb/, or set BGCSCAPE_GTDB_DIR"
            )

        tips: set[str] = set()
        for stem in ("bac120", "ar53"):
            for suffix in (".tree.gz", ".tree"):
                path = tree_dir / f"{stem}{suffix}"
                if path.exists():
                    tips |= self._tip_labels(path)
                    break
        tip_keys = {normalize_accession(t).value for t in tips}
        assert len(tip_keys) > 150_000, "the trees on disk look truncated"

        rows = list(csv.DictReader(self.SUBSET.open(encoding="utf-8"), delimiter="\t"))
        own_tip, via_representative, unreachable = 0, 0, []
        for row in rows:
            if normalize_accession(row["accession"]).value in tip_keys:
                own_tip += 1
            elif normalize_accession(row["gtdb_genome_representative"]).value in tip_keys:
                via_representative += 1
            else:
                unreachable.append(row["accession"])

        assert unreachable == [], f"{len(unreachable)} genome(s) reach no tip, e.g. {unreachable[:5]}"
        assert via_representative > 0, (
            "no genome needed its representative — either the subset changed or the "
            "representative lookup is being bypassed, and this test would then be "
            "asserting nothing"
        )
        assert own_tip + via_representative == len(rows)
