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
  CladeComparison,
  DatasetProvenanceResponse,
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

export function fetchComparison(taxonIds: string[]): Promise<CladeComparison> {
  const params = taxonIds.map((id) => `taxon_ids=${encodeURIComponent(id)}`).join("&");
  return getJson<CladeComparison>(`/api/v1/compare?${params}`);
}

export function fetchProvenance(): Promise<DatasetProvenanceResponse> {
  return getJson<DatasetProvenanceResponse>("/api/v1/provenance");
}

/**
 * Ask the engine to render a figure. PDF conversion happens server-side
 * rather than via the browser's print dialog: print-to-PDF output varies
 * by browser and platform and silently rasterizes some SVG features, and
 * journals reject raster figures at these sizes. See
 * engine/src/bgcscape/export/renderer.py.
 */
export async function exportFigure(
  svg: string,
  viewConfig: unknown,
  format: "svg" | "pdf",
): Promise<Blob> {
  const res = await fetch(`${getBaseUrl()}/api/v1/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ svg, view_config: viewConfig, format }),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* non-JSON error body; the status is all we have */
    }
    throw new ApiError(res.status, `Export failed: ${detail}`);
  }
  return res.blob();
}
