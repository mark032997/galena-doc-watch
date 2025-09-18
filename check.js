// Galena Park Document Library Watcher — runs every 2 hours (via cron) and sends each run
// First line is EXACTLY "Updated" or "Not updated". If Updated, it lists new doc titles.

import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import nodemailer from "nodemailer";

const TARGET_URL = process.env.TARGET_URL || "https://www.cityofgalenapark-tx.gov/DocumentCenter/Index/69";
const STATE_FILE = path.join(process.cwd(), "state.json");
const RECIPIENTS = (process.env.RECIPIENTS || "").split(",").map(s => s.trim()).filter(Boolean);

// Optional manual test override
const FORCE_BODY = (process.env.FORCE_BODY || "").trim(); // "Updated" or "Not updated"

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

// Fetch doc links WITH TITLES
async function fetchDocs() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);

  console.log(`Navigating to ${TARGET_URL} ...`);
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });

  console.log("Waiting for document links …");
  await page.waitForSelector('a[href^="/DocumentCenter/View/"], a[href*="/DocumentCenter/View/"]', { timeout: 60000 });

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

  await browser.close();
  console.log(`Found ${items.length} documents.`);
  items.sort((a, b) => a.href.localeCompare(b.href));
  return items;
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

  // Manual override (useful for quick tests)
  if (FORCE_BODY === "Updated" || FORCE_BODY === "Not updated") {
    await sendEmail(FORCE_BODY);
    process.exit(0);
  }

  const state = readState();

  let docs = [];
  try {
    docs = await fetchDocs();
  } catch (e) {
    console.error("Fetch failed:", e.message || e);
    await sendEmail("Not updated");   // fail safe: never go silent
    process.exit(0);
  }

  if (docs.length === 0) {
    console.warn("Zero docs after fetch; sending Not updated (baseline unchanged).");
    await sendEmail("Not updated");
    process.exit(0);
  }

  const seenSet = new Set(state.seen || []);
  const newDocs = docs.filter(d => !seenSet.has(d.href));

  if (newDocs.length === 0) {
    await sendEmail("Not updated");
  } else {
    const list = newDocs.slice(0, 25).map(d => `- ${d.title}`).join("\n");
    const more = newDocs.length > 25 ? `\n(+${newDocs.length - 25} more)` : "";
    const body = `Updated\n\nNew documents:\n${list}${more}`;
    await sendEmail(body);
  }

  // Update baseline after each run
  state.seen = Array.from(new Set([...(state.seen || []), ...docs.map(d => d.href)])).slice(-1000);
  state.init = true;
  writeState(state);
})();
