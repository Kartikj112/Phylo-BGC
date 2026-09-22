/**
 * Thin typed fetch wrapper over the engine's read-only API
 * (engine/src/bgcscape/api/app.py).
 *
 * GETs are de-duplicated and briefly cached. This used to say there was no
 * caching layer "until there's a real usage pattern to design around" —
 * there is one now, measured against the deployed API rather than guessed
 * at. Two pairs of identical requests went out on every cold load:
 * `/provenance?scope=all` from both LoadingQuestions and ExportButton, and
 * `/bgc-type-counts` from both CorpusStatsBar and BgcTypeDonut. Independent
 * components asking the same question is the correct shape for those
 * components; asking it twice over the wire is not, and on a free-tier
 * backend that cold-starts in minutes each duplicate is a wasted minute.
 *
 * Two mechanisms, because they solve different halves:
 *
 * - In-flight de-duplication joins callers onto one request. This cannot
 *   serve stale data: there is exactly one response and everyone gets it.
 * - A short TTL cache makes going back to a tab already visited instant
 *   rather than another round trip.
 *
 * The corpus only changes when an upload adds to it, so that is the one
 * place that must invalidate — see `invalidateApiCache`.
 */
import type {
  AntismashUploadResponse,
  BGCDetail,
  BGCFamilyDetail,
  BGCFamilySummary,
  PrioritizationResponse,
  CladeComparison,
  DatasetProvenanceResponse,
  BGCTypeCount,
  PresenceHeatmap,
  TaxonomyClassFlow,
  GenomeDetail,
  SearchResponse,
  BGCClassVocabulary,
  TaxonTreeNode,
  BackboneStatus,
  BackboneTreeNode,
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

/** How long a GET stays reusable. Short enough that a corpus changed by
 *  someone else shows up on the next navigation, long enough to cover a
 *  reader switching tabs back and forth while reading. */
const CACHE_TTL_MS = 60_000;

const inflight = new Map<string, Promise<unknown>>();
const cache = new Map<string, { at: number; value: unknown }>();

/** Drop every cached GET. Call after a write — an upload adds genomes, and
 *  serving the pre-upload corpus back to the page that just uploaded them
 *  is the stale-render failure `handleIngested` exists to avoid. */
export function invalidateApiCache(): void {
  cache.clear();
  inflight.clear();
}

async function getJson<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;

  const pending = inflight.get(path);
  if (pending) return pending as Promise<T>;

  const request = (async () => {
    const res = await fetch(`${getBaseUrl()}${path}`);
    if (!res.ok) {
      throw new ApiError(res.status, `${path} responded ${res.status}`);
    }
    const value = (await res.json()) as T;
    cache.set(path, { at: Date.now(), value });
    return value;
  })();

  inflight.set(path, request);
  try {
    return await request;
  } finally {
    // Cleared whether it resolved or threw. Leaving a rejected promise here
    // would make one failed request permanent for every later caller.
    inflight.delete(path);
  }
}

/** POST a FormData body. Never sets Content-Type by hand — the browser has
 * to add the multipart boundary itself, and a hand-written header silently
 * produces a body the server cannot parse. */
