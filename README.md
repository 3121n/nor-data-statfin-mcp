# @nor-data/statfin-mcp

MCP server for official statistics from **Statistics Finland (Tilastokeskus)** — the
**StatFin** database, exposed through the PxWeb API. Search 3000+ tables, inspect
their dimensions, and pull data as JSON-stat2. **No API key required.**

Part of the [`nor-data`](https://github.com/3121n) family of Nordic open-data MCP
servers. Built on the same pattern as the SSB (Norway) server — StatFin and SSB both
speak PxWeb, so the tools mirror each other.

## Tools

| Tool | What it does |
|------|--------------|
| `sok_tabell` | Keyword search across all StatFin tables. PxWeb has no server-side search, so this matches a **bundled index** (built from the full table tree) locally and returns the most relevant tables with their `tabell_id`. |
| `hent_tabell` | Metadata for a table: title + dimensions (variables) with their valid value codes and labels. Read this first to learn which filter codes exist. |
| `hent_data` | Fetch actual values as JSON-stat2, filtered by a flat `{variabelkode: [verdier]}` map. Supports special selections like `{filter:'top', values:['1']}` for the latest period. |
| `list_emner` | List the ~140 StatFin subject areas (e.g. `vaerak` = Population structure). Scope a search or browse when a keyword misses. |

All tools accept an optional `lang` (`en` default, `fi`, `sv`). Variable **codes**
are language-independent; only titles/labels are localised.

## Example agent flow

1. `sok_tabell({ query: "population by region" })`
   → `tabell_id: "vaerak/statfin_vaerak_pxt_11ra.px"`
2. `hent_tabell({ tabell_id })` → sees variables `Alue` (area), `Vuosi` (year), `Tiedot` (info)
3. `hent_data({ tabell_id, filtre: { Alue: ["SSS"], Vuosi: { filter: "top", values: ["1"] } } })`
   → latest national figures as JSON-stat2

## Install

```jsonc
// Claude Desktop / Claude Code MCP config
{
  "mcpServers": {
    "statfin": {
      "command": "npx",
      "args": ["-y", "@nor-data/statfin-mcp"]
    }
  }
}
```

## Develop

```bash
npm install
npm run build-index   # crawl the StatFin tree → data/tables-index.json (~1–2 min)
npm run dev           # run from source via tsx
npm run build         # compile to dist/
```

The search index is bundled in the package (`data/tables-index.json`). Re-run
`npm run build-index` to refresh it (nightly is plenty — StatFin updates tables,
not the tree, frequently).

### Notes & limits

- PxWeb allows **30 calls / 10 s** and rejects queries over **~100 000 cells**
  (HTTP 403) — keep `hent_data` selections small (few regions × few years).
- A few subjects (`vtp`, `kivih`, `sekn`, `akay`) return HTTP 400 server-side and
  are skipped during indexing; this is a StatFin quirk, not a bug here. The index
  records them under `skipped`.
- Data licensed under CC BY 4.0 by Statistics Finland.

## License

MIT
