// Galena Park Document Library Watcher
// Loads the page *with JS*, collects /DocumentCenter/View/... links,
// compares to prior run, and emails exactly "Updated" or "Not updated".

import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import nodemailer from "nodemailer";

const TARGET_URL = process.env.TARGET_URL || "https://www.cityofgalenapark-tx.gov/DocumentCenter/Index/69";
const STATE_FILE = path.join(process.cwd(), "state.json");
const RECIPIENTS = (process.env.RECIPIENTS || "").split(",").map(s => s.trim()).filter(Boolean);

// Email (SMTP) env vars: SMTP_HOST, SMTP_PORT, SMTP_SECURE ("true"/"false"), SMTP_USER, SMTP_PASS, SMTP_FROM
function makeTransport() {
  const secure = String(process.env.SMTP_SECURE ?? "true").toLowerCase() === "true";
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || (secure ? 465 : 587)),
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function nowInChicago() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  return { ymd, minutes };
}

// Only send at ~7:00 and ~16:30 CT even if the workflow runs at other times.
function shouldSendNow(state) {
  const { ymd, minutes } = nowInChicago();
  const windows = [
    { name: "AM", target: 7 * 60 },          // 07:00
    { name: "PM", target: 16 * 60 + 30 }     // 16:30
  ];
  const tolerance = 8; // minutes of cron jitter allowed
  for (const w of windows) {
    if (Math.abs(minutes - w.target) <= tolerance) {
      const key = `${ymd}-${w.name}`;
      if (state.sent?.[key]) return { go: false };
      return { go: true, key };
    }
  }
  return { go: false };
}

function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!j || typeof j !== "object") throw new Error();
    j.seen = Array.isArray(j.seen) ? j.seen : [];
    j.sent = j.sent && typeof j.sent === "object" ? j.sent : {};
    return j;
  } catch {
    return { seen: [], sent: {} };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchLinks() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);

  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
  // Wait for dynamically-inserted doc links to be present
  await page.waitForSelector('a[href^="/DocumentCenter/View/"], a[href*="/DocumentCenter/View/"]', { timeout: 60000 });

  const hrefs = await page.$$eval('a[href*="/DocumentCenter/View/"]', as =>
    Array.from(new Set(as.map(a => new URL(a.getAttribute("href"), location.href).href)))
  );

  await browser.close();
  return hrefs.sort();
}

async function sendEmail(body) {
  const tx = makeTransport();
  await tx.sendMail({
    to: RECIPIENTS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    subject: "Document Library Monitor",
    text: body.trim() // exactly "Updated" or "Not updated"
  });
}

(async () => {
  if (RECIPIENTS.length === 0) {
    console.error("No RECIPIENTS provided.");
    process.exit(1);
  }

  const state = readState();
  const gate = shouldSendNow(state);
  if (!gate.go) {
    // First-time seed so future comparisons work, but don't email yet
    if (!state.init) {
      const links = await fetchLinks().catch(() => []);
      state.seen = Array.from(new Set([...(state.seen || []), ...links])).slice(-1000);
      state.init = true;
      writeState(state);
      console.log("Seeded baseline.");
    }
    process.exit(0);
  }

  let links = [];
  try {
    links = await fetchLinks();
  } catch (e) {
    console.error("Fetch failed:", e.message || e);
    await sendEmail("Not updated");   // fail safe: never go silent
    state.sent[gate.key] = true;
    writeState(state);
    process.exit(0);
  }

  if (links.length === 0) {
    await sendEmail("Not updated");   // layout hiccup? don't overwrite baseline
    state.sent[gate.key] = true;
    writeState(state);
    process.exit(0);
  }

  const seen = new Set(state.seen || []);
  const newOnes = links.filter(u => !seen.has(u));
  const verdict = newOnes.length > 0 ? "Updated" : "Not updated";

  await sendEmail(verdict);

  if (newOnes.length > 0) {
    state.seen = Array.from(new Set([...(state.seen || []), ...links])).slice(-1000);
  }
  state.sent[gate.key] = true;
  state.init = true;
  writeState(state);
})();
