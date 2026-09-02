/**
 * Convenience aliases over the generated OpenAPI types
 * (api-schema.generated.ts, regenerated via `npm run generate-api-types`
 * whenever engine/src/bgcscape/api/schemas.py changes — see that script's
 * definition in package.json). Application code should import from here,
 * not reach into `components["schemas"][...]` directly everywhere.
 */
import type { components } from "./api-schema.generated";

export type TaxonTreeNode = components["schemas"]["TaxonTreeNode"];
export type GenomeSummary = components["schemas"]["GenomeSummary"];
export type BGCSummary = components["schemas"]["BGCSummary"];
export type GenomeDetail = components["schemas"]["GenomeDetail"];
export type BGCDetail = components["schemas"]["BGCDetail"];
export type CompoundSummary = components["schemas"]["CompoundSummary"];
export type SearchResult = components["schemas"]["SearchResult"];
export type SearchResponse = components["schemas"]["SearchResponse"];
export type BGCClassVocabulary = components["schemas"]["BGCClassVocabulary"];
export type FamilyKind = components["schemas"]["FamilyKind"];
export type BGCFamilySummary = components["schemas"]["BGCFamilySummary"];
export type BGCFamilyDetail = components["schemas"]["BGCFamilyDetail"];
export type BGCFamilyMember = components["schemas"]["BGCFamilyMember"];
export type CladeComparison = components["schemas"]["CladeComparison"];
export type CladeSummary = components["schemas"]["CladeSummary"];
export type ClassProfileEntry = components["schemas"]["ClassProfileEntry"];
export type FamilyRef = components["schemas"]["FamilyRef"];
export type DatasetProvenanceResponse = components["schemas"]["DatasetProvenanceResponse"];
export type TaxonomyClassFlow = components["schemas"]["TaxonomyClassFlow"];
export type AntismashUploadResponse = components["schemas"]["AntismashUploadResponse"];
export type UploadedGenome = components["schemas"]["UploadedGenomeOut"];
export type ClusteringOutcome = components["schemas"]["ClusteringOutcomeOut"];
export type PresenceHeatmap = components["schemas"]["PresenceHeatmap"];
export type LineageStep = components["schemas"]["LineageStep"];
export type BGCTypeCount = components["schemas"]["BGCTypeCount"];
export type BGCClass = components["schemas"]["BGCClass"];
export type TaxonRank = components["schemas"]["TaxonRank"];
export type EvidenceLevel = components["schemas"]["EvidenceLevel"];
export type AssemblyLevel = components["schemas"]["AssemblyLevel"];
export type CoverageState = components["schemas"]["CoverageState"];
export type AnalysisRunSummary = components["schemas"]["AnalysisRunSummary"];
export type PlacementConfidence = components["schemas"]["PlacementConfidence"];
export type PrioritizationResponse = components["schemas"]["PrioritizationResponse"];
export type PrioritizationOut = components["schemas"]["PrioritizationOut"];
export type ComponentScoreOut = components["schemas"]["ComponentScoreOut"];

/**
 * The tree logic (tree-logic.ts) and D3 rendering need to treat taxon
 * nodes and genomes uniformly as "things with children/a position in the
 * tree." `TaxonTreeNode` and `GenomeSummary` don't share a discriminant
 * field in the API response itself (the nesting position tells you which
 * is which), so this app-level type adds one — `toDisplayNode()` in
 * tree-logic.ts is the only place that constructs these from raw API data.
 */
export type TaxonDisplayNode = TaxonTreeNode & { _kind: "taxon" };
export type GenomeDisplayNode = GenomeSummary & { _kind: "genome" };
export type DisplayNode = TaxonDisplayNode | GenomeDisplayNode;
