#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main() {
  if (!process.env.SITESHOT_API_KEY) {
    // Warn but don't exit — tool calls return a clear error, and MCP clients may
    // start the server before the user has finished configuring the key.
    process.stderr.write(
      "[site-shot-mcp] Warning: SITESHOT_API_KEY is not set. " +
        "Get a key at https://www.site-shot.com/pricing/ and add it to the server's env.\n",
    );
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[site-shot-mcp] Site-Shot MCP server running on stdio.\n");
}

main().catch((err) => {
  process.stderr.write(`[site-shot-mcp] Fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
