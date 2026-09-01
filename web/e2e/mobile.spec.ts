import { expect, test, type Page } from "@playwright/test";
import { dismissWelcome } from "./support";

/**
 * The phone build.
 *
 * Everything here was unreachable on a touchscreen before this suite
 * existed, and none of it is visible to the desktop specs — they run at
 * 1440x900 with a mouse, where the rail is pinned open, the detail panel is
 * a column, and `shift`+click and `dblclick` both exist.
 *
 * The gestures are dispatched through CDP rather than Playwright's `tap()`
 * because a pinch is two simultaneous touch points, which the high-level
 * API has no way to express — and a pinch is exactly the gesture that was
 * broken (d3-zoom's event filter rejected every touch, so the canvas could
 * not be zoomed or panned by finger at all).
 */

const FIGURE = "svg [data-figure-root='true']";

async function ready(page: Page) {
  await page.goto("/");
  await page.waitForSelector(FIGURE, { timeout: 60_000 });
  await dismissWelcome(page);
  await page.waitForTimeout(1500);
}

/** The live pan/zoom transform, which the canvas writes straight to the DOM. */
function zoomTransform(page: Page) {
  return page.evaluate(() => {
    const bg = document.querySelector("[data-canvas-bg]");
    return bg?.parentElement?.querySelector("g")?.getAttribute("transform") ?? null;
  });
}

function scaleOf(transform: string | null): number {
  return Number(/scale\(([\d.]+)\)/.exec(transform ?? "")?.[1] ?? NaN);
}

/** A raw multi-touch gesture. `points` is one array of [x, y] per frame. */
async function gesture(page: Page, frames: [number, number][][]) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: "touchStart" | "touchMove" | "touchEnd", pts: [number, number][]) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: pts.map(([x, y], id) => ({ x, y, id })),
    });
  await send("touchStart", frames[0]!);
  for (const f of frames.slice(1)) {
    await send("touchMove", f);
    await page.waitForTimeout(25);
  }
  await send("touchEnd", []);
  await page.waitForTimeout(350);
}

test("pinch zooms the canvas", async ({ page }) => {
  await ready(page);
  const before = scaleOf(await zoomTransform(page));

  const [cx, cy] = [195, 520];
  await gesture(
    page,
    Array.from({ length: 9 }, (_, i): [number, number][] => {
      const d = 40 + i * 12;
      return [
        [cx - d, cy],
        [cx + d, cy],
      ];
    }),
  );

  expect(scaleOf(await zoomTransform(page))).toBeGreaterThan(before * 1.5);
});

test("one finger on empty canvas pans, and the page itself never scrolls", async ({ page }) => {
  await ready(page);
  const before = await zoomTransform(page);

  // Top-left of the canvas area: outside the radial figure, so this is the
  // background, where a single-finger drag means "pan" rather than "drag
  // this node" or "select this tip".
  await gesture(
    page,
    Array.from({ length: 9 }, (_, i): [number, number][] => [[30 + i * 10, 330 + i * 10]]),
  );

  const after = await zoomTransform(page);
  expect(after).not.toEqual(before);
  // The scale must be untouched — this was a pan, not a zoom.
  expect(scaleOf(after)).toBeCloseTo(scaleOf(before), 5);

  // `touch-action: none` on the canvas means the gesture never reaches the
  // document. If it did, the tree would slide out from under the reader.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("the zoom buttons step in and out", async ({ page }) => {
  await ready(page);
  const start = scaleOf(await zoomTransform(page));

  await page.getByRole("button", { name: "Zoom in" }).tap();
  await page.waitForTimeout(500);
  const zoomedIn = scaleOf(await zoomTransform(page));
  expect(zoomedIn).toBeGreaterThan(start);

  await page.getByRole("button", { name: "Zoom out" }).tap();
  await page.waitForTimeout(500);
  expect(scaleOf(await zoomTransform(page))).toBeCloseTo(start, 5);
});

test("tapping a clade label offers focus and comparison", async ({ page }) => {
  await ready(page);

  // Focus and compare are shift-click and double-click on a desktop. A
  // touchscreen can produce neither, so without this menu they are simply
  // not available — which is what this asserts.
  await page.locator(`${FIGURE} text`, { hasText: /^Actinomycetota$/ }).first().tap();
  await page.waitForTimeout(400);

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Add to comparison/ })).toBeVisible();

  await menu.getByRole("menuitem", { name: "Focus on this clade" }).tap();
  await page.waitForTimeout(1200);

  await expect(page.getByRole("menu")).toHaveCount(0);
  // Focus mode is entered: the breadcrumb trail back out is now on screen.
  await expect(page.getByTitle("Back to the whole tree")).toBeVisible();
});

test("the filter rail is a drawer that closes once it has been used", async ({ page }) => {
  await ready(page);

  const rail = page.locator("aside");
  const offscreen = async () => (await rail.boundingBox())!.x < 0;
  expect(await offscreen()).toBe(true);

  await page.getByRole("button", { name: "Open controls" }).tap();
  await page.waitForTimeout(400);
  expect(await offscreen()).toBe(false);

  // Choosing a depth reshapes the tree, so the drawer covering it gets out
  // of the way rather than making the reader dismiss it to see the result.
  await page.getByRole("button", { name: /Genus/ }).tap();
  await page.waitForTimeout(800);
  expect(await offscreen()).toBe(true);
});

test("the detail panel docks to the bottom edge instead of taking a column", async ({ page }) => {
  await page.goto("/?bgc=BGC0002153");
  await page.waitForSelector(FIGURE, { timeout: 60_000 });
  await dismissWelcome(page);
  await expect(page.getByLabel("Close detail panel")).toBeVisible();

  const geom = await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="Close detail panel"]')!;
    let p = btn.parentElement!;
    while (p && !p.className.includes("absolute")) p = p.parentElement!;
    const r = p.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      width: Math.round(r.width),
      bottom: Math.round(r.bottom),
      vw: window.innerWidth,
      vh: window.innerHeight,
      // A 320px column on a 390px screen is what this replaces; any
      // horizontal overflow means it is still trying to be one.
      docWidth: document.documentElement.scrollWidth,
    };
  });

  expect(geom.x).toBe(0);
  expect(geom.width).toBe(geom.vw);
  expect(geom.bottom).toBe(geom.vh);
  expect(geom.docWidth).toBe(geom.vw);
});

test("no view overflows the viewport horizontally", async ({ page }) => {
  await ready(page);
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  expect(await overflow()).toBeLessThanOrEqual(0);

  for (const view of ["Flows", "Matrix"]) {
    await page.getByRole("button", { name: view, exact: true }).tap();
    await page.waitForTimeout(2000);
    expect(await overflow(), `${view} view overflows the page`).toBeLessThanOrEqual(0);
  }
});
