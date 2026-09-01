import { expect, test, type Page } from "@playwright/test";
import { dismissWelcome } from "./support";

/**
 * Searching by what a cluster MAKES.
 *
 * A product name is how a researcher refers to a cluster, but the tree
 * payload carried only taxa and genome accessions, so "kocurin" matched
 * nothing at all. Compound names now travel with each BGC, the matching
 * cluster is marked, and the view frames the result.
 */

const HIT_FILL = "#FFE94A";

async function ready(page: Page) {
  await page.goto("/");
  await page.waitForSelector("svg [data-figure-root='true']", { timeout: 60_000 });
  await dismissWelcome(page);
  await page.waitForTimeout(1200);
}

const search = (page: Page) => page.getByPlaceholder("Search taxa, accessions, compounds");
const hitMarks = (page: Page) => page.locator(`rect[fill="${HIT_FILL}"]`);

test("a compound name finds and marks its cluster", async ({ page }) => {
  await ready(page);
  await search(page).fill("kocurin");
  await page.waitForTimeout(1800);

  // The cluster itself is marked, not merely its genome's row.
  expect(await hitMarks(page).count()).toBeGreaterThan(0);

  // And the lineage down to it was forced open, or the hit would be
  // highlighted inside a collapsed clade that never renders.
  await expect(page.getByText("Micrococcaceae", { exact: false }).first()).toBeVisible();
});

test("searching a compound zooms the view to the result", async ({ page }) => {
  await ready(page);
  const layer = page.locator("svg [data-figure-root='true']").locator("xpath=..");
  const before = await layer.getAttribute("transform");

  await search(page).fill("kocurin");
  await page.waitForTimeout(1800);

  const after = await layer.getAttribute("transform");
  expect(after, "the canvas should re-frame onto the match").not.toEqual(before);
  expect(after).toMatch(/scale\(/);
});

test("a MIBiG accession still matches, and a miss marks nothing", async ({ page }) => {
  await ready(page);

  await search(page).fill("BGC0001640");
  await page.waitForTimeout(1500);
  expect(await hitMarks(page).count()).toBeGreaterThan(0);

  await search(page).fill("zzzznotacompound");
  await page.waitForTimeout(1500);
  expect(await hitMarks(page).count()).toBe(0);
  await expect(page.getByText("no matches")).toBeVisible();
});

test("clearing the search removes every hit mark", async ({ page }) => {
  await ready(page);
  await search(page).fill("kocurin");
  await page.waitForTimeout(1500);
  expect(await hitMarks(page).count()).toBeGreaterThan(0);

  await search(page).fill("");
  await page.waitForTimeout(1200);
  expect(await hitMarks(page).count()).toBe(0);
});
