#!/usr/bin/env node
/** stdio entry: `node dist/index.js` (or the `jushuitan-mcp` bin). */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

const server = createServer();
await server.connect(new StdioServerTransport());
