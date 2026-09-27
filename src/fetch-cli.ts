#!/usr/bin/env node
/** CLI: `npm run fetch` — pull the full docs snapshot from the official site. */

import { fetchAllDocs } from "./fetcher.js";
import { dataWritePath, saveDocs } from "./store.js";

const file = dataWritePath();
console.error(`[jushuitan-mcp] fetching docs snapshot -> ${file}`);
try {
  const data = await fetchAllDocs((m) => console.error(`[jushuitan-mcp] ${m}`));
  saveDocs(data, file);
  const total = data.categories.reduce((s, c) => s + c.apis.length, 0);
  console.log(`OK: ${data.categories.length} categories, ${total} apis -> ${file}`);
} catch (e) {
  console.error(`[jushuitan-mcp] fetch failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
