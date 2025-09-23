// Galena Park Document Library Watcher — targets the left tree:
// Agendas -> 2025 and Minutes -> 2025
// Sends EVERY scheduled run. First line is EXACTLY "Updated" or "Not updated".
// If "Updated", it lists the new document titles (with [Agendas] / [Minutes] tags).

import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import nodemailer from "nodemailer";

const BASE_URL = process.env.TARGET_URL || "https://www.cityofgalenapark-tx.gov/DocumentCenter/Index/69";
const STATE_FILE = path.join(process.cwd(), "state.json");
const RECIPIENTS = (process.env.RECIPIENTS || "").split(",").map(s => s.trim()).filter(Boolean);

// Optional: manual test body
const FORCE_BODY = (process.env.FORCE_BODY || "").trim(); // "Updated" or "Not updated"
const RESET_BASELINE = String(process.env.RESET_BASELINE || "false").toLowerCase() === "true";

const CATEGORIES = ["Agendas", "Minutes"];
const YEAR = "2025";

function makeTransport() {
  const secure = String(process.env.SMTP_SECURE ?? "true").toLowerCase() === "true";
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || (secure ? 465 : 587)),
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!j || typeof j !== "object") throw new Error();
    j.seen = Array.isArray(j.seen) ? j.seen : [];
    return j;
  } catch {
    return { seen: [], init: false };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function gotoAndSettle(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // CivicEngage populates via JS; a short settle helps before querying
  await page.waitForTimeout(600);
}

/** Click a link by its visible text, case-insensitive, preferring left tree if present. */
async function clickByText(page, text) {
  const ci = new RegExp(`^\\s*${text}\\s*$`, "i");

  // Try inside likely left-tree containers first
  const leftCandidates = [
    'aside',                            // many CivicEngage themes use <aside> for the tree
    '#leftColumn, .leftColumn',         // common ids/classes
    '.document-center-tree, .tree',     // generic tree containers
    'nav[role="navigation"]'            // nav container
  ];

  for (const sel of leftCandidates) {
    const scope = page.locator(sel);
    if (await scope.count()) {
      const link = scope.getByRole('link', { name: ci });
      if (await link.count()) {
        await link.first().click();
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(300);
        return;
      }
    }
  }

  // Fallback: anywhere on the page
  const any = page.getByRole('link', { name: ci });
  if (await any.count()) {
    await any.first().click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(300);
    return;
  }

  // Last resort: partial text search
  const partial = page.locator('a', { hasText: text });
  if (await partial.count()) {
    await partial.first().click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(300);
    return;
  }

  throw new Error(`Could not find link "${text}"`);
}

/** Ensure the center table is present (has "Display Name" header or at least one View link). */
async function waitForDocumentTable(page) {
  try {
    await page.waitForSelector('th:has-text("Display Name")', { timeout: 4000 });
  } catch {
    // header might differ; wait for any document link instead
  }
  await page.waitForSelector('a[href*="/DocumentCenter/View/"]', { timeout: 15000 });
}

/** Collect all doc rows on the current page (Display Name column links). */
async function collectDocsOnCurrentPage(page) {
  await waitForDocumentTable(page);
  const items = await page.$$eval('a[href*="/DocumentCenter/View/"]', as =>
    Array.from(new Set(as.map(a => {
      const href = new URL(a.getAttribute("href"), location.href).href;
      let title = (a.textContent || "").trim();
      if (!title) {
        try {
          const parts = href.split("/");
          title = decodeURIComponent(parts[parts.length - 1]).replace(/[-_]/g, " ");
        } catch {
          title = href;
        }
      }
      return JSON.stringify({ href, title });
    }))).map(s => JSON.parse(s))
  );
  return items;
}

/** Click "Next" if pagination exists; returns true if advanced. */
async function clickNextIfAny(page) {
  const candidates = [
    page.getByRole("link", { name: /^\s*Next\s*$/i }),
    page.locator('a[rel="next"]'),
    page.locator('a[aria-label="Next"]'),
    page.locator('.pagination a', { hasText: 'Next' }),
    page.locator('nav[role="navigation"] a', { hasText: 'Next' }),
    page.locator('a:has-text("›")')
  ];
  for (const loc of candidates) {
    if (await loc.count()) {
      const el = loc.first();
      if (await el.isVisible()) {
        await el.click();
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(300);
        return true;
      }
    }
  }
  return false;
}

/** Scrape one branch in the tree (e.g., "Minutes" -> "2025"). */
async function scrapeBranch(page, category, year) {
  // Always start from the index (safest with this CMS)
  await gotoAndSettle(page, BASE_URL);

  // Click left tree: category then year
  await clickByText(page, category);
  await clickByText(page, year);

  // Now harvest table rows, including pagination
  let docs = [];
  let guard = 0;
  while (true) {
    const pageDocs = await collectDocsOnCurrentPage(page);
    docs.push(...pageDocs);

    // If there's no next, stop
    const advanced = await clickNextIfAny(page);
    if (!advanced) break;

    // Safety to avoid infinite loops if "Next" doesn't change page
    guard++;
    if (guard > 50) break;
  }

  // Dedup by href
  const map = new Map();
  for (const d of docs) if (!map.has(d.href)) map.set(d.href, d);
  return Array.from(map.values()).sort((a, b) => a.href.localeCompare(b.href));
}

/** Scrape both Agendas/2025 and Minutes/2025 */
async function fetchAllDocs() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);

  const all = [];
  for (const cat of CATEGORIES) {
    console.log(`Scraping ${cat} -> ${YEAR} …`);
    try {
      const items = await scrapeBranch(page, cat, YEAR);
      console.log(`  ${cat}/${YEAR}: ${items.length} docs`);
      all.push(...items.map(d => ({ ...d, category: cat })));
    } catch (e) {
      console.error(`  Failed ${cat}/${YEAR}:`, e.message || e);
    }
  }

  await browser.close();

  // Final dedup
  const map = new Map();
  for (const d of all) if (!map.has(d.href)) map.set(d.href, d);
  return Array.from(map.values()).sort((a, b) => a.href.localeCompare(b.href));
}

