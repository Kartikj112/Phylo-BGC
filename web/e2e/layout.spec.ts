import { expect, test, type Page } from "@playwright/test";

/**
 * The initial view, the layout controls, and node dragging.
 *
 * These assert the properties that make the first screen interpretable —
 * horizontal by default, collapsed to a readable level, spread across the
 * viewport — and that a manual drag moves a node without touching the
 * hierarchy behind it.
 */

async function ready(page: Page) {
  await page.goto("/");
  await page.waitForSelector("svg [data-figure-root='true']", { timeout: 60_000 });
  await page.waitForTimeout(1200);
}

const nodes = (page: Page) =>
  page.locator("svg [data-figure-root='true'] g[data-node-key]");

/** The tree now opens horizontal, so the checks that measure radial geometry
 * — distance and direction from the figure centre — have to ask for that
 * view rather than assume the first paint is it. */
async function readyRadial(page: Page) {
  await ready(page);
  await page.getByTitle("Circular tree").click();
  await page.waitForTimeout(1200);
}

test("opens horizontal, collapsed to a readable level", async ({ page }) => {
  await ready(page);

  // Horizontal is the default: its toggle is the active one, and the
  // circular toggle is not.
  await expect(page.getByTitle("Horizontal tree")).toHaveClass(/bg-chrome-accent-wash/);
  await expect(page.getByTitle("Circular tree")).not.toHaveClass(/bg-chrome-accent-wash/);

  // Far fewer than the fully-expanded 3,528 — the point is that the shape of
  // the corpus is readable before the user expands anything.
  const n = await nodes(page).count();
  expect(n).toBeGreaterThan(20);
  expect(n).toBeLessThan(400);
});

test("collapsed clades can still be expanded interactively", async ({ page }) => {
  await ready(page);
  const before = await nodes(page).count();

  // "Show down to" one level deeper must reveal more of the tree.
  await page.locator('button[title*="Collapse the tree to Family"]').click();
  await page.waitForTimeout(600);
  expect(await nodes(page).count()).toBeGreaterThan(before);
});

test("horizontal view spreads across the viewport width", async ({ page }) => {
  await ready(page);
  // Already the default view; the round trip proves the toggle still lands
  // back on a correctly framed horizontal tree rather than the first paint.
  await page.getByTitle("Circular tree").click();
  await page.waitForTimeout(600);
  await page.getByTitle("Horizontal tree").click();
  await page.waitForTimeout(1200);

  // Measure the drawn extent of the tree on screen. It used to render as a
  // narrow vertical smear occupying a fraction of a wide window, because the
  // layout's cross axis dwarfed its depth axis and fit-to-view shrank
  // everything to fit the height.
  const box = await page.locator("svg [data-figure-root='true']").boundingBox();
  const canvas = await page.locator("svg [data-canvas-bg='true']").boundingBox();
  if (!box || !canvas) throw new Error("no bounding box");

  const usedWidth = box.width / canvas.width;
  expect(usedWidth, `tree spans only ${(usedWidth * 100).toFixed(0)}% of the canvas width`)
    .toBeGreaterThan(0.5);
});

test("dragging a node moves it without changing the tree", async ({ page }) => {
  await ready(page);
  const before = await nodes(page).count();

  const target = nodes(page).nth(3);
  const box = await target.boundingBox();
  if (!box) throw new Error("node has no box");
  const beforeTransform = await target.getAttribute("transform");

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  expect(await target.getAttribute("transform")).not.toEqual(beforeTransform);
  // Topology is untouched: the same nodes are on screen afterwards.
  expect(await nodes(page).count()).toBe(before);
});

test("Auto arrange restores the computed layout after a drag", async ({ page }) => {
  await ready(page);
  const autoArrange = page.getByRole("button", { name: "Auto arrange" });

  // Disabled while nothing has been moved — nothing to tidy.
  await expect(autoArrange).toBeDisabled();

  const target = nodes(page).nth(3);
  const box = await target.boundingBox();
  if (!box) throw new Error("node has no box");
  const original = await target.getAttribute("transform");

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 50, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  await expect(autoArrange).toBeEnabled();
  await autoArrange.click();
  await page.waitForTimeout(600);

  expect(await target.getAttribute("transform")).toEqual(original);
  await expect(autoArrange).toBeDisabled();
});

test("hierarchy regions render behind the tree and can be turned off", async ({ page }) => {
  await ready(page);
  const regions = page.locator("[data-hierarchy-regions] > *");
  expect(await regions.count()).toBeGreaterThan(0);

  // They must be painted before any branch, or they would cover the data.
  const regionsComeFirst = await page.evaluate(() => {
    const figure = document.querySelector("svg [data-figure-root='true']");
    const group = figure?.querySelector("[data-hierarchy-regions]");
    if (!figure || !group) return false;
    const kids = Array.from(figure.children);
    const firstPath = kids.findIndex((k) => k.tagName === "path" || k.querySelector?.("path"));
    return kids.indexOf(group) === 0 || firstPath === -1 || kids.indexOf(group) < firstPath;
  });
  expect(regionsComeFirst).toBe(true);

  await page.getByRole("button", { name: "Clades" }).click();
  await page.waitForTimeout(400);
  expect(await regions.count()).toBe(0);
});

