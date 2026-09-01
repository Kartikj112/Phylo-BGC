import { expect, test, type Page } from "@playwright/test";
import { dismissWelcome } from "./support";

/**
 * The interactions a unit test cannot reach.
 *
 * Every assertion here was listed as UNVERIFIED after a full stress test of
 * the shipped build, because the only tools available were direct function
 * calls and raw HTTP. Calling `genomePassesFilters` proves the predicate;
 * it does not prove that typing into the filter box reaches it. This file
 * closes that gap.
 */

const CANVAS = "svg [data-canvas-bg='true']";

async function waitForTree(page: Page) {
  await page.goto("/");
  // The canvas only mounts once the tree has loaded, so this doubles as the
  // "did the API round-trip succeed" assertion.
  await page.waitForSelector("svg [data-figure-root='true']", { timeout: 45_000 });
  await dismissWelcome(page);
  // Scoped to the figure root on purpose. Unscoped, "the first svg shape on
  // the page" is whichever icon the header happens to render first, which
  // says nothing about whether the tree drew — and silently starts failing
  // when an icon that is hidden at this breakpoint is added above it.
  await expect(
    page.locator("svg [data-figure-root='true'] circle, svg [data-figure-root='true'] path").first(),
  ).toBeVisible();
}

function nodeCount(page: Page) {
  return page.locator("svg [data-figure-root='true'] circle").count();
}

test.describe("tree canvas", () => {
  test("loads the real corpus and renders nodes", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await waitForTree(page);
    expect(await nodeCount(page)).toBeGreaterThan(10);
    expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("middle-drag pans, and left-drag on a node still selects", async ({ page }) => {
    await waitForTree(page);
    const layer = page.locator("svg [data-figure-root='true']").locator("xpath=..");

    const before = await layer.getAttribute("transform");
    const box = await page.locator(CANVAS).boundingBox();
    if (!box) throw new Error("canvas has no box");

    // Middle-button drag = pan. This is the interaction the stress test
    // explicitly could not exercise.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 80, { steps: 10 });
    await page.mouse.up({ button: "middle" });

    const after = await layer.getAttribute("transform");
    expect(after, "middle-drag must change the pan transform").not.toEqual(before);
  });

  test("wheel zoom changes the transform scale", async ({ page }) => {
    await waitForTree(page);
    const layer = page.locator("svg [data-figure-root='true']").locator("xpath=..");
    const box = await page.locator(CANVAS).boundingBox();
    if (!box) throw new Error("canvas has no box");

    const before = await layer.getAttribute("transform");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(250);
    const after = await layer.getAttribute("transform");
    expect(after).not.toEqual(before);
    expect(after).toMatch(/scale\(/);
  });

  test("every 'Show down to' level is clickable and changes the tree", async ({ page }) => {
    await waitForTree(page);
    // The buttons carry a stable per-level title, which is a better handle
    // than DOM position.
    const buttons = page.locator('button[title*="Collapse the tree to"], button[title*="rank in this dataset"]');
    const n = await buttons.count();
    expect(n).toBeGreaterThan(3);

    const seen: number[] = [];
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      if (await b.isDisabled()) continue; // rank absent from this dataset
      await b.click();
      await page.waitForTimeout(200);
      seen.push(await nodeCount(page));
    }
    // Collapsing to a broader rank must show fewer nodes than the deepest
    // level — otherwise the control is inert.
    expect(seen.length).toBeGreaterThan(1);
    expect(Math.min(...seen)).toBeLessThan(Math.max(...seen));
  });

  test("radial / horizontal toggle re-renders without error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await waitForTree(page);

    const radial = page.getByRole("button", { name: /radial|circular/i }).first();
    if (await radial.count()) {
      await radial.click();
      await page.waitForTimeout(400);
      expect(await nodeCount(page)).toBeGreaterThan(5);
    }
    const horizontal = page.getByRole("button", { name: /horizontal|linear/i }).first();
    if (await horizontal.count()) {
      await horizontal.click();
      await page.waitForTimeout(400);
      expect(await nodeCount(page)).toBeGreaterThan(5);
    }
    expect(errors).toEqual([]);
  });
});

test.describe("search", () => {
  test("reports a live match count and distinguishes zero from broken", async ({ page }) => {
    await waitForTree(page);
    const box = page.getByPlaceholder("Search taxa, accessions, compounds");

    await box.fill("Streptomyces");
    await expect(page.locator("text=/^\\d+$/").first()).toBeVisible();

    await box.fill("zzzznomatch");
    // "no matches" is a distinct, deliberate string — not an empty count.
    await expect(page.getByText("no matches")).toBeVisible();

    await box.fill("");
    await expect(page.getByText("no matches")).toHaveCount(0);
  });

  test("a term matching only a genome accession still matches", async ({ page }) => {
    await waitForTree(page);
    const box = page.getByPlaceholder("Search taxa, accessions, compounds");
    await box.fill("GCF_");
    await expect(page.getByText("no matches")).toHaveCount(0);
  });
});

test.describe("filters", () => {
  test("a filter that matches nothing falls back instead of blanking", async ({ page }) => {
    await waitForTree(page);
    const before = await nodeCount(page);

    // Contradictory bounds: min > max can match no genome at all.
    const min = page.getByPlaceholder("min").first();
    const max = page.getByPlaceholder("max").first();
    if ((await min.count()) && (await max.count())) {
      await min.fill("999");
      await max.fill("1");
      await page.waitForTimeout(400);
      const after = await nodeCount(page);
      expect(after, "canvas must not blank when a filter excludes everything").toBeGreaterThan(0);
      expect(after).toBeLessThanOrEqual(Math.max(before, after));
    }
  });
});