async function sendEmail(body) {
  const tx = makeTransport();
  console.log(`Emailing: ${RECIPIENTS.join(", ")} — first line: "${body.split("\n")[0]}"`);
  await tx.sendMail({
    to: RECIPIENTS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    subject: "Document Library Monitor",
    text: body
  });
}

(async () => {
  if (RECIPIENTS.length === 0) {
    console.error("No RECIPIENTS provided.");
    process.exit(1);
  }

  if (FORCE_BODY === "Updated" || FORCE_BODY === "Not updated") {
    await sendEmail(FORCE_BODY);
    process.exit(0);
  }

  let state = readState();
  if (RESET_BASELINE) {
    console.warn("RESET_BASELINE=true — clearing stored baseline before fetch.");
    state = { seen: [], init: false };
    writeState(state);
  }

  let docs = [];
  try {
    docs = await fetchAllDocs();
  } catch (e) {
    console.error("Fetch failed:", e.message || e);
    await sendEmail("Not updated");
    process.exit(0);
  }

  if (docs.length === 0) {
    console.warn("Zero docs fetched; sending Not updated.");
    await sendEmail("Not updated");
    process.exit(0);
  }

  const seenSet = new Set(state.seen || []);
  const newDocs = docs.filter(d => !seenSet.has(d.href));

  if (newDocs.length === 0) {
    await sendEmail("Not updated");
  } else {
    const list = newDocs.slice(0, 50).map(d => `- [${d.category}] ${d.title}`).join("\n");
    const more = newDocs.length > 50 ? `\n(+${newDocs.length - 50} more)` : "";
    const body = `Updated\n\nNew documents (${YEAR}):\n${list}${more}`;
    await sendEmail(body);
  }

  // Update baseline
  state.seen = Array.from(new Set([...(state.seen || []), ...docs.map(d => d.href)])).slice(-2000);
  state.init = true;
  writeState(state);
})();
