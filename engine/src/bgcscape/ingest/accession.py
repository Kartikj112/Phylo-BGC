"""Accession normalization: the one place cross-source joins are made.

Every source BGC-scape reads names genomes differently, and joining them
naively is the single easiest way to produce a silently wrong answer — a
GCF whose members "aren't in the corpus" when in fact the accession was
spelled another way. This module owns that normalization. Nothing else may
strip a prefix or a version suffix inline; if a new source needs a new
rule, it goes here with the evidence for it.

Three namespaces actually occur in this project's data, verified against
the real files on disk rather than assumed:

**Assembly accessions** — `GCF_000006945.2` (RefSeq) / `GCA_000006945.1`
(GenBank). GTDB's tree tips and metadata `accession` column carry these
with an `RS_`/`GB_` provenance prefix (`RS_GCF_051534235.1`).

**Nucleotide (record) accessions** — `AB072893.1`, `AACD01000015.1`,
`NC_003888.3`. MIBiG entries are loci, not genomes, so 551 of the 1,542
genome rows in the shipped bundle are keyed this way (see ARCHITECTURE.md
→ "MIBiG loci are not genomes"). antiSMASH and BiG-SCAPE/BiG-FAM region
identifiers are built on these too, not on assembly accessions.

**Region identifiers** — `NC_003888.3.region012`. antiSMASH's own
per-region filename convention, which BiG-SCAPE and BiG-FAM inherit. The
region number is not part of the genome's identity, so it is parsed off
and kept separately rather than defeating the join.

## Two keys, deliberately, and why one is not enough

`value` is the conservative key: prefix stripped, version stripped,
uppercased. It is what the caller should try first, and it preserves the
`GCF_` vs `GCA_` distinction.

That distinction is the trap. GTDB holds 444,524 bacterial genomes under
RefSeq accessions and 434,474 under GenBank ones, and a source naming an
assembly `GCA_000006945` will not equal GTDB's `GCF_000006945` under any
amount of prefix- and version-stripping. They are the same assembly:
checked across all 878,998 rows of `bac120_metadata.tsv.gz`, the digits of
`accession` and `ncbi_genbank_assembly_accession` agree in every single
row, which is NCBI's own pairing rule (a RefSeq assembly is derived from
its GenBank source and keeps its digits).

So `join_key` folds that namespace away — `ASM:000006945` — and is the
documented fallback when `value` misses. It is a fallback and not the
primary key because folding is an inference about NCBI's pairing rule,
and a caller that matches on it should be able to say so. Every resolver
here reports which key matched, exactly as the MIBiG→GTDB placement path
already labels its methods.

Versions must be stripped for a different, concrete reason: GTDB's own
two columns disagree on them. `RS_GCF_000227705.2` is paired with
`GCA_000227705.3` in the release on disk. A version-sensitive join drops
that genome.
"""
from __future__ import annotations

import enum
import re
from dataclasses import dataclass

#: GTDB prefixes its tip labels and metadata accessions with the source
#: database. Nothing downstream wants them.
_GTDB_PREFIXES = ("RS_", "GB_")

#: `GCF_000006945` / `GCA_000006945`, version already removed.
_ASSEMBLY_RE = re.compile(r"^GC([AF])_(\d+)$")

#: INSDC and RefSeq nucleotide records: `AB072893`, `AACD01000015`,
#: `NC_003888`, `NZ_CP012345`. Deliberately broad — the point is to
#: distinguish "a record accession" from "something we don't recognise",
#: not to validate against INSDC's full grammar.
_NUCLEOTIDE_RE = re.compile(r"^[A-Z]{1,2}_?[A-Z]{0,4}\d{5,}$")

#: antiSMASH's per-region suffix, which BiG-SCAPE and BiG-FAM inherit:
#: `NC_003888.3.region012`, and the underscore spelling some exports use.
_REGION_RE = re.compile(r"[._]REGION(\d+)$")

#: Trailing `.2` — an accession version, not a region.
_VERSION_RE = re.compile(r"\.(\d+)$")


class AccessionNamespace(str, enum.Enum):
    """Which kind of thing an accession names.

    Joining across namespaces is not a normalization problem — a
    nucleotide record and an assembly are different objects, and no string
    rewriting relates them. Callers that need that bridge need real
    mapping data (GTDB metadata, or an NCBI assembly report), so the
    namespace is surfaced to make the impossibility visible rather than
    letting it read as a normalization miss.
    """

    ASSEMBLY = "assembly"
    NUCLEOTIDE = "nucleotide"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class NormalizedAccession:
    """One accession, canonicalized. `original` is retained because it is
    what a user recognises and what belongs in the UI and in error
    messages; every join uses `value` or `join_key`."""

    original: str
    value: str
    namespace: AccessionNamespace
    version: int | None
    region: int | None
    join_key: str

    @property
    def is_recognized(self) -> bool:
        return self.namespace is not AccessionNamespace.UNKNOWN


class AccessionParseError(ValueError):
    """The input could not be read as an accession at all — empty, or
    whitespace only. Unrecognised *shapes* are not an error (they get
    `AccessionNamespace.UNKNOWN`), because a new source naming genomes in
    a way this module has not seen should be reported as unmatched rows,
    not abort a bulk load."""


