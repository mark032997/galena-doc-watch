import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import nodemailer from "nodemailer";

const TARGET_URL = process.env.TARGET_URL || "https://www.cityofgalenapark-tx.gov/DocumentCenter/Index/69";
const STATE_FILE = path.join(process.cwd(), "state.json");
const RECIPIENTS = (process.env.RECIPIENTS || "").split(",").map(s => s.trim()).filter(Boolean);

// Manual test controls (from workflow inputs or env vars)
const FORCE_SEND = String(process.env.FORCE_SEND || "false").toLowerCase() === "true";
const FORCE_BODY = (process.env.FORCE_BODY || "").trim(); // "Updated" or "Not updated" (optional)

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

// Only send at ~7:00 and ~16:30 CT unless FORCE_SEND=true
function shouldSendNow(state) {
  if (FORCE_SEND) return { go: true, key: `FORCE-${Date.now()}`, info: "Forced send" };
  const { ymd, minutes, hhmm } = nowInChicago();
  const windows = [
    { name: "AM", target: 7 * 60 },          // 07:00
    { name: "PM", target: 16 * 60 + 30 }     // 16:30
  ];
  const tolerance = 8; // minutes of cron jitter allowed
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

async function fetchLinks() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);

  console.log(`Navigating to ${TARGET_URL} ...`);
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });

  console.log("Waiting for document links …");
  await page.waitForSelector('a[href^="/DocumentCenter/View/"], a[href*="/DocumentCenter/View/"]', { timeout: 60000 });

  const hrefs = await page.$$eval('a[href*="/DocumentCenter/View/"]', as =>
    Array.from(new Set(as.map(a => new URL(a.getAttribute("href"), location.href).href)))
  );

  await browser.close();
  console.log(`Found ${hrefs.length} doc links.`);
  return hrefs.sort();
}

async function sendEmail(body) {
  const tx = makeTransport();
  console.log(`Sending email to: ${RECIPIENTS.join(", ")} — body: "${body}"`);
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
  console.log(gate.info || (gate.go ? "Send permitted" : "Send not permitted"));

  // First run seed (so future comparisons work)
  if (!state.init) {
    const links = await fetchLinks().catch((e) => {
      console.error("Seed fetch failed:", e?.message || e);
      return [];
    });
    state.seen = Array.from(new Set([...(state.seen || []), ...links])).slice(-1000);
    state.init = true;
    writeState(state);
    console.log(`Seeded baseline with ${state.seen.length} links.`);
    if (!gate.go && !FORCE_SEND) process.exit(0);
  } else if (!gate.go && !FORCE_SEND) {
    console.log("Exiting without email (outside window).");
    process.exit(0);
  }

  // If FORCE_BODY provided, just send that now (useful for verifying SMTP works)
  if (FORCE_BODY === "Updated" || FORCE_BODY === "Not updated") {
    await sendEmail(FORCE_BODY);
    if (gate.key) state.sent[gate.key] = true;
    writeState(state);
    process.exit(0);
  }

  // Normal run: compute verdict
  let links = [];
  try {
    links = await fetchLinks();
  } catch (e) {
    console.error("Fetch failed:", e.message || e);
    await sendEmail("Not updated");   // fail safe
    if (gate.key) state.sent[gate.key] = true;
    writeState(state);
    process.exit(0);
  }

  if (links.length === 0) {
    console.warn("Zero links after fetch; sending Not updated (baseline unchanged).");
    await sendEmail("Not updated");
    if (gate.key) state.sent[gate.key] = true;
    writeState(state);
    process.exit(0);
  }

  const seen = new Set(state.seen || []);
  const newOnes = links.filter(u => !seen.has(u));
  console.log(`Baseline size: ${state.seen.length}. New links this run: ${newOnes.length}.`);

  const verdict = newOnes.length > 0 ? "Updated" : "Not updated";
  await sendEmail(verdict);

  if (newOnes.length > 0) {
    state.seen = Array.from(new Set([...(state.seen || []), ...links])).slice(-1000);
  }
  if (gate.key) state.sent[gate.key] = true;
  state.init = true;
  writeState(state);
})();

