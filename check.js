// Galena Park Document Library Watcher — includes new doc names on "Updated"
// First line remains EXACTLY "Updated" or "Not updated" for easy filtering.

import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import nodemailer from "nodemailer";

const TARGET_URL = process.env.TARGET_URL || "https://www.cityofgalenapark-tx.gov/DocumentCenter/Index/69";
const STATE_FILE = path.join(process.cwd(), "state.json");
const RECIPIENTS = (process.env.RECIPIENTS || "").split(",").map(s => s.trim()).filter(Boolean);

// Manual test controls
const FORCE_SEND = String(process.env.FORCE_SEND || "false").toLowerCase() === "true";
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

function nowInChicago() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  const hhmm = `${parts.hour}:${parts.minute}`;
  return { ymd, minutes, hhmm };
}

// Send only around 7:00 and 16:30 CT unless forced
function shouldSendNow(state) {
  if (FORCE_SEND) return { go: true, key: `FORCE-${Date.now()}`, info: "Forced send" };
  const { ymd, minutes, hhmm } = nowInChicago();
  const windows = [
    { name: "AM", target: 7 * 60 },
    { name: "PM", target: 16 * 60 + 30 }
  ];
  const tolerance = 8;
  for (const w of windows) {
    if (Math.abs(minutes - w.target) <= tolerance) {
      const key = `${ymd}-${w.name}`;
      if (state.sent?.[key]) return { go: false, info: `Already sent for ${key}` };
      return { go: true, key, info: `Within window ${w.name} at ${hhmm} CT` };
    }
  }
  return { go: false, info: `Outside send window at ${hhmm} CT` };
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
      // Title text: prefer anchor text; fallback to filename-ish tail
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
  // Sort for determinism
  items.sort((a, b) => a.href.localeCompare(b.href));
  return items;
}

async function sendEmail(body) {
  const tx = makeTransport();
  console.log(`Sending email to: ${RECIPIENTS.join(", ")} — first line: "${body.split("\n")[0]}"`);
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

  const state = readState();
  const gate = shouldSendNow(state);
  console.log(gate.info || (gate.go ? "Send permitted" : "Send not permitted"));

  // Seed baseline if first run
  if (!state.init) {
    const docs = await fetchDocs().catch((e) => {
      console.error("Seed fetch failed:", e?.message || e);
      return [];
    });
    state.seen = Array.from(new Set([...(state.seen || []), ...docs.map(d => d.href)])).slice(-1000);
    state.init = true;
    writeState(state);
    console.log(`Seeded baseline with ${state.seen.length} links.`);
    if (!gate.go && !FORCE_SEND) process.exit(0);
  } else if (!gate.go && !FORCE_SEND) {
    console.log("Exiting without email (outside window).");
    process.exit(0);
  }

  // Optional manual test body
  if (FORCE_BODY === "Updated" || FORCE_BODY === "Not updated") {
    await sendEmail(FORCE_BODY);
    if (gate.key) state.sent[gate.key] = true;
    writeState(state);
    process.exit(0);
  }

  // Normal run
  let docs = [];
  try {
    docs = await fetchDocs();
  } catch (e) {
    console.error("Fetch failed:", e.message || e);
    await sendEmail("Not updated");   // fail safe
    if (gate.key) state.sent[gate.key] = true;
    writeState(state);
    process.exit(0);
  }

  if (docs.length === 0) {
    console.warn("Zero docs after fetch; sending Not updated (baseline unchanged).");
    await sendEmail("Not updated");
    if (gate.key) state.sent[gate.key] = true;
    writeState(state);
    process.exit(0);
  }

  const seenSet = new Set(state.seen || []);
  const newDocs = docs.filter(d => !seenSet.has(d.href));
  console.log(`Baseline size: ${state.seen.length}. New docs: ${newDocs.length}.`);

  if (newDocs.length === 0) {
    await sendEmail("Not updated");
    if (gate.key) state.sent[gate.key] = true;
    writeState(state);
    process.exit(0);
  }

  // Compose body: "Updated" + list of new titles (limit to 25 lines just in case)
  const list = newDocs.slice(0, 25).map(d => `- ${d.title}`).join("\n");
  const more = newDocs.length > 25 ? `\n(+${newDocs.length - 25} more)` : "";
  const body = `Updated\n\nNew documents:\n${list}${more}`;

  await sendEmail(body);

  // Merge into baseline
  state.seen = Array.from(new Set([...(state.seen || []), ...docs.map(d => d.href)])).slice(-1000);
  if (gate.key) state.sent[gate.key] = true;
  state.init = true;
  writeState(state);
})();
