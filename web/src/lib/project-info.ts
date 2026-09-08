/**
 * Everything about this project that lives outside the code.
 *
 * One file, edited once. The policy pages, the citation block and the
 * availability statement all read from here, so filling this in completes all
 * of them at the same time and nothing can be updated in one place and missed
 * in another.
 *
 * A value left as `TODO(...)` renders on the page as a visible oxblood marker
 * rather than as blank space or an invented fact, so an unfilled field cannot
 * ship quietly. Replace the whole `TODO(...)` call with a plain string.
 */

/** Marks a fact this repository cannot supply. */
export function TODO(what: string): Unresolved {
  return { __todo: what };
}
export type Unresolved = { __todo: string };
export type Maybe = string | Unresolved;

export function isUnresolved(v: Maybe): v is Unresolved {
  return typeof v === "object" && v !== null && "__todo" in v;
}

export const PROJECT = {
  name: "Phylo-BGC",

  /** Short description, used in the citation and the availability statement. */
  tagline: "Interactive exploration of biosynthetic gene cluster diversity across the tree of life",

  /** The people the work is attributed to, in citation order. */
  authors: ["Kartik Juyal", "Narsinh L. Thakur"],

  /** Institutional affiliation for the corresponding author. */
  affiliation:
    "Chemical Oceanography Division, CSIR-National Institute of Oceanography (CSIR-NIO), Goa, India; " +
    "Academy of Scientific and Innovative Research (AcSIR)" as Maybe,

  /**
   * Contact for correspondence, data requests, and takedown requests.
   *
   * The institutional address, not a personal one: it is what verifies the
   * affiliation above to a reader, and it is the address a journal expects for
   * correspondence. Worth revisiting if the studentship ends before the tool
   * stops being maintained — a takedown route that bounces is worse than one
   * that is slightly less formal.
   */
  contactEmail: "kartik.nio24a@acsir.res.in" as Maybe,

  /** Where the source lives. */
  repositoryUrl: "https://github.com/Kartikj112/bgc-scape",

  /**
   * Provenance of the wordmark (`logo.png`, `logo-animation.mp4`).
   *
   * Recorded as "created by X using Y" rather than as a bare authorship claim,
   * because that is what is actually true and it is the form that survives a
   * question. Naming the generative tool matters for two separate reasons: a
   * growing number of journals require AI-assisted figures and artwork to be
   * disclosed at submission, and the tool's own terms are what govern the
   * output — worth a glance at Google's Gemini terms before the figure appears
   * in a paper, since that is where any restriction would live.
   */
  wordmark: "Created for this project by Kartik Juyal using Google Gemini." as Maybe,

  /** Software licence for this project's own code. */
  codeLicense: "MIT",

  /**
   * The archived, citable release.
   *
   * Journals increasingly require software to be deposited somewhere with a
   * persistent identifier — a GitHub URL is not one, because a repository can
   * be force-pushed, renamed or deleted. Minting a Zenodo DOI takes a few
   * minutes (enable the repo in Zenodo, then cut a GitHub release) and is what
   * lets a reader fetch the exact version a figure came from.
   */
  doi: TODO("Zenodo DOI for the archived release, e.g. 10.5281/zenodo.XXXXXXX") as Maybe,

  /** The paper or preprint to cite, once one exists. */
  citation: TODO("preprint or paper citation, once available") as Maybe,

  /** Year, for the copyright line. */
  year: "2026",
} as const;

/**
 * The fallback citation, used until a paper exists.
 *
 * Deliberately software-shaped rather than paper-shaped: citing a tool as
 * software with a version and a DOI is correct and checkable, whereas
 * inventing a journal reference for something unpublished is not.
 */
export function softwareCitation(version = "0.1.0"): string {
  const authors = PROJECT.authors.join(", ");
  const doi = isUnresolved(PROJECT.doi) ? "" : ` https://doi.org/${PROJECT.doi}`;
  return `${authors} (${PROJECT.year}). ${PROJECT.name}: ${PROJECT.tagline}. Version ${version} [Computer software].${doi || ` ${PROJECT.repositoryUrl}`}`;
}
