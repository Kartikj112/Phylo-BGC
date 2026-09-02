"""Synthetic demo corpus, for evaluating the visualization at realistic scale.

## Why this exists

The shipped test fixtures hold 5 genomes — enough to verify ingestion and
cross-source merging, far too few to judge whether the tree design works.
The genomic-barcode tick treatment, clade density, label crowding, and
family distribution patterns only become assessable at dozens of genomes.
This generates a corpus of that size so design decisions can be made
against something representative.

## This data is fabricated, and says so everywhere

That is a real hazard in a scientific tool, so it's constrained hard:

- Every taxon name is **transparently fictional** (`Pseudostreptomyces
  demoensis`) — plausible in shape and typography, so italic binomials and
  label widths look right, but impossible to mistake for a real organism
  or to accidentally cite.
- Accessions use a `SYN_` prefix, never the `GCF_`/`GCA_` form of real
  NCBI assemblies.
- The `Source` row is named **"SYNTHETIC DEMO DATA (not real)"**, so it
  appears that way in the provenance endpoint, in every exported figure's
  caption, and in `bgcscape inspect-figure` output. A figure made from
  this corpus advertises its own fakeness.
- `evidence_level` is `HYPOTHESIZED` throughout — the level the model
  reserves for things Phylo-BGC itself asserted rather than observed,
  computed, or predicted by a real tool. Nothing here was.

## Deterministic

Seeded, so the same `--seed` yields a byte-identical corpus. A design
judgement made against a corpus that shifts under you is worthless, and
"it looked fine yesterday" needs to be checkable.

The distributions are hand-tuned to *look* like real biosynthetic data
(most genomes with a handful of BGCs, a few prolific ones, a long tail of
singleton families, a couple of families spanning distant clades) — but
they are invented shapes, not fitted to any real dataset, and no
conclusion drawn from this corpus means anything.
"""
from __future__ import annotations

import random

from sqlalchemy.orm import Session

from bgcscape.coverage import get_or_create_analysis_run, record_coverage
from bgcscape.models import (
    BGC,
    AssemblyLevel,
    BGCClass,
    AnalysisType,
    BGCFamily,
    BGCFamilyMembership,
    Compound,
    BGCCompoundLink,
    EvidenceLevel,
    Genome,
    Source,
    SourceType,
    Taxon,
    TaxonRank,
)

SYNTHETIC_SOURCE_NAME = "SYNTHETIC DEMO DATA (not real)"

# Deliberately fictional. Real-looking enough for typography and label
# widths, impossible to confuse with a real organism.
_GENERA = [
    ("Pseudostreptomyces", "Demonocardiaceae", "Demonocardiales"),
    ("Fictomyces", "Demonocardiaceae", "Demonocardiales"),
    ("Mockobacter", "Mockobacteraceae", "Demonocardiales"),
    ("Exemplomonas", "Exemplomonadaceae", "Exemplomonadales"),
    ("Simulobacillus", "Simulobacillaceae", "Simulobacillales"),
    ("Notarealia", "Notarealiaceae", "Simulobacillales"),
    ("Placeholderia", "Placeholderiaceae", "Placeholderiales"),
]

_PHYLA = {
    "Demonocardiales": ("Demonocardia", "Fictomycota"),
    "Exemplomonadales": ("Exemplomonadia", "Pseudomonadota-demo"),
    "Simulobacillales": ("Simulobacilli", "Bacillota-demo"),
    "Placeholderiales": ("Placeholderia-class", "Fictomycota"),
}

_EPITHETS = [
    "demoensis", "fictus", "exemplaris", "syntheticus", "notarealis", "mockii",
    "placeholderi", "simulatus", "imaginarius", "testudinis", "artificialis",
    "hypotheticus", "provisorius", "nominalis", "speculativus", "conjecturalis",
]

# Rough shape only — most genomes carry a few clusters, a minority are
# prolific. Invented, not fitted to real data.
_CLASS_WEIGHTS = [
    (BGCClass.NRPS, 22), (BGCClass.PKS, 18), (BGCClass.RIPP, 16),
    (BGCClass.TERPENE, 14), (BGCClass.SIDEROPHORE, 9), (BGCClass.SACCHARIDE, 7),
    (BGCClass.ALKALOID, 4), (BGCClass.HYBRID, 6), (BGCClass.OTHER, 4),
]

_HYBRID_PAIRS = ["nrps+pks", "nrps+ripp", "pks+terpene", "nrps+siderophore"]


def _weighted_class(rng: random.Random) -> tuple[BGCClass, str | None]:
    population = [c for c, _ in _CLASS_WEIGHTS]
    weights = [w for _, w in _CLASS_WEIGHTS]
    chosen = rng.choices(population, weights=weights, k=1)[0]
    if chosen is BGCClass.HYBRID:
        return chosen, rng.choice(_HYBRID_PAIRS)
    subtype = None
    if chosen is BGCClass.PKS:
        subtype = rng.choice([None, "type I", "type II", "type III"])
    elif chosen is BGCClass.RIPP:
        subtype = rng.choice([None, "lanthipeptide", "lasso peptide", "thiopeptide"])
    return chosen, subtype


