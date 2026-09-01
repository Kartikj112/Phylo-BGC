import { expect, test, type Page } from "@playwright/test";
import { dismissWelcome } from "./support";

/**
 * The eukaryote tree.
 *
 * GTDB is prokaryote-only, so roughly a fifth of MIBiG's characterized
 * clusters — Aspergillus, Penicillium, Fusarium, Arabidopsis — had no
 * lineage at all and sat in an "Unplaced organisms" bucket. They now have an
 * NCBI lineage, served as a SEPARATE view: GTDB and NCBI are different
 * methodologies that disagree, and a merged tree would be a hybrid a reader
 * could not pick apart.
 */

async function ready(page: Page) {
  await page.goto("/");
  await page.waitForSelector("svg [data-figure-root='true']", { timeout: 60_000 });
  await dismissWelcome(page);
  await page.waitForTimeout(1500);
}

const nodes = (page: Page) => page.locator("svg [data-figure-root='true'] g[data-node-key]");
const euk = (page: Page) => page.getByRole("button", { name: "Eukaryotes", exact: true });
const pro = (page: Page) => page.getByRole("button", { name: "Prokaryotes", exact: true });

test("the Eukaryotes tab renders an NCBI-ranked fungal tree", async ({ page }) => {
  await ready(page);
  await euk(page).click();
  await page.waitForTimeout(2500);

  expect(await nodes(page).count()).toBeGreaterThan(20);
  await expect(page.getByText("Eukaryota", { exact: false }).first()).toBeVisible();

  // Kingdom is the rank GTDB never emits and this project had to add for
  // eukaryotes. Asserted through the collapse control rather than a rendered
  // label, because semantic zoom hides labels that do not fit — which says
  // nothing about whether the rank is in the data.
  const kingdomLevel = page.locator('button[title*="Collapse the tree to Kingdom"]');
  await expect(kingdomLevel).toBeEnabled();
});

test("Kingdom is offered only where the taxonomy actually has one", async ({ page }) => {
  await ready(page);
  // GTDB is prokaryote-only: its top rank is domain, so the level is present
  // in the control but disabled rather than offered as a no-op.
  await expect(page.locator('button[title*="No Kingdom rank in this dataset"]')).toBeVisible();

  await euk(page).click();
  await page.waitForTimeout(2500);
  await expect(page.locator('button[title*="Collapse the tree to Kingdom"]')).toBeEnabled();
});

test("each tab shows only its own taxonomy", async ({ page }) => {
  await ready(page);
  // The bacterial tree must not contain the eukaryote root...
  await expect(page.getByText("Eukaryota", { exact: true })).toHaveCount(0);

  await euk(page).click();
  await page.waitForTimeout(2500);
  // ...and the eukaryote tree must not contain the bacterial one.
  await expect(page.getByText("Bacteria", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Eukaryota", { exact: false }).first()).toBeVisible();
});

test("the header names the taxonomy actually on screen", async ({ page }) => {
  await ready(page);
  await expect(page.getByText("taxonomic tree (GTDB)")).toBeVisible();

  await euk(page).click();
  await page.waitForTimeout(2000);
  // Labelling an NCBI tree "GTDB" would misattribute half the corpus.
  await expect(page.getByText("taxonomic tree (NCBI Taxonomy)")).toBeVisible();
});

test("switching tabs does not carry stale view state across", async ({ page }) => {
  await ready(page);
  // Collapse state is keyed by node id; those ids do not exist in the other
  // tree, so they must be dropped or the new tree renders wrong.
  await page.locator('button[title*="Collapse the tree to Family"]').click();
  await page.waitForTimeout(800);

  await euk(page).click();
  await page.waitForTimeout(2500);
  expect(await nodes(page).count()).toBeGreaterThan(20);

  await page.getByRole("button", { name: "Tree", exact: true }).click();
  await page.waitForTimeout(2500);
  expect(await nodes(page).count()).toBeGreaterThan(20);
});


test("taxonomy and view are separate controls", async ({ page }) => {
  await ready(page);
  // The tabs used to read "Tree | Eukaryotes | Flows | Matrix" — one named a
  // widget, the next named a clade, and there was no way to reach the Sankey
  // or the matrix for eukaryotes at all.
  await expect(pro(page)).toBeVisible();
  await expect(euk(page)).toBeVisible();
  for (const view of ["Tree", "Flows", "Matrix"]) {
    await expect(page.getByRole("button", { name: view, exact: true })).toBeVisible();
  }
});

test("Flows and Matrix follow the selected taxonomy", async ({ page }) => {
  await ready(page);

  await page.getByRole("button", { name: "Matrix", exact: true }).click();
  await page.waitForTimeout(2000);
  // Bacterial genera, and no fungal ones.
  await expect(page.getByText("Streptomyces", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Aspergillus", { exact: true })).toHaveCount(0);

  await euk(page).click();
  await page.waitForTimeout(2500);
  // ...and the reverse. Unscoped, both appeared as peer rows even though
  // GTDB and NCBI ranks are not comparable.
  await expect(page.getByText("Aspergillus", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Streptomyces", { exact: true })).toHaveCount(0);
});

test("matrix cell values stay legible at low intensity", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Matrix", exact: true }).click();
  await page.waitForTimeout(2000);

  // Intensity belongs in the fill's alpha, not in `opacity` on the cell:
  // element opacity faded the NUMBER along with its background, so the
  // low-rate cells a reader most needs to read a value off were the least
  // legible ones.
  const faded = await page.evaluate(() =>
    Array.from(document.querySelectorAll("td"))
      .filter((td) => /^\d+$/.test(td.textContent?.trim() ?? ""))
      .filter((td) => {
        const o = getComputedStyle(td).opacity;
        return o !== "" && Number(o) < 0.95;
      }).length,
  );
  expect(faded, "cells with numbers must not be faded by element opacity").toBe(0);
});
