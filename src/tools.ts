import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const API_ROOT = "https://pxdata.stat.fi/PXWeb/api/v1";
const LANGS = ["en", "fi", "sv"] as const;

// --- Bundled search index (built by scripts/build-index.mjs) ---------------
type IndexTable = {
  id: string; // path under /StatFin, e.g. "vaerak/statfin_vaerak_pxt_11ra.px"
  table: string;
  emne: string;
  emneTekst: string;
  tittel: string;
  updated?: string;
};
type IndexFile = {
  generated: string;
  source: string;
  lang: string;
  subjectCount: number;
  tableCount: number;
  subjects: Array<{ id: string; text: string }>;
  tables: IndexTable[];
};

// data/ sits one level above both src/ (dev via tsx) and dist/ (built), so the
// same relative resolve works in either case.
const INDEX_URL = new URL("../data/tables-index.json", import.meta.url);
let INDEX: IndexFile;
try {
  INDEX = JSON.parse(readFileSync(fileURLToPath(INDEX_URL), "utf8")) as IndexFile;
} catch (e) {
  throw new Error(
    `statfin-mcp: could not load bundled index at ${INDEX_URL}. ` +
      `Run \`npm run build-index\` first. (${(e as Error).message})`,
  );
}

// --- Local fuzzy search over table titles ----------------------------------
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function scoreTable(queryTokens: string[], t: IndexTable): number {
  const hayTitle = t.tittel.toLowerCase();
  const haySubject = t.emneTekst.toLowerCase();
  let score = 0;
  for (const q of queryTokens) {
    if (hayTitle.includes(q)) score += 3;
    else if (haySubject.includes(q)) score += 1;
    // token-prefix bonus catches "popul" → "population"
    else if (tokenize(t.tittel).some((w) => w.startsWith(q))) score += 2;
  }
  return score;
}

// --- HTTP helpers ----------------------------------------------------------
async function pxGet(lang: string, tablePath: string): Promise<unknown> {
  const url = `${API_ROOT}/${lang}/StatFin/${tablePath}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`StatFin ${res.status} ${res.statusText} for ${tablePath}${body ? ": " + body.slice(0, 200) : ""}`);
  }
  return res.json();
}

async function pxPost(lang: string, tablePath: string, body: unknown): Promise<unknown> {
  const url = `${API_ROOT}/${lang}/StatFin/${tablePath}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 403 = over the 100k-cell limit; 429 = rate limited. Surface a hint.
    const hint =
      res.status === 403
        ? " (over the ~100 000-cell limit — narrow the filter, e.g. fewer regions or years)"
        : res.status === 429
          ? " (rate limited — max 30 calls / 10s)"
          : "";
    throw new Error(`StatFin ${res.status} ${res.statusText} for ${tablePath}${hint}${text ? ": " + text.slice(0, 300) : ""}`);
  }
  return res.json();
}

// Normalise a user-supplied table id to the path under /StatFin. Accepts the
// full index id ("vaerak/statfin_vaerak_pxt_11ra.px"), a bare .px filename
// (resolved via the index), or a code prefix like "11ra".
function resolveTablePath(input: string): string {
  const raw = input.trim();
  if (raw.includes("/") && raw.endsWith(".px")) return raw; // already a full path
  const hit =
    INDEX.tables.find((t) => t.table === raw) ||
    INDEX.tables.find((t) => t.table === `${raw}.px`) ||
    INDEX.tables.find((t) => t.table.toLowerCase().includes(raw.toLowerCase() + "_") || t.tittel.toLowerCase().startsWith(raw.toLowerCase() + " "));
  if (hit) return hit.id;
  throw new Error(
    `Unknown table '${input}'. Use sok_tabell to find a tabell_id (e.g. "vaerak/statfin_vaerak_pxt_11ra.px").`,
  );
}

const langSchema = z
  .enum(LANGS)
  .optional()
  .describe("Language for titles/labels: 'en' (default), 'fi' or 'sv'. Table codes are language-independent.");

/**
 * Registers all StatFin MCP tools on the given server.
 *
 * `onToolCall` is invoked (and awaited) at the start of every tool call before
 * any network request — lets an Apify standby wrapper charge a pay-per-event
 * fee. The stdio entrypoint passes no callback, so it is a no-op.
 */
