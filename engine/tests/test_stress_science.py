"""Property-based stress tests over Phylo-BGC's scientific core.

The existing suite asserts behaviour on cases taken from the real files.
This asserts INVARIANTS over generated input — the things that must hold for
every accession, every taxonomy string and every export row, not just the
ones someone thought to write down. The join is where this project's whole
correctness argument lives, so it gets the most of it.
"""
from __future__ import annotations

import re
import string

import pytest
from hypothesis import HealthCheck, assume, given, settings
from hypothesis import strategies as st

from bgcscape.ingest.accession import (
    AccessionNamespace,
    AccessionParseError,
    GenomeMatch,
    build_genome_accession_index,
    normalize_accession,
    resolve_genome,
    strip_gtdb_prefix,
)
from bgcscape.ingest.bigfam import BigfamParseError, parse_bigfam_member_row
from bgcscape.ingest.gtdb import (
    GtdbParseError,
    parse_gtdb_metadata_row,
    parse_gtdb_taxonomy_string,
)
from bgcscape.models import TaxonRank

STRESS = settings(
    max_examples=800,
    deadline=None,
    suppress_health_check=[HealthCheck.filter_too_much],
)

# --------------------------------------------------------------- strategies

digits = st.text(alphabet="0123456789", min_size=1, max_size=12)
versions = st.integers(min_value=1, max_value=99)
prefixes = st.sampled_from(["", "RS_", "GB_"])
asm_kind = st.sampled_from(["GCF", "GCA"])


@st.composite
def assembly_accessions(draw):
    return (
        f"{draw(prefixes)}{draw(asm_kind)}_{draw(digits)}"
        f"{'.' + str(draw(versions)) if draw(st.booleans()) else ''}"
    )


@st.composite
def nucleotide_accessions(draw):
    letters = draw(st.text(alphabet=string.ascii_uppercase, min_size=2, max_size=2))
    body = draw(st.text(alphabet="0123456789", min_size=5, max_size=9))
    under = draw(st.booleans())
    return f"{letters}{'_' if under else ''}{body}"


# any text at all — the "must never crash" surface
arbitrary = st.text(min_size=0, max_size=40)


# =========================================================== normalization


class TestNormalizeIsTotal:
    @given(raw=arbitrary)
    @STRESS
    def test_it_either_normalizes_or_raises_the_one_declared_error(self, raw):
        """A new source naming genomes some other way must surface as
        unmatched rows in an ingest report, never as a crash mid-load."""
        try:
            parsed = normalize_accession(raw)
        except AccessionParseError:
            assert not raw.strip()
            return
        assert parsed.original == raw.strip()
        assert isinstance(parsed.value, str)

    @given(raw=arbitrary)
    @STRESS
    def test_normalization_is_idempotent(self, raw):
        """Re-normalizing a canonical form must not change it. If it did,
        whether a join matched would depend on how many times the value had
        been passed through the function."""
        assume(raw.strip())
        once = normalize_accession(raw)
        assume(once.value)
        twice = normalize_accession(once.value)
        assert twice.value == once.value
        assert twice.join_key == once.join_key

    @given(acc=assembly_accessions())
    @STRESS
    def test_the_canonical_value_keeps_no_version(self, acc):
        parsed = normalize_accession(acc)
        assert not re.search(r"\.\d+$", parsed.value)

    @given(acc=assembly_accessions())
    @STRESS
    def test_the_canonical_value_keeps_no_gtdb_prefix(self, acc):
        parsed = normalize_accession(acc)
        assert not parsed.value.startswith(("RS_", "GB_"))


class TestNamespacesNeverCross:
    """The false positive that would attach a GCF member to the wrong
    genome, which is worse than not placing it at all."""

    @given(acc=assembly_accessions())
    @STRESS
    def test_assemblies_fold_to_an_assembly_key(self, acc):
        parsed = normalize_accession(acc)
        assert parsed.namespace is AccessionNamespace.ASSEMBLY
        assert parsed.join_key.startswith("ASM:")

    @given(acc=nucleotide_accessions())
    @STRESS
    def test_records_never_produce_an_assembly_key(self, acc):
        parsed = normalize_accession(acc)
        assert not parsed.join_key.startswith("ASM:")

    @given(d=digits, v1=versions, v2=versions, p1=prefixes, p2=prefixes)
    @STRESS
    def test_refseq_and_genbank_of_one_assembly_share_a_key(self, d, v1, v2, p1, p2):
        """NCBI's pairing rule, which the fold rests on: the digits are the
        assembly's identity and the GCF/GCA spelling is not."""
        refseq = normalize_accession(f"{p1}GCF_{d}.{v1}")
        genbank = normalize_accession(f"{p2}GCA_{d}.{v2}")
        assert refseq.join_key == genbank.join_key == f"ASM:{d}"

    @given(d1=digits, d2=digits)
    @STRESS
    def test_different_assemblies_never_share_a_key(self, d1, d2):
        assume(d1 != d2)
        assert normalize_accession(f"GCF_{d1}").join_key != normalize_accession(f"GCF_{d2}").join_key


