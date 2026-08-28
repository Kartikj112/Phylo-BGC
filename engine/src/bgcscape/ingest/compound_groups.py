"""Group clusters that make the same curated compound.

## Why this exists, and what it is not

A Gene Cluster Family in the BiG-SCAPE / BiG-SLiCE sense is a *sequence*
clustering: BGCs grouped because their gene content and domain architecture
are similar. Producing one needs the cluster sequences and a real clustering
run -- `bgcscape ingest bigscape` is the path for that, and nothing here
replaces it.

This module groups on a different, weaker, but genuinely curated signal:
**two clusters that MIBiG records as producing the same named compound.**
That is an experimental observation, not an inference. If a cluster in
*Streptomyces* and a cluster in *Amycolatopsis* both make vancomycin, they
are related pathways in phylogenetically distant organisms -- which is
exactly the distribution question this tool exists to answer, and it is
answerable from MIBiG alone, with no sequence analysis at all.

The distinction is kept visible rather than blurred:

  - `clustering_method` is `"MIBiG shared compound"`, never a BiG-SCAPE
    version string, and the UI shows it.
  - `clustering_cutoff` is None, because there is no similarity threshold
    here -- membership is exact compound-name identity.
  - `evidence_level` is COMPUTED: MIBiG curated the compound links, but the
    grouping is BGC-scape's derivation from them.
  - Groups are labelled `CMPD_<name>`, so a reader can never mistake one
    for BiG-SCAPE's `FAM_00001`.

Both kinds of grouping can coexist in the same database: a BGC may belong
to a compound group and to a BiG-SCAPE family at once, which is why
`BGCSummary.family_ids` was a list from the start.

## Deliberate limits

Only compounds carried by **more than one** cluster form a group -- a
singleton says nothing about distribution. Names are matched
case-insensitively after trimming, and nothing smarter: no synonym
resolution, no structure comparison. Two clusters making the same molecule
under different names will not be grouped, and this undercounts rather than
overclaims, which is the right direction for a curated-data feature.
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from bgcscape.models import (
    BGC,
    BGCCompoundLink,
    BGCFamily,
    BGCFamilyMembership,
    Compound,
    EvidenceLevel,
    FamilyKind,
    Source,
)

CLUSTERING_METHOD = "MIBiG shared compound"

#: Product *categories* rather than molecules. MIBiG uses these as compound
#: names on clusters that make an unresolved mixture, so grouping on them
#: says "both make some carotenoid", not "both make the same compound".
#: They are still grouped -- a carotenoid pathway spanning 17 organisms is a
#: real distribution -- but flagged so the UI can say what the group means.
GENERIC_PRODUCT_NAMES = {
    "capsular polysaccharide",
    "exopolysaccharide",
    "lipopolysaccharide",
    "o-antigen",
    "carotenoid",
    "siderophore",
    "polysaccharide",
    "glycopeptidolipid",
    "lipooligosaccharide",
    "melanin",
}


@dataclass
class CompoundGroupReport:
    groups_created: int = 0
    groups_updated: int = 0
    memberships: int = 0
    clusters_grouped: int = 0
    singletons_skipped: int = 0
    generic_groups: int = 0
    generic_clusters: int = 0
    examples: list[str] = field(default_factory=list)

    def __str__(self) -> str:  # pragma: no cover - human-facing summary
        return (
            f"groups={self.groups_created + self.groups_updated} "
            f"memberships={self.memberships} clusters={self.clusters_grouped}"
        )


def normalize_compound_name(name: str) -> str:
    """Fold whitespace and case so "Vancomycin " and "vancomycin" agree.

    Deliberately conservative: no synonym table, no stripping of stereo
    prefixes. Anything cleverer would start inventing equivalences the
    curation does not assert.
    """
    return re.sub(r"\s+", " ", name or "").strip().lower()


def group_by_compound(
    session: Session,
    source: Source,
    *,
    min_members: int = 2,
) -> CompoundGroupReport:
    """Create one family per compound shared by `min_members`+ clusters.

    Idempotent: groups are keyed on `(source_id, label)`, so re-running
    after ingesting more MIBiG entries updates the existing groups rather
    than duplicating them.
    """
    report = CompoundGroupReport()

    rows = (
        session.query(Compound.name, BGCCompoundLink.bgc_id)
        .join(BGCCompoundLink, BGCCompoundLink.compound_id == Compound.id)
        .all()
    )

    by_name: dict[str, set] = defaultdict(set)
    display_name: dict[str, str] = {}
    for name, bgc_id in rows:
        key = normalize_compound_name(name)
        if not key:
            continue
        by_name[key].add(bgc_id)
        display_name.setdefault(key, (name or "").strip())

    existing = {
        family.label: family
        for family in session.query(BGCFamily).filter(BGCFamily.source_id == source.id).all()
    }
    grouped_clusters: set = set()

    for key, bgc_ids in sorted(by_name.items()):
        if len(bgc_ids) < min_members:
            report.singletons_skipped += 1
            continue

        label = _label_for(key)
        family = existing.get(label)
        if family is None:
            family = BGCFamily(
                label=label,
                # The typed distinction from a BiG-SCAPE sequence family.
                # Consumers branch on this, not on the free-text method.
                kind=FamilyKind.COMPOUND_GROUP,
                clustering_method=CLUSTERING_METHOD,
                clustering_cutoff=None,
                source_id=source.id,
                # COMPUTED, not OBSERVED_CURATED: MIBiG curated each
                # compound link, but the grouping is derived here.
                evidence_level=EvidenceLevel.COMPUTED,
            )
            session.add(family)
            session.flush()
            existing[label] = family
            report.groups_created += 1
        else:
            # A group written before `kind` existed (or by an older build)
            # must be corrected on re-run, or the scorer's exclusion of
            # compound groups silently stops applying to it.
            if family.kind != FamilyKind.COMPOUND_GROUP:
                family.kind = FamilyKind.COMPOUND_GROUP
            report.groups_updated += 1

        known = {
            membership.bgc_id
            for membership in session.query(BGCFamilyMembership).filter_by(family_id=family.id).all()
        }
        for bgc_id in bgc_ids:
            grouped_clusters.add(bgc_id)
            if bgc_id in known:
                continue
            session.add(
                BGCFamilyMembership(
                    bgc_id=bgc_id,
                    family_id=family.id,
                    # No similarity score: membership is exact name identity,
                    # not a distance. Leaving it null is honest; a fabricated
                    # 1.0 would read as a measured similarity.
                    similarity_score=None,
                )
            )
            report.memberships += 1

        if is_generic_product(label):
            report.generic_groups += 1
            report.generic_clusters += len(bgc_ids)
        if len(report.examples) < 10:
            flag = " [product category]" if is_generic_product(label) else ""
            report.examples.append(f"{label} ({len(bgc_ids)} clusters){flag}")

    report.clusters_grouped = len(grouped_clusters)
    session.commit()
    return report


def _label_for(normalized_name: str) -> str:
    """`CMPD_vancomycin` — prefixed so it can never be read as a BiG-SCAPE
    `FAM_00001`, and truncated to the column width."""
    slug = re.sub(r"[^a-z0-9]+", "-", normalized_name).strip("-")
    return f"CMPD_{slug}"[:128]


#: The generic names as they appear *after* labelling. Comparing labels to
#: labels avoids un-slugifying, which was lossy: `_label_for` maps both
#: "o-antigen" and "o antigen" to `CMPD_o-antigen`, so the old
#: hyphens-back-to-spaces inverse produced "o antigen" and silently failed
#: to recognise the one hyphenated name in the vocabulary.
GENERIC_PRODUCT_LABELS = frozenset(
    _label_for(normalize_compound_name(name)) for name in GENERIC_PRODUCT_NAMES
)


def is_generic_product(label: str) -> bool:
    """Whether a group's compound is a product category rather than a single
    molecule — see GENERIC_PRODUCT_NAMES.

    Grouping on "carotenoid" says "both make some carotenoid", not "both
    make the same molecule". Such a group is still a real distribution, but
    it means something weaker, and the UI says so.
    """
    return label in GENERIC_PRODUCT_LABELS
