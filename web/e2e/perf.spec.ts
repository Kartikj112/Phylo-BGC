import { test, expect, type Page } from "@playwright/test";
import { dismissWelcome } from "./support";

/**
 * Measured, not asserted-by-feel.
 *
 * Reports initial load and interaction cost against whatever corpus the API
 * is serving. Run before and after a change to get a real delta; the
 * thresholds are deliberately loose (they exist to catch a catastrophic
 * regression, not to encode today's numbers as a contract).
 */

async function load(page: Page) {
  const t0 = Date.now();
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("svg [data-figure-root='true']", { timeout: 60_000 });
  await dismissWelcome(page);
  await page.waitForFunction(
    () => document.querySelectorAll("svg [data-figure-root='true'] circle").length > 5,
    { timeout: 60_000 },
  );
  return Date.now() - t0;
}

test("initial load and interaction cost", async ({ page }) => {
  const loadMs = await load(page);
  const nodes = await page.locator("svg [data-figure-root='true'] circle").count();

  const transfer = await page.evaluate(() => {
    const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const tree = entries.find((e) => e.name.includes("/api/v1/taxonomy-tree"));
    return tree
      ? { encoded: tree.encodedBodySize, decoded: tree.decodedBodySize, ms: Math.round(tree.duration) }
      : null;
  });

  // A 40-step pan. Under the old implementation each mouse-move set React
  // state and reconciled every node in the tree; now the transform is
  // written straight to the DOM. This is the number that changes.
  const box = await page.locator("svg [data-canvas-bg='true']").boundingBox();
  if (!box) throw new Error("no canvas");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Long tasks are the metric that actually separates the two
  // implementations.
  //
  // Measured on the 2,437-BGC corpus (3,528 rendered nodes): holding the
  // pan transform in React state produced 3 long tasks (>50 ms of blocked
  // main thread — visible jank) across a 40-step drag; writing it straight
  // to the DOM produces 0. Mutation count is NOT the discriminator, which
  // is worth recording: React's diffing already wrote only the changed
  // attribute, so both versions mutate ~40 times. The cost was the
  // reconciliation pass over every node, not the DOM write — which is
  // exactly what longtask sees and MutationObserver does not.
  await page.evaluate(() => {
    const w = window as any;
    w.__mutations = 0;
    w.__longTasks = 0;
    const target = document.querySelector("svg [data-figure-root='true']")?.parentElement;
    if (target) {
      w.__mo = new MutationObserver((records) => {
        w.__mutations += records.length;
      });
      w.__mo.observe(target, { attributes: true, childList: true, subtree: true, characterData: true });
    }
    try {
      const po = new PerformanceObserver((l) => {
        w.__longTasks += l.getEntries().length;
      });
      po.observe({ entryTypes: ["longtask"] });
    } catch {
      /* longtask unsupported; the mutation count still stands */
    }
  });

  const t0 = Date.now();
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "middle" });
  for (let i = 0; i < 40; i++) await page.mouse.move(cx + i * 4, cy + i * 2);
  await page.mouse.up({ button: "middle" });
  const panMs = Date.now() - t0;
  const { longTasks, mutations } = await page.evaluate(() => {
    const w = window as any;
    w.__mo?.disconnect();
    return { longTasks: w.__longTasks ?? 0, mutations: w.__mutations ?? 0 };
  });

  console.log("\n  ---- Phylo-BGC frontend performance ----");
  console.log(`  nodes rendered              ${nodes}`);
  console.log(`  initial load (nav -> tree)  ${loadMs} ms`);
  if (transfer) {
    console.log(`  taxonomy-tree transfer      ${transfer.encoded} bytes on the wire`);
    console.log(`  taxonomy-tree decoded       ${transfer.decoded} bytes`);
    console.log(`  taxonomy-tree request       ${transfer.ms} ms`);
  }
  console.log(`  40-step pan gesture         ${panMs} ms`);
  console.log(`  DOM mutations during pan    ${mutations}   <-- re-render proxy`);
  console.log(`  long tasks during pan       ${longTasks}`);
  console.log("  ----------------------------------------\n");

  expect(nodes).toBeGreaterThan(5);
  expect(loadMs).toBeLessThan(30_000);
});