class TestRegionSuffixes:
    @given(acc=nucleotide_accessions(), v=versions, region=st.integers(1, 999))
    @STRESS
    def test_a_region_never_defeats_the_join_to_its_genome(self, acc, v, region):
        """antiSMASH's per-region convention, inherited by BiG-SCAPE and
        BiG-FAM. The region number is not part of the genome's identity."""
        bare = normalize_accession(f"{acc}.{v}")
        with_region = normalize_accession(f"{acc}.{v}.region{region:03d}")
        assert with_region.value == bare.value
        assert with_region.region == region
        assert bare.region is None

    @given(acc=nucleotide_accessions(), region=st.integers(1, 999))
    @STRESS
    def test_a_region_is_never_read_as_a_version(self, acc, region):
        """`.region012` ends in digits after a dot. If the version parser
        claims it, every region identifier normalizes to the wrong thing
        while still looking entirely plausible."""
        parsed = normalize_accession(f"{acc}.region{region:03d}")
        assert parsed.region == region
        assert parsed.version is None


class TestPrefixStripping:
    @given(body=st.text(alphabet=string.ascii_uppercase + string.digits + "_", min_size=1, max_size=20))
    @STRESS
    def test_a_prefix_is_only_stripped_at_the_start(self, body):
        assume(not body.startswith(("RS_", "GB_")))
        assert strip_gtdb_prefix(body) == body

    @given(body=st.text(alphabet=string.ascii_uppercase + string.digits, min_size=1, max_size=20))
    @STRESS
    def test_only_one_prefix_is_stripped(self, body):
        """`RS_GB_X` is not two prefixes; stripping greedily would mangle an
        accession that legitimately begins with those letters."""
        assert strip_gtdb_prefix(f"RS_GB_{body}") == f"GB_{body}"


# ================================================================ resolution


class TestResolveGenome:
    @given(accs=st.lists(assembly_accessions(), min_size=1, max_size=12, unique=True))
    @STRESS
    def test_every_indexed_accession_resolves_to_itself(self, accs):
        """The floor: a genome must always be findable by the exact string
        it was stored under, whatever else is in the index."""
        rows = [(f"g{i}", a) for i, a in enumerate(accs)]
        index = build_genome_accession_index(rows)
        for gid, acc in rows:
            found, how = resolve_genome(index, acc)
            assert how is GenomeMatch.EXACT
            assert found == gid

    @given(acc=assembly_accessions(), rec=nucleotide_accessions())
    @STRESS
    def test_a_record_never_resolves_to_an_assembly(self, acc, rec):
        """A nucleotide record and an assembly are different objects. No
        string rewriting relates them, so the resolver must miss rather
        than guess."""
        index = build_genome_accession_index([("asm", acc)])
        found, how = resolve_genome(index, rec)
        assert found is None
        assert how is GenomeMatch.UNMATCHED

    @given(d=digits, stored_v=versions, query_v=versions, p=prefixes)
    @STRESS
    def test_a_gtdb_tip_label_reaches_its_stored_genome(self, d, stored_v, query_v, p):
        """The join the tree feature depends on: a tip label off bac120.tree
        reaching the genome row ingested from the metadata, across both a
        prefix and a version disagreement."""
        index = build_genome_accession_index([("g", f"GCF_{d}.{stored_v}")])
        found, how = resolve_genome(index, f"{p}GCF_{d}.{query_v}")
        assert found == "g"
        assert how in (GenomeMatch.EXACT, GenomeMatch.VERSION_INSENSITIVE)

    @given(accs=st.lists(assembly_accessions(), min_size=2, max_size=8, unique=True))
    @STRESS
    def test_ambiguity_is_reported_never_guessed(self, accs):
        """Two genomes sharing a normalized key must yield nothing and a
        reason. Picking one would fabricate a placement."""
        index = build_genome_accession_index([(f"g{i}", a) for i, a in enumerate(accs)])
        for acc in accs:
            found, how = resolve_genome(index, acc)
            if how is GenomeMatch.AMBIGUOUS:
                assert found is None
            else:
                assert found is not None


# ============================================================ GTDB taxonomy

RANK_PREFIX = {
    TaxonRank.DOMAIN: "d__",
    TaxonRank.PHYLUM: "p__",
    TaxonRank.CLASS: "c__",
    TaxonRank.ORDER: "o__",
    TaxonRank.FAMILY: "f__",
    TaxonRank.GENUS: "g__",
    TaxonRank.SPECIES: "s__",
}
taxon_names = st.text(
    alphabet=string.ascii_letters + string.digits + " -.", min_size=1, max_size=24
).filter(lambda s: s.strip())