def generate_demo_corpus(
    session: Session,
    *,
    genome_count: int = 80,
    seed: int = 20260825,
) -> dict[str, int]:
    """Populate `session` with a synthetic corpus. Returns row counts.

    Does not commit until the end, so a failure leaves nothing behind.
    """
    rng = random.Random(seed)

    source = Source(
        name=SYNTHETIC_SOURCE_NAME,
        source_type=SourceType.USER_UPLOAD,
        version=f"seed-{seed}",
        url=None,
        license="Not applicable — fabricated data for interface evaluation only",
        citation="DO NOT CITE. Generated by `bgcscape seed-demo`; no biological meaning.",
    )
    session.add(source)
    session.flush()

    def taxon(name: str, rank: TaxonRank, parent: Taxon | None) -> Taxon:
        row = Taxon(
            name=name,
            rank=rank,
            parent_id=parent.id if parent else None,
            source_id=source.id,
            evidence_level=EvidenceLevel.HYPOTHESIZED,
        )
        session.add(row)
        session.flush()
        return row

    domain = taxon("Bacteria (synthetic)", TaxonRank.DOMAIN, None)

    phyla: dict[str, Taxon] = {}
    classes: dict[str, Taxon] = {}
    orders: dict[str, Taxon] = {}
    families: dict[str, Taxon] = {}
    genera: dict[str, Taxon] = {}

    for genus_name, family_name, order_name in _GENERA:
        class_name, phylum_name = _PHYLA[order_name]
        if phylum_name not in phyla:
            phyla[phylum_name] = taxon(phylum_name, TaxonRank.PHYLUM, domain)
        if class_name not in classes:
            classes[class_name] = taxon(class_name, TaxonRank.CLASS, phyla[phylum_name])
        if order_name not in orders:
            orders[order_name] = taxon(order_name, TaxonRank.ORDER, classes[class_name])
        if family_name not in families:
            families[family_name] = taxon(family_name, TaxonRank.FAMILY, orders[order_name])
        if genus_name not in genera:
            genera[genus_name] = taxon(genus_name, TaxonRank.GENUS, families[family_name])

    # Uneven genus sizes, like real data — one dominant genus, several
    # sparse ones. An evenly-populated tree would flatter the layout.
    genus_names = list(genera)
    genus_weights = [40, 18, 12, 10, 8, 7, 5][: len(genus_names)]

    species_cache: dict[tuple[str, str], Taxon] = {}
    genomes: list[Genome] = []
    all_bgcs: list[BGC] = []

    detection_run = get_or_create_analysis_run(
        session,
        source=source,
        analysis_type=AnalysisType.BGC_DETECTION,
        tool="synthetic generator (not a real prediction)",
        tool_version="0",
        evidence_level=EvidenceLevel.HYPOTHESIZED,
    )
    clustering_run = get_or_create_analysis_run(
        session,
        source=source,
        analysis_type=AnalysisType.SEQUENCE_CLUSTERING,
        tool="synthetic generator (not a real BiG-SCAPE run)",
        tool_version="0",
        evidence_level=EvidenceLevel.HYPOTHESIZED,
    )

    for index in range(genome_count):
        genus_name = rng.choices(genus_names, weights=genus_weights, k=1)[0]
        epithet = rng.choice(_EPITHETS)
        species_key = (genus_name, epithet)
        if species_key not in species_cache:
            species_cache[species_key] = taxon(
                f"{genus_name} {epithet}", TaxonRank.SPECIES, genera[genus_name]
            )
        species = species_cache[species_key]

        is_mag = rng.random() < 0.22
        genome = Genome(
            accession=f"SYN_{index:05d}.1",
            taxon_id=species.id,
            assembly_level=AssemblyLevel.MAG if is_mag else AssemblyLevel.COMPLETE_GENOME,
            is_mag=is_mag,
            genome_size_bp=rng.randint(3_500_000, 11_000_000),
            gc_content_pct=round(rng.uniform(38.0, 74.0), 1),
            completeness_pct=round(rng.uniform(72.0, 99.9), 2) if is_mag else round(rng.uniform(97.0, 100.0), 2),
            contamination_pct=round(rng.uniform(0.0, 6.5), 2) if is_mag else round(rng.uniform(0.0, 1.2), 2),
            source_id=source.id,
            evidence_level=EvidenceLevel.HYPOTHESIZED,
        )
        session.add(genome)
        session.flush()
        genomes.append(genome)
        # Fabricated coverage for a fabricated corpus, and labelled as such.
        # Without it, every genome here reads as "never examined" and the
        # scorer correctly declines to say anything — which would be a true
        # statement about a corpus that is pretending to be the output of a
        # detection run over these genomes. The pretence is the point of the
        # demo; leaving the coverage out would make it pretend less
        # coherently, not more honestly. Everything about it is
        # HYPOTHESIZED and the source names itself as not real.
        record_coverage(session, detection_run, genome, bgcs_recorded=0)

        # Most genomes modest, a few prolific — the shape that makes the
        # barcode row worth looking at.
        roll = rng.random()
        if roll < 0.15:
            n_bgcs = rng.randint(0, 1)
        elif roll < 0.75:
            n_bgcs = rng.randint(2, 6)
        elif roll < 0.95:
            n_bgcs = rng.randint(7, 13)
        else:
            n_bgcs = rng.randint(14, 22)

        for region in range(n_bgcs):
            bgc_class, subtype = _weighted_class(rng)
            start = rng.randint(1_000, 6_000_000)
            bgc = BGC(
                genome_id=genome.id,
                contig=f"SYNCONTIG_{rng.randint(1, 40):03d}",
                start_coord=start,
                end_coord=start + rng.randint(8_000, 90_000),
                bgc_class=bgc_class,
                subtype=subtype,
                predicted_by_tool="synthetic generator (not a real prediction)",
                external_ref=f"SYN_{index:05d}.region{region + 1:03d}",
                source_id=source.id,
                evidence_level=EvidenceLevel.HYPOTHESIZED,
            )
            session.add(bgc)
            all_bgcs.append(bgc)
    session.flush()

    # --- families -----------------------------------------------------------
    # A realistic mix: a few large families, many small ones, a long tail
    # of singletons, plus a couple deliberately spanning distant genera so
    # the "scattered distribution" highlight has something to show.
    rng.shuffle(all_bgcs)
    family_rows: list[BGCFamily] = []
    cursor = 0
    family_index = 1

    def new_family(label_index: int) -> BGCFamily:
        fam = BGCFamily(
            label=f"FAM_{label_index:05d}",
            clustering_method="synthetic generator (not a real BiG-SCAPE run)",
            clustering_cutoff=0.3,
            source_id=source.id,
            evidence_level=EvidenceLevel.HYPOTHESIZED,
        )
        session.add(fam)
        session.flush()
        family_rows.append(fam)
        return fam

    # Roughly 70% of BGCs land in families; the rest stay unclustered,
    # which is both realistic and exercises the prioritization scorer's
    # "unclustered" component.
    clusterable = all_bgcs[: int(len(all_bgcs) * 0.7)]
    while cursor < len(clusterable):
        roll = rng.random()
        if roll < 0.45:
            size = 1
        elif roll < 0.80:
            size = rng.randint(2, 4)
        elif roll < 0.95:
            size = rng.randint(5, 9)
        else:
            size = rng.randint(10, 18)
        members = clusterable[cursor : cursor + size]
        cursor += size
        if not members:
            break
        fam = new_family(family_index)
        family_index += 1
        for member in members:
            session.add(BGCFamilyMembership(bgc_id=member.id, family_id=fam.id, similarity_score=None))
    session.flush()

    # Every genome was in the pretend clustering run — including the ones
    # whose clusters matched nothing. That is what makes the ~30% left out
    # of families genuinely UNCLUSTERED ("compared, nothing similar found")
    # rather than merely uncompared, and it is the distinction that lets
    # this corpus keep exercising the scorer's `unclustered` component and
    # the by-construction bias it exposed. See ARCHITECTURE.md, "It
    # immediately exposed a real methodological flaw".
    for genome in genomes:
        record_coverage(session, clustering_run, genome, bgcs_recorded=0)
    session.flush()

    # --- a handful of "characterized" reference clusters ---------------------
    # Gives the MIBiG-distance scoring component something to work with,
    # and the detail panel some compounds to show. Named so they can't be
    # confused with real MIBiG accessions.
    reference_targets = rng.sample(all_bgcs, k=min(12, len(all_bgcs)))
    for ref_index, bgc in enumerate(reference_targets, start=1):
        bgc.mibig_accession = f"SYN-BGC{ref_index:07d}"
        compound = Compound(
            name=f"Synthomycin {chr(64 + ref_index)}",
            chemical_formula=f"C{rng.randint(12, 44)}H{rng.randint(18, 70)}N{rng.randint(1, 8)}O{rng.randint(2, 14)}",
            compound_class=rng.choice(["polyketide", "nonribosomal peptide", "terpenoid", "siderophore"]),
            mibig_compound_ref=f"SYN-BGC{ref_index:07d}.compound-1",
            source_id=source.id,
            evidence_level=EvidenceLevel.HYPOTHESIZED,
        )
        session.add(compound)
        session.flush()
        session.add(
            BGCCompoundLink(
                bgc_id=bgc.id,
                compound_id=compound.id,
                reference="Fabricated for interface evaluation; no literature basis.",
                source_id=source.id,
                evidence_level=EvidenceLevel.HYPOTHESIZED,
            )
        )

    session.commit()

    return {
        "genomes": len(genomes),
        "bgcs": len(all_bgcs),
        "taxa": session.query(Taxon).filter_by(source_id=source.id).count(),
        "families": len(family_rows),
        "compounds": len(reference_targets),
    }
