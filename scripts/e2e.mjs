#!/usr/bin/env node
// True end-to-end test: spins up the MCP server in-memory, connects a real MCP
// client, and exercises all four tools against the live StatFin API.
//
//   npm run build && node scripts/e2e.mjs
//
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../dist/tools.js";

const server = new McpServer({ name: "statfin-e2e", version: "0.0.0" });
registerTools(server);

const [clientT, serverT] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "e2e", version: "0.0.0" });
await Promise.all([server.connect(serverT), client.connect(clientT)]);

let failures = 0;
const parse = (r) => JSON.parse(r.content[0].text);
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// 0. tools advertised
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check("4 tools listed", names.length === 4, names.join(", "));

// 1. list_emner
const emner = parse(await client.callTool({ name: "list_emner", arguments: { query: "population" } }));
check("list_emner finds a population subject", emner.emner.some((e) => /population/i.test(e.tittel)), `${emner.antall} treff`);

// 2. sok_tabell
const sok = parse(await client.callTool({ name: "sok_tabell", arguments: { query: "population by region", limit: 5 } }));
const first = sok.tabeller[0];
check("sok_tabell returns hits with tabell_id", first && first.tabell_id?.endsWith(".px"), first?.tabell_id);
check("sok_tabell index is non-trivial", sok.totalt_indeksert > 1000, `${sok.totalt_indeksert} tables indexed`);

// 3. hent_tabell on the top hit
const meta = parse(await client.callTool({ name: "hent_tabell", arguments: { tabell_id: first.tabell_id } }));
const codes = (meta.dimensjoner ?? []).map((d) => d.code);
check("hent_tabell returns dimensions with codes", codes.length > 0, `dims: ${codes.join(", ")}`);
const timeVar = meta.dimensjoner.find((d) => d.erTid) ?? meta.dimensjoner.find((d) => /vuosi|year|tid/i.test(d.code));

// 4. hent_data — latest value on the time dimension
const filtre = {};
if (timeVar) filtre[timeVar.code] = { filter: "top", values: ["1"] };
const data = parse(await client.callTool({ name: "hent_data", arguments: { tabell_id: first.tabell_id, filtre } }));
check("hent_data returns json-stat2 dataset", data.class === "dataset" && data.value, `label: ${(data.label ?? "").slice(0, 50)}`);
check("hent_data has values", Array.isArray(data.value) ? data.value.length > 0 : Object.keys(data.value || {}).length > 0);

// 5. lang param works (Finnish)
const metaFi = parse(await client.callTool({ name: "hent_tabell", arguments: { tabell_id: first.tabell_id, lang: "fi" } }));
check("lang=fi returns a (Finnish) title", typeof metaFi.tittel === "string" && metaFi.tittel.length > 0, metaFi.tittel);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await client.close();
await server.close();
process.exit(failures === 0 ? 0 : 1);
