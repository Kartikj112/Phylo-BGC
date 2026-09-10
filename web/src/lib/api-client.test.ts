import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBgcTypeCounts, fetchProvenance, invalidateApiCache } from "./api-client";

/**
 * The GET layer's two jobs: never ask the same question twice at once, and
 * never answer a later question with an earlier answer once the corpus has
 * changed. Both were measured problems against the deployed API rather than
 * hypothetical ones — see the module docstring.
 */

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://test.invalid";
  invalidateApiCache();
  fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  invalidateApiCache();
});

describe("GET de-duplication", () => {
  it("joins concurrent callers onto one request", async () => {
    // The live shape: two independent components mount together and both
    // want /provenance?scope=all. One request, two callers.
    const [a, b] = await Promise.all([fetchProvenance("all"), fetchProvenance("all")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("keeps different scopes apart", async () => {
    // The bug this would cause is the one the stats bar was fixed for: the
    // eukaryote tab showing the prokaryote corpus's numbers.
    await Promise.all([fetchProvenance("prokaryote"), fetchProvenance("eukaryote")]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not make one failure permanent", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(fetchProvenance("all")).rejects.toThrow("network down");
    // A rejected promise left in the in-flight map would poison every later
    // caller with an error from a request that is long over.
    await expect(fetchProvenance("all")).resolves.toEqual({ ok: true });
  });

  it("does not cache a failed request as an answer", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response);
    await expect(fetchBgcTypeCounts("all")).rejects.toThrow("503");
    await expect(fetchBgcTypeCounts("all")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("cache lifetime", () => {
  it("serves a repeat question without a round trip", async () => {
    await fetchProvenance("all");
    await fetchProvenance("all");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("goes back to the network once the entry is stale", async () => {
    vi.useFakeTimers();
    await fetchProvenance("all");
    vi.advanceTimersByTime(61_000);
    await fetchProvenance("all");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidation forces the next read back to the network", async () => {
    // What an upload must do. Serving the pre-upload corpus back to the page
    // that just uploaded is the stale render `handleIngested` exists to stop.
    await fetchProvenance("all");
    invalidateApiCache();
    await fetchProvenance("all");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
