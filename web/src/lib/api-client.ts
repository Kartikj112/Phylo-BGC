/**
 * Thin typed fetch wrapper over the engine's read-only API
 * (engine/src/bgcscape/api/app.py). No caching/retry layer yet —
 * deliberately minimal until there's a real usage pattern to design
 * around, per the "avoid overengineering" principle.
 */
import type {
  BGCDetail,
  BGCFamilyDetail,
  BGCFamilySummary,
  GenomeDetail,
  SearchResult,
  TaxonTreeNode,
} from "./api-types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function getBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_API_URL is not set. Copy .env.local.example to .env.local " +
        "and point it at a running `uvicorn bgcscape.api.app:app` instance.",
    );
  }
  return url;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`);
  if (!res.ok) {
    throw new ApiError(res.status, `${path} responded ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function fetchTaxonomyTree(): Promise<TaxonTreeNode> {
  return getJson<TaxonTreeNode>("/api/v1/taxonomy-tree");
}

export function fetchBgcClasses(): Promise<string[]> {
  return getJson<string[]>("/api/v1/bgc-classes");
}

export function fetchGenome(genomeId: string): Promise<GenomeDetail> {
  return getJson<GenomeDetail>(`/api/v1/genomes/${genomeId}`);
}

export function fetchBgc(bgcId: string): Promise<BGCDetail> {
  return getJson<BGCDetail>(`/api/v1/bgcs/${bgcId}`);
}

export function search(query: string): Promise<SearchResult[]> {
  return getJson<SearchResult[]>(`/api/v1/search?q=${encodeURIComponent(query)}`);
}

export function fetchFamilies(): Promise<BGCFamilySummary[]> {
  return getJson<BGCFamilySummary[]>("/api/v1/families");
}

export function fetchFamily(familyId: string): Promise<BGCFamilyDetail> {
  return getJson<BGCFamilyDetail>(`/api/v1/families/${familyId}`);
}