async function postForm<T>(path: string, body: FormData): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, { method: "POST", body });
  if (!res.ok) {
    // FastAPI puts the useful part in `detail`; a bare status here would
    // turn "this deployment is read-only" into "responded 403".
    let detail = `${path} responded ${res.status}`;
    try {
      const payload = (await res.json()) as { detail?: unknown };
      if (typeof payload.detail === "string") detail = payload.detail;
    } catch {
      /* not JSON — keep the status line */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

/** Which taxonomy to draw.
 *
 * The corpus holds two — GTDB for prokaryotes, NCBI for the fungi and plants
 * GTDB cannot represent — and they are served as separate views rather than
 * merged, because the two disagree and a hybrid tree could not be picked
 * apart by a reader. */
export type TreeScope = "all" | "prokaryote" | "eukaryote";

export function fetchTaxonomyTree(scope: TreeScope = "all"): Promise<TaxonTreeNode> {
  return getJson<TaxonTreeNode>(`/api/v1/taxonomy-tree?scope=${scope}`);
}

/** Whether the whole-taxonomy backbone is loaded for `scope`. It is an
 * optional load, so the interface asks before offering it. */
export function fetchBackboneStatus(scope: TreeScope): Promise<BackboneStatus> {
  return getJson<BackboneStatus>(`/api/v1/backbone/status?scope=${scope}`);
}

/** One clade of the reference backbone (the root when `parent` is omitted)
 * and `depth` levels below it, with the corpus laid over it. `parent` is a
 * node's `backbone_id`, not its `id`. */
export function fetchBackboneTree(
  scope: TreeScope,
  parent?: string | null,
  depth = 1,
): Promise<BackboneTreeNode> {
  const params = new URLSearchParams({ scope, depth: String(depth) });
  if (parent) params.set("parent", parent);
  return getJson<BackboneTreeNode>(`/api/v1/backbone/tree?${params}`);
}

/** Both BGC-class vocabularies, plus the note explaining how they differ.
 *
 * Returns an object, not a flat list: `stored_classes` includes `hybrid`
 * while `component_classes` (what every count and filter uses) decomposes
 * hybrids and never contains it. A legend built from the wrong one carries
 * a permanently empty category. */
export function fetchBgcClasses(): Promise<BGCClassVocabulary> {
  return getJson<BGCClassVocabulary>("/api/v1/bgc-classes");
}

export function fetchGenome(genomeId: string): Promise<GenomeDetail> {
  return getJson<GenomeDetail>(`/api/v1/genomes/${genomeId}`);
}

export function fetchBgc(bgcId: string): Promise<BGCDetail> {
  return getJson<BGCDetail>(`/api/v1/bgcs/${bgcId}`);
}

/** Server-side search over taxa and genome accessions.
 *
 * Returns totals and a `message`, not a bare array: the caller must be able
 * to tell "the first 20 of 380 matches" from "all 20 that exist", and "no
 * matches" from "the query was too short to run". The tree view does its
 * own client-side matching over the loaded tree instead — this is for
 * callers that don't hold the whole tree. */
/**
 * Upload antiSMASH result JSONs and place the genomes on the tree.
 *
 * The one write in this client. Sent as multipart rather than JSON because
 * an antiSMASH region file for a single bacterial genome runs to tens of
 * megabytes, and base64-in-JSON would inflate that by a third for nothing.
 *
 * `organism` is not optional in practice even though the API accepts its
 * absence: the tree is built from taxa, so a genome with no organism is
 * ingested and then not drawn. The dialog marks it required for that reason
 * and the response's `placement` reports what actually happened.
 */
export function uploadAntismashResults(
  files: File[],
  options: { organism: string; isMag?: boolean; label?: string; clustering?: File | null },
): Promise<AntismashUploadResponse> {
  const body = new FormData();
  for (const file of files) body.append("files", file);
  body.append("organism", options.organism);
  body.append("is_mag", String(options.isMag ?? false));
  if (options.label) body.append("label", options.label);
  // Optional, and the difference between "here is your genome" and "here is
  // your genome and everywhere else this same cluster occurs": antiSMASH
  // alone can only say two clusters share a biosynthetic class.
  if (options.clustering) body.append("clustering", options.clustering);
  return postForm<AntismashUploadResponse>("/api/v1/ingest/antismash", body);
}

export function search(query: string, limit?: number): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (limit != null) params.set("limit", String(limit));
  return getJson<SearchResponse>(`/api/v1/search?${params}`);
}

/** Rank clusters as candidates for follow-up.
 *
 * `caveats` is part of the contract, not garnish, and a row whose `score`
 * is null is a refusal to rank rather than a zero — the scorer declines
 * when fewer than two components can be computed. A client that renders
 * only the scored rows hides the more important half of what the engine
 * said. See engine/src/bgcscape/scoring/prioritization.py.
 */
export function fetchPrioritization(limit = 25): Promise<PrioritizationResponse> {
  return getJson<PrioritizationResponse>(`/api/v1/prioritization?limit=${limit}`);
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

/**
 * `scope` defaults to "all" — the whole database — because that is what the
 * export path wants: a figure's recorded provenance describes the dataset it
 * came from, not the tab that was open. The summary bar passes the taxonomy
 * on screen instead, and reads the `corpus_*` fields for its denominators.
 */
export function fetchProvenance(scope: TreeScope = "all"): Promise<DatasetProvenanceResponse> {
  return getJson<DatasetProvenanceResponse>(`/api/v1/provenance?scope=${scope}`);
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

export function fetchTaxonomyClassFlow(scope: TreeScope = "all"): Promise<TaxonomyClassFlow> {
  return getJson<TaxonomyClassFlow>(`/api/v1/flows/taxonomy-class?scope=${scope}`);
}

export function fetchHeatmap(rank = "genus", scope: TreeScope = "all"): Promise<PresenceHeatmap> {
  return getJson<PresenceHeatmap>(
    `/api/v1/heatmap?rank=${encodeURIComponent(rank)}&scope=${scope}`,
  );
}

export function fetchBgcTypeCounts(scope: TreeScope = "all"): Promise<BGCTypeCount[]> {
  return getJson<BGCTypeCount[]>(`/api/v1/bgc-type-counts?scope=${scope}`);
}
