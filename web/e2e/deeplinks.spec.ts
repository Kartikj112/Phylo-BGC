import { expect, test } from "@playwright/test";
import { dismissWelcome } from "./support";

/**
 * `?taxon=` and `?class=` — the two deep links that shipped untested.
 *
 * `?bgc=` has been covered since the upload work; these two were
 * implemented in the same effect and never exercised, which for a feature
 * whose whole surface is "a URL somebody pastes" means nobody had confirmed
 * the URL does anything at all.
 *
 * Each asserts an observable consequence against a control that loads the
 * same page WITHOUT the parameter. A test that only checked the page still
 * rendered would pass against an effect that read the parameter and threw
 * it away — which, for two untested branches of one effect, is exactly the
 * failure worth ruling out.
 */

test("?class= leaves only that class active in the filter rail", async ({ page }) => {
  await page.goto("/?class=nrps");
  await dismissWelcome(page);
  await page.waitForSelector("[data-canvas-bg]");

  const active = page.locator('[data-class-filter][data-active="true"]');
  await expect(active).toHaveCount(1, { timeout: 20_000 });
  await expect(active).toHaveAttribute("data-class-filter", "nrps");
});

test("without ?class= every class stays active", async ({ page }) => {
  // The control. Without it, a rail that rendered exactly one active class
  // by accident would pass the test above.
  await page.goto("/");
  await dismissWelcome(page);
  await page.waitForSelector("[data-canvas-bg]");

  const active = page.locator('[data-class-filter][data-active="true"]');
  await expect(active.first()).toBeVisible({ timeout: 20_000 });
  expect(await active.count()).toBeGreaterThan(1);
});

test("an unknown ?class= is ignored rather than emptying the tree", async ({ page }) => {
  /* The worst failure here would be a typo'd or retired class name silently
   * filtering every cluster away, leaving a blank canvas that reads as a
   * broken app. The handler only applies values in the known vocabulary. */
  await page.goto("/?class=notarealclass");
  await dismissWelcome(page);
  await page.waitForSelector("[data-canvas-bg]");

  const active = page.locator('[data-class-filter][data-active="true"]');
  await expect(active.first()).toBeVisible({ timeout: 20_000 });
  expect(await active.count()).toBeGreaterThan(1);
});

test("?taxon= focuses that clade", async ({ page }) => {
  await page.goto("/?taxon=Streptomyces");
  await dismissWelcome(page);
  await page.waitForSelector("[data-canvas-bg]");

  // Focus mode is what puts a breadcrumb trail on screen at all — the
  // unfocused tree has none (asserted by the control below), so the trail's
  // presence IS the observable effect, and it names the focused clade.
  // Named "All" from its content — the `title` ("Back to the whole tree")
  // loses to text content in the accessible-name computation.
  const home = page.getByRole("button", { name: "All", exact: true });
  await expect(home).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Streptomyces/ }).first()).toBeVisible({
    timeout: 20_000,
  });
});

test("without ?taxon= there is no focus trail", async ({ page }) => {
  await page.goto("/");
  await dismissWelcome(page);
  await page.waitForSelector("[data-canvas-bg]");
  await expect(page.getByRole("button", { name: "All", exact: true })).toHaveCount(0);
});

test("an unknown ?taxon= leaves the tree at its root", async ({ page }) => {
  await page.goto("/?taxon=Notarealgenus");
  await dismissWelcome(page);
  await page.waitForSelector("[data-canvas-bg]");

  // No focus applied, and — the part that matters — a usable tree rather
  // than a blank canvas.
  await expect(page.getByRole("button", { name: "All", exact: true })).toHaveCount(0);
  await expect(page.locator("svg text").first()).toBeVisible({ timeout: 20_000 });
});
