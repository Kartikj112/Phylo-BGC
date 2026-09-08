import { describe, expect, it } from "vitest";
import {
  isUnresolved,
  PROJECT,
  softwareCitation,
  TODO,
  type Maybe,
} from "./project-info";

/**
 * The point of these is that an unfilled fact must stay LOUD.
 *
 * The failure mode being guarded against is a placeholder that quietly
 * stringifies — `[object Object]` in the middle of a policy page, or worse, an
 * empty string that reads as a deliberate blank. Both look like finished
 * copy at a glance, which is exactly what makes them dangerous to ship.
 */
describe("unresolved facts", () => {
  it("marks a TODO as unresolved", () => {
    expect(isUnresolved(TODO("contact email"))).toBe(true);
  });

  it("treats a filled-in string as resolved", () => {
    expect(isUnresolved("someone@example.org")).toBe(false);
  });

  it("carries the description through, so the page can say what is missing", () => {
    const t = TODO("institution or department");
    expect(isUnresolved(t) && t.__todo).toBe("institution or department");
  });

  it("does not treat an empty string as unresolved", () => {
    // An empty string is a filled-in value that happens to be blank — a
    // different bug from a TODO, and one this helper must not mask.
    expect(isUnresolved("")).toBe(false);
  });
});

describe("software citation", () => {
  it("names every author and the version", () => {
    const cite = softwareCitation("1.2.3");
    for (const author of PROJECT.authors) expect(cite).toContain(author);
    expect(cite).toContain("1.2.3");
    expect(cite).toContain(PROJECT.year);
  });

  it("never leaks a placeholder object into the citation string", () => {
    // softwareCitation reads PROJECT.doi, which ships unresolved. If that were
    // interpolated naively the citation would read "...[object Object]" and
    // would be pasted into a manuscript exactly like that.
    const cite = softwareCitation();
    expect(cite).not.toContain("[object Object]");
    expect(cite).not.toContain("undefined");
  });

  it("falls back to the repository URL until a DOI exists", () => {
    const cite = softwareCitation();
    if (isUnresolved(PROJECT.doi)) {
      expect(cite).toContain(PROJECT.repositoryUrl);
    } else {
      expect(cite).toContain(PROJECT.doi);
    }
  });
});

describe("project facts", () => {
  it("has at least one author", () => {
    expect(PROJECT.authors.length).toBeGreaterThan(0);
  });

  it("states a code licence", () => {
    expect(PROJECT.codeLicense).toBeTruthy();
  });

  it("keeps every fact either a string or an explicit TODO", () => {
    // Guards against a third state creeping in (null, undefined), which would
    // render as nothing at all rather than as a visible marker.
    const facts: Maybe[] = [PROJECT.affiliation, PROJECT.contactEmail, PROJECT.doi, PROJECT.citation];
    for (const f of facts) {
      expect(typeof f === "string" || isUnresolved(f)).toBe(true);
    }
  });
});