test("in radial view every label and BGC bar radiates outward", async ({ page }) => {
  await readyRadial(page);

  // The regression: `CladeGlyph` negated its x for the left hemisphere but,
  // unlike the labels, was not wrapped in the matching rotate(180) — so
  // nothing cancelled the negation and every glyph on the left half grew
  // back towards the centre. Measured before the fix: 31 of 31 inward on the
  // left against 28 of 28 outward on the right.
  //
  // Compared against the node's own origin via getScreenCTM rather than a
  // bounding box, because a collapsed node renders its glyph INSTEAD of a
  // circle and SVG <g> reports a zero-size rect.
  const result = await page.evaluate(() => {
    const figure = document.querySelector("svg [data-figure-root='true']") as SVGGElement;
    const svg = figure.ownerSVGElement!;
    const originOf = (el: SVGGraphicsElement) => {
      const p = svg.createSVGPoint();
      p.x = 0;
      p.y = 0;
      return p.matrixTransform(el.getScreenCTM()!);
    };
    const centre = originOf(figure);
    const out = { left: { outward: 0, inward: 0 }, right: { outward: 0, inward: 0 } };

    for (const title of Array.from(document.querySelectorAll("g[data-node-key] title"))) {
      const glyph = title.parentElement as unknown as SVGGraphicsElement;
      const host = title.closest("g[data-node-key]") as unknown as SVGGraphicsElement | null;
      const rect = glyph.querySelector("rect");
      if (!host || !rect) continue;

      const node = originOf(host);
      const box = rect.getBoundingClientRect();
      const nodeR = Math.hypot(node.x - centre.x, node.y - centre.y);
      const glyphR = Math.hypot(box.x + box.width / 2 - centre.x, box.y + box.height / 2 - centre.y);
      if (nodeR < 1) continue; // the root sits at the centre; no direction

      const side = node.x >= centre.x ? "right" : "left";
      out[side][glyphR > nodeR ? "outward" : "inward"] += 1;
    }
    return out;
  });

  expect(result.left.outward + result.left.inward, "no glyphs sampled on the left half")
    .toBeGreaterThan(0);
  expect(result.right.outward + result.right.inward, "no glyphs sampled on the right half")
    .toBeGreaterThan(0);
  expect(result.left.inward, `${result.left.inward} clade glyphs point inward on the left half`)
    .toBe(0);
  expect(result.right.inward, `${result.right.inward} clade glyphs point inward on the right half`)
    .toBe(0);
});

/** Spread of the tip glyphs' distance from the tree centre. Small spread ==
 * they share a baseline; large spread == each hangs off its own node. */
async function glyphRadiusSpread(page: Page): Promise<number> {
  return page.evaluate(() => {
    const figure = document.querySelector("svg [data-figure-root='true']") as SVGGElement;
    const svg = figure.ownerSVGElement!;
    const origin = (el: SVGGraphicsElement) => {
      const p = svg.createSVGPoint();
      p.x = 0;
      p.y = 0;
      return p.matrixTransform(el.getScreenCTM()!);
    };
    const centre = origin(figure);
    const radii: number[] = [];
    for (const title of Array.from(document.querySelectorAll("g[data-node-key] title"))) {
      const rect = (title.parentElement as unknown as SVGGElement).querySelector("rect");
      if (!rect) continue;
      const b = rect.getBoundingClientRect();
      radii.push(Math.hypot(b.x + b.width / 2 - centre.x, b.y + b.height / 2 - centre.y));
    }
    if (radii.length < 5) return -1;
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    return Math.sqrt(radii.reduce((a, r) => a + (r - mean) ** 2, 0) / radii.length);
  });
}

test("aligned glyphs share one baseline; turning it off does not", async ({ page }) => {
  await readyRadial(page);
  await page.locator('button[title*="Collapse the tree to Family"]').click();
  await page.waitForTimeout(1200);

  const aligned = await glyphRadiusSpread(page);
  expect(aligned, "not enough glyphs sampled").toBeGreaterThan(-1);

  await page.getByRole("button", { name: "Aligned" }).click();
  await page.waitForTimeout(1000);
  const inline = await glyphRadiusSpread(page);

  // Aligned puts every tip glyph on a shared track, so the spread collapses.
  // Inline hangs each off its own node, which sit at many different depths.
  expect(aligned).toBeLessThan(inline);
  expect(aligned).toBeLessThan(20);
});

test("hierarchy regions recede as the view zooms in", async ({ page }) => {
  await ready(page);
  const first = page.locator("[data-hierarchy-regions] > *").first();
  const atRest = Number(await first.getAttribute("fill-opacity"));

  const box = await page.locator("svg [data-canvas-bg='true']").boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -400);
  await page.waitForTimeout(800);

  // Tuned at the default framing, the regions scale with everything else and
  // become slabs that wash out the tree once you are inside a single clade.
  const zoomed = Number(await first.getAttribute("fill-opacity"));
  expect(zoomed).toBeLessThan(atRest);
  expect(zoomed).toBeGreaterThan(0);
});