def normalize_accession(raw: str) -> NormalizedAccession:
    """Canonicalize one accession from any source.

    >>> normalize_accession("RS_GCF_000006945.2").value
    'GCF_000006945'
    >>> normalize_accession("GCA_000006945.1").join_key
    'ASM:000006945'
    >>> normalize_accession("NC_003888.3.region012").region
    12
    """
    if raw is None or not str(raw).strip():
        raise AccessionParseError("empty accession")

    text = str(raw).strip().upper()

    for prefix in _GTDB_PREFIXES:
        if text.startswith(prefix):
            text = text[len(prefix) :]
            break

    region: int | None = None
    region_match = _REGION_RE.search(text)
    if region_match:
        region = int(region_match.group(1))
        text = text[: region_match.start()]

    version: int | None = None
    version_match = _VERSION_RE.search(text)
    if version_match:
        version = int(version_match.group(1))
        text = text[: version_match.start()]

    assembly = _ASSEMBLY_RE.match(text)
    if assembly:
        namespace = AccessionNamespace.ASSEMBLY
        join_key = f"ASM:{assembly.group(2)}"
    elif _NUCLEOTIDE_RE.match(text):
        namespace = AccessionNamespace.NUCLEOTIDE
        join_key = f"NUC:{text}"
    else:
        namespace = AccessionNamespace.UNKNOWN
        join_key = f"RAW:{text}"

    return NormalizedAccession(
        original=str(raw).strip(),
        value=text,
        namespace=namespace,
        version=version,
        region=region,
        join_key=join_key,
    )


def strip_gtdb_prefix(raw_accession: str) -> str:
    """Strip GTDB's `RS_`/`GB_` provenance prefix and nothing else:
    `"RS_GCF_000203835.1"` -> `"GCF_000203835.1"`.

    Separate from `normalize_accession` because GTDB ingestion stores the
    *versioned* accession as `Genome.accession` — that is the identifier a
    user looks up at NCBI, and discarding the version there would lose
    real information. Normalization is for joining, not for storage.
    """
    for prefix in _GTDB_PREFIXES:
        if raw_accession.startswith(prefix):
            return raw_accession[len(prefix) :]
    return raw_accession


class GenomeMatch(str, enum.Enum):
    """How a foreign accession was matched to an ingested genome.

    Reported rather than hidden so a caller can record it, the way the
    MIBiG→GTDB placement path already labels `ncbi_taxid` vs
    `ncbi_species_name` matches. `FOLDED_NAMESPACE` in particular rests on
    NCBI's GCF/GCA pairing rule (see module docstring) and a reader is
    entitled to know a match depended on it.
    """

    EXACT = "exact"
    VERSION_INSENSITIVE = "version_insensitive"
    FOLDED_NAMESPACE = "folded_namespace"
    AMBIGUOUS = "ambiguous"
    UNMATCHED = "unmatched"


@dataclass
class GenomeAccessionIndex:
    """Lookup from any spelling of an accession to an ingested genome id.

    Built once per ingestion run rather than issuing a query per member
    row: a GCF export names thousands of BGCs, and the corpus is small
    enough to index in memory (1,542 genomes in the shipped bundle).
    """

    #: normalized, version-stripped accession -> genome ids
    by_value: dict[str, list[object]]
    #: namespace-folded join key -> genome ids
    by_join_key: dict[str, list[object]]
    #: exactly-as-stored accession -> genome id
    by_original: dict[str, object]

    def __len__(self) -> int:
        return len(self.by_original)


def build_genome_accession_index(rows: list[tuple[object, str]]) -> GenomeAccessionIndex:
    """Index `(genome_id, accession)` pairs for resolution.

    Takes plain tuples rather than a `Session` so it stays usable from a
    notebook, a test, or a script over a TSV — the engine's separation of
    concerns applies to its own internals too.
    """
    by_value: dict[str, list[object]] = {}
    by_join_key: dict[str, list[object]] = {}
    by_original: dict[str, object] = {}

    for genome_id, accession in rows:
        if not accession:
            continue
        by_original[accession] = genome_id
        try:
            normalized = normalize_accession(accession)
        except AccessionParseError:
            continue
        by_value.setdefault(normalized.value, []).append(genome_id)
        by_join_key.setdefault(normalized.join_key, []).append(genome_id)

    return GenomeAccessionIndex(by_value=by_value, by_join_key=by_join_key, by_original=by_original)


def resolve_genome(
    index: GenomeAccessionIndex, raw_accession: str
) -> tuple[object | None, GenomeMatch]:
    """Find the ingested genome a foreign accession refers to.

    Tries the three keys in decreasing confidence and stops at the first
    hit, returning `(genome_id, how)`. A key matching more than one genome
    yields `(None, AMBIGUOUS)` — picking one would fabricate a placement,
    and the caller should count it as unresolved and say so.
    """
    if raw_accession in index.by_original:
        return index.by_original[raw_accession], GenomeMatch.EXACT

    try:
        normalized = normalize_accession(raw_accession)
    except AccessionParseError:
        return None, GenomeMatch.UNMATCHED

    for key, how in (
        (index.by_value.get(normalized.value), GenomeMatch.VERSION_INSENSITIVE),
        (index.by_join_key.get(normalized.join_key), GenomeMatch.FOLDED_NAMESPACE),
    ):
        if not key:
            continue
        unique = list(dict.fromkeys(key))
        if len(unique) > 1:
            return None, GenomeMatch.AMBIGUOUS
        return unique[0], how

    return None, GenomeMatch.UNMATCHED
