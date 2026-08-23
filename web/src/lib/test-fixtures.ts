import type { BGCSummary, GenomeSummary, TaxonTreeNode } from "./api-types";

let counter = 0;
const nid = (prefix: string): string => `${prefix}-${counter++}`;

function bgc(bgc_class: string, subtype: string | null): BGCSummary {
  return {
    id: nid("bgc"),
    bgc_class: bgc_class as BGCSummary["bgc_class"],
    subtype,
    mibig_accession: null,
    evidence_level: "predicted",
  };
}

function genome(accession: string, is_mag: boolean, bgcs: BGCSummary[]): GenomeSummary {
  return { id: nid("genome"), accession, assembly_level: "complete_genome", is_mag, bgcs };
}

function taxon(
  name: string,
  rank: TaxonTreeNode["rank"],
  children: TaxonTreeNode[],
  direct_genomes: GenomeSummary[] = [],
): TaxonTreeNode {
  const allBgcs = [
    ...direct_genomes.flatMap((g) => g.bgcs),
    ...children.flatMap((c) => Object.values(c.bgc_class_counts)),
  ];
  const bgc_class_counts: Record<string, number> = {};
  for (const g of direct_genomes) {
    for (const b of g.bgcs) {
      const classes = b.bgc_class === "hybrid" && b.subtype ? b.subtype.split("+") : [b.bgc_class];
      for (const c of classes) bgc_class_counts[c] = (bgc_class_counts[c] ?? 0) + 1;
    }
  }
  for (const child of children) {
    for (const [cls, count] of Object.entries(child.bgc_class_counts)) {
      bgc_class_counts[cls] = (bgc_class_counts[cls] ?? 0) + count;
    }
  }
  void allBgcs;
  return {
    id: nid("taxon"),
    name,
    rank,
    genome_count: direct_genomes.length + children.reduce((sum, c) => sum + c.genome_count, 0),
    bgc_class_counts,
    direct_genomes,
    children,
  };
}

/**
 * A small tree exercising: multi-level nesting, a genus with multiple
 * species, a hybrid BGC whose only NRPS-related activity is *inside* the
 * hybrid (the specific case that caught a real bug in the prototype — see
 * tree-logic.ts's bgcComponentClasses docstring), a MAG genome, and a
 * genus with only one species (no branching) for layout variety.
 */
export function buildFixtureTree(): TaxonTreeNode {
  const avermitilisGenome = genome("GCF_TEST_AVERMITILIS.1", false, [
    bgc("pks", "type I"),
    bgc("terpene", null),
    bgc("hybrid", "nrps+pks"),
  ]);
  const coelicolorGenome = genome("GCF_TEST_COELICOLOR.1", false, [bgc("nrps", null), bgc("pks", "type II")]);
  const venezuelaeGenome = genome("GCA_TEST_VENEZUELAE.1", true, [bgc("ripp", "lanthipeptide")]);

  const streptomyces = taxon("Streptomyces", "genus", [
    taxon("Streptomyces coelicolor", "species", [], [coelicolorGenome]),
    taxon("Streptomyces avermitilis", "species", [], [avermitilisGenome]),
    taxon("Streptomyces venezuelae", "species", [], [venezuelaeGenome]),
  ]);

  const kitasatosporaGenome = genome("GCF_TEST_SETAE.1", false, [bgc("saccharide", null)]);
  const kitasatospora = taxon("Kitasatospora", "genus", [
    taxon("Kitasatospora setae", "species", [], [kitasatosporaGenome]),
  ]);

  const family = taxon("Streptomycetaceae", "family", [streptomyces, kitasatospora]);
  const order = taxon("Streptomycetales", "order", [family]);
  const klass = taxon("Actinomycetes", "class", [order]);
  const phylum = taxon("Actinomycetota", "phylum", [klass]);
  const domain = taxon("Bacteria", "domain", [phylum]);

  return {
    id: null,
    name: "root",
    rank: null,
    genome_count: domain.genome_count,
    bgc_class_counts: domain.bgc_class_counts,
    direct_genomes: [],
    children: [domain],
  };
}

export function findTaxonByName(root: TaxonTreeNode, name: string): TaxonTreeNode | null {
  if (root.name === name) return root;
  for (const child of root.children) {
    const found = findTaxonByName(child, name);
    if (found) return found;
  }
  return null;
}