export function registerTools(s: McpServer, onToolCall?: (toolName: string) => void | Promise<void>): void {
  const charge = async (toolName: string) => {
    if (onToolCall) await onToolCall(toolName);
  };

  s.tool(
    "sok_tabell",
    "Search the Statistics Finland (Tilastokeskus) StatFin database for statistical tables by keyword. " +
      "PxWeb has no server-side search, so this matches a bundled index of all StatFin tables locally and returns the most relevant ones with their tabell_id (use it in hent_tabell / hent_data). Search English titles.",
    {
      query: z.string().min(1).describe("Search term, e.g. 'population', 'unemployment', 'consumer price index', 'building'"),
      emne: z.string().optional().describe("Optional: restrict to a subject id (from list_emner), e.g. 'vaerak'"),
      limit: z.number().int().min(1).max(50).optional().describe("Max hits (default 10)"),
    },
    async ({ query, emne, limit = 10 }) => {
      await charge("sok_tabell");
      const qTokens = tokenize(query);
      let pool = INDEX.tables;
      if (emne) pool = pool.filter((t) => t.emne === emne);
      const scored = pool
        .map((t) => ({ t, score: scoreTable(qTokens, t) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || (b.t.updated ?? "").localeCompare(a.t.updated ?? ""))
        .slice(0, limit)
        .map((x) => ({
          tabell_id: x.t.id,
          tittel: x.t.tittel,
          emne: x.t.emne,
          emne_tekst: x.t.emneTekst,
          oppdatert: x.t.updated,
          score: x.score,
        }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { totalt_indeksert: INDEX.tableCount, treff: scored.length, indeks_bygd: INDEX.generated, tabeller: scored },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  s.tool(
    "hent_tabell",
    "Get metadata for a StatFin table: title, dimensions (variables) and their valid value codes + labels. " +
      "Use this before hent_data to learn which filter codes are available. Variable codes (e.g. 'Alue', 'Vuosi') are language-independent; pass them verbatim to hent_data.",
    {
      tabell_id: z.string().min(1).describe("Table id from sok_tabell, e.g. 'vaerak/statfin_vaerak_pxt_11ra.px'"),
      lang: langSchema,
    },
    async ({ tabell_id, lang = "en" }) => {
      await charge("hent_tabell");
      const path = resolveTablePath(tabell_id);
      const data = (await pxGet(lang, path)) as {
        title?: string;
        variables?: Array<{
          code?: string;
          text?: string;
          values?: string[];
          valueTexts?: string[];
          elimination?: boolean;
          time?: boolean;
        }>;
      };
      const variabler = (data.variables ?? []).map((v) => {
        const n = v.values?.length ?? 0;
        // Value lists can be huge (e.g. all municipalities) — sample to keep the
        // response readable; the agent can still pass any code it knows exists.
        const sample = (arr?: string[]) => (arr && arr.length > 30 ? [...arr.slice(0, 30), `…(+${arr.length - 30} flere)`] : arr);
        return {
          code: v.code,
          text: v.text,
          erTid: v.time || undefined,
          kanUtelates: v.elimination || undefined,
          antallVerdier: n,
          verdier: sample(v.values),
          verdiTekster: sample(v.valueTexts),
        };
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                tabell_id: path,
                tittel: data.title,
                dimensjoner: variabler,
                hint: "Send filtre til hent_data som {code: [verdier]} eller {code: {filter:'top', values:['N']}} for de N nyeste.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  s.tool(
    "hent_data",
    "Fetch actual data values from a StatFin table as JSON-stat2. `filtre` is a flat object mapping each variable code (from hent_tabell) to a list of selected value codes, e.g. {Alue: ['SSS'], Vuosi: ['2024']}. " +
      "Omit filtre for the table's default selection. Special selections: {filter:'top', values:['1']} for the latest value(s), {filter:'agg:...'} for groupings. Keep selections small — the API rejects queries over ~100 000 cells.",
    {
      tabell_id: z.string().min(1).describe("Table id from sok_tabell, e.g. 'vaerak/statfin_vaerak_pxt_11ra.px'"),
      filtre: z
        .record(
          z.union([
            z.array(z.string()),
            z.object({ filter: z.string(), values: z.array(z.string()) }),
          ]),
        )
        .optional()
        .describe("variabelkode → verdiliste, eller variabelkode → {filter, values} for spesialfiltre som 'top'"),
      lang: langSchema,
    },
    async ({ tabell_id, filtre, lang = "en" }) => {
      await charge("hent_data");
      const path = resolveTablePath(tabell_id);
      const query = filtre
        ? Object.entries(filtre).map(([code, sel]) => ({
            code,
            selection: Array.isArray(sel)
              ? { filter: "item", values: sel }
              : { filter: sel.filter, values: sel.values },
          }))
        : [];
      const body = { query, response: { format: "json-stat2" } };
      const data = await pxPost(lang, path, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    },
  );

  s.tool(
    "list_emner",
    "List the StatFin subject areas (~140 databases, e.g. 'vaerak' = Population structure). Use a subject id to scope sok_tabell, or to browse when a keyword search misses.",
    {
      query: z.string().optional().describe("Optional keyword to filter subject titles, e.g. 'population', 'price', 'transport'"),
    },
    async ({ query }) => {
      await charge("list_emner");
      const counts = new Map<string, number>();
      for (const t of INDEX.tables) counts.set(t.emne, (counts.get(t.emne) ?? 0) + 1);
      let subs = INDEX.subjects;
      if (query) {
        const q = query.toLowerCase();
        subs = subs.filter((sj) => sj.text.toLowerCase().includes(q) || sj.id.toLowerCase().includes(q));
      }
      const emner = subs
        .map((sj) => ({ emne: sj.id, tittel: sj.text, antallTabeller: counts.get(sj.id) ?? 0 }))
        .sort((a, b) => a.tittel.localeCompare(b.tittel));
      return {
        content: [{ type: "text", text: JSON.stringify({ antall: emner.length, emner }, null, 2) }],
      };
    },
  );
}
