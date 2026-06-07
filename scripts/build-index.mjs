#!/usr/bin/env node
// Crawls the Statistics Finland PxWeb v1 tree and writes data/tables-index.json.
// PxWeb v1 has no server-side full-text search, so we pre-build an index at build
// time and bundle it (same pattern as the Lovdata MCP). Re-run nightly to refresh.
//
//   node scripts/build-index.mjs
//
// Rate limit: PxWeb allows 30 calls / 10s. We stay well under with a fixed delay
// and retry on 429/5xx.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LANG = process.env.STATFIN_LANG || "en";
const BASE = `https://pxdata.stat.fi/PXWeb/api/v1/${LANG}/StatFin`;
const DELAY_MS = 500; // 2 req/s, comfortably under the 30/10s limit
const MAX_RETRIES = 8; // generous: transient 429s must never cause data loss

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "data", "tables-index.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let calls = 0;
async function getJson(path) {
  const url = `${BASE}${path}`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await sleep(DELAY_MS);
    let res;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (e) {
      if (attempt === MAX_RETRIES) throw e;
      await sleep(1000 * (attempt + 1));
      continue;
    }
    calls++;
    if (res.ok) return res.json();
    // 429 (rate limit) and 5xx are transient — back off and retry hard so we
    // never lose a real subject. Other 4xx (e.g. vtp's persistent 400) are
    // genuine and thrown immediately for the per-folder skip.
    if (res.status === 429 || res.status >= 500) {
      const backoff = 2000 * (attempt + 1);
      process.stderr.write(`  ${res.status} on ${path} — backoff ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})\n`);
      await sleep(backoff);
      continue;
    }
    throw new Error(`PxWeb ${res.status} ${res.statusText} for ${path}`);
  }
  throw new Error(`PxWeb: exhausted retries for ${path}`);
}

const tables = [];
const subjects = [];
const skipped = [];

// Recurse into a folder. `relPath` is the path under /StatFin (no leading slash),
// "" for the root. `subjectId`/`subjectText` carry the top-level subject down.
// A single bad folder (some StatFin subjects 400 server-side, e.g. 'vtp') must
// not abort the whole crawl, so per-folder errors are caught and skipped.
async function walk(relPath, subjectId, subjectText) {
  let entries;
  try {
    entries = await getJson(relPath ? `/${relPath}` : "/");
  } catch (e) {
    if (!relPath) throw e; // root failure is fatal
    skipped.push({ path: relPath, subject: subjectId, error: String(e.message || e) });
    process.stderr.write(`  ! skipped /${relPath}: ${e.message || e}\n`);
    return;
  }
  for (const e of entries) {
    if (e.type === "l") {
      const childRel = relPath ? `${relPath}/${e.id}` : e.id;
      if (!relPath) {
        // top-level subject
        subjects.push({ id: e.id, text: e.text });
        process.stderr.write(`[${subjects.length}] ${e.id} — ${e.text}\n`);
        await walk(childRel, e.id, e.text);
      } else {
        await walk(childRel, subjectId, subjectText);
      }
    } else if (e.type === "t") {
      const id = relPath ? `${relPath}/${e.id}` : e.id;
      tables.push({
        id, // path under /StatFin, e.g. "vaerak/statfin_vaerak_pxt_11ra.px"
        table: e.id,
        emne: subjectId,
        emneTekst: subjectText,
        tittel: e.text,
        updated: e.updated,
      });
    }
  }
}

const startedIso = process.env.BUILD_ISO || new Date().toISOString();
process.stderr.write(`Crawling ${BASE} ...\n`);
await walk("", null, null);

mkdirSync(dirname(OUT), { recursive: true });
const payload = {
  generated: startedIso,
  source: BASE,
  lang: LANG,
  subjectCount: subjects.length,
  tableCount: tables.length,
  skipped,
  subjects,
  tables,
};
writeFileSync(OUT, JSON.stringify(payload), "utf8");
process.stderr.write(
  `\nDone: ${subjects.length} subjects, ${tables.length} tables, ${skipped.length} skipped, ${calls} API calls → ${OUT}\n`,
);