class TestGtdbTaxonomy:
    @given(names=st.lists(taxon_names, min_size=7, max_size=7))
    @STRESS
    def test_a_full_lineage_round_trips(self, names):
        ranks = list(RANK_PREFIX)
        s = ";".join(f"{RANK_PREFIX[r]}{n.strip()}" for r, n in zip(ranks, names))
        chain = parse_gtdb_taxonomy_string(s)
        assert [r for r, _ in chain] == ranks
        assert [n for _, n in chain] == [n.strip() for n in names]

    @given(names=st.lists(taxon_names, min_size=1, max_size=7))
    @STRESS
    def test_it_never_emits_an_empty_name(self, names):
        ranks = list(RANK_PREFIX)[: len(names)]
        s = ";".join(f"{RANK_PREFIX[r]}{n.strip()}" for r, n in zip(ranks, names))
        for _, name in parse_gtdb_taxonomy_string(s):
            assert name and name == name.strip()

    @given(raw=arbitrary)
    @STRESS
    def test_arbitrary_text_never_crashes_the_parser(self, raw):
        for rank, name in parse_gtdb_taxonomy_string(raw):
            assert isinstance(rank, TaxonRank)
            assert name.strip()

    @given(names=st.lists(taxon_names, min_size=6, max_size=6))
    @STRESS
    def test_an_unclassified_species_drops_the_rank_rather_than_inventing_one(self, names):
        ranks = list(RANK_PREFIX)[:6]
        s = ";".join(f"{RANK_PREFIX[r]}{n.strip()}" for r, n in zip(ranks, names)) + ";s__"
        chain = parse_gtdb_taxonomy_string(s)
        assert TaxonRank.SPECIES not in [r for r, _ in chain]


class TestGtdbMetadataRow:
    @given(acc=assembly_accessions(), rep=assembly_accessions(), names=st.lists(taxon_names, min_size=7, max_size=7))
    @STRESS
    def test_the_tree_tip_is_kept_verbatim(self, acc, rep, names):
        """`gtdb_genome_representative` is a tip label in bac120.tree, and
        those files spell their tips `RS_GCF_...`. Rewriting it here would
        mean rewriting it back at every use."""
        tax = ";".join(f"{RANK_PREFIX[r]}{n.strip()}" for r, n in zip(RANK_PREFIX, names))
        parsed = parse_gtdb_metadata_row(
            {"accession": acc, "gtdb_taxonomy": tax, "gtdb_genome_representative": rep}
        )
        assert parsed.tip_accession == rep
        # while the genome's own accession IS prefix-stripped
        assert not parsed.accession.startswith(("RS_", "GB_"))

    @given(acc=assembly_accessions())
    @STRESS
    def test_a_row_without_taxonomy_is_a_declared_error(self, acc):
        with pytest.raises(GtdbParseError):
            parse_gtdb_metadata_row({"accession": acc})


# ================================================================= BiG-FAM


class TestBigfamMemberRow:
    @given(asm=assembly_accessions(), rec=nucleotide_accessions(), region=st.integers(1, 999), radius=st.floats(0, 2000, allow_nan=False))
    @STRESS
    def test_a_genome_member_splits_into_exactly_two_identifiers(self, asm, rec, region, radius):
        name = f"{asm}/{rec}.region{region:03d}"
        m = parse_bigfam_member_row({"BGC_NAME": name, "RADIUS": str(radius)})
        assert m.genome_accession == asm
        assert m.region_ref == f"{rec}.region{region:03d}"
        assert m.mibig_accession is None
        # and the halves must still normalize to what they name
        assert normalize_accession(m.genome_accession).join_key.startswith("ASM:")
        assert normalize_accession(m.region_ref).region == region

    @given(n=st.integers(0, 9999999), v=st.integers(1, 9), radius=st.floats(0, 2000, allow_nan=False))
    @STRESS
    def test_a_mibig_member_never_claims_an_assembly(self, n, v, radius):
        m = parse_bigfam_member_row({"BGC_NAME": f"BGC{n:07d}.{v}", "RADIUS": str(radius)})
        assert m.mibig_accession == f"BGC{n:07d}"
        assert m.genome_accession is None and m.region_ref is None

    @given(name=arbitrary, radius=arbitrary)
    @STRESS
    def test_an_unusable_row_is_a_declared_error_never_a_crash(self, name, radius):
        try:
            m = parse_bigfam_member_row({"BGC_NAME": name, "RADIUS": radius})
        except BigfamParseError:
            return
        # If it parsed, exactly one identity must be established.
        genome_side = m.genome_accession is not None and m.region_ref is not None
        mibig_side = m.mibig_accession is not None
        assert genome_side != mibig_side

    @given(radius=st.floats(0, 2000, allow_nan=False), cut=st.floats(1, 2000, allow_nan=False))
    @STRESS
    def test_core_membership_is_a_distance_not_a_similarity(self, radius, cut):
        """Lower radius is CLOSER. Reading it the other way round inverts
        the entire membership of every family."""
        m = parse_bigfam_member_row({"BGC_NAME": "BGC0001522.1", "RADIUS": str(radius)})
        assert m.is_core(cut) == (radius <= cut)
