import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["src/index.js"],
  env: { ...process.env, SITESHOT_API_KEY: "DUMMY_KEY_FOR_HANDSHAKE" },
});
const client = new Client({ name: "integration-test", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
assert.deepEqual(names, ["capture_full_page", "capture_screenshot"], "both tools exposed");

// Confirm input schema advertises the url field
const cap = tools.find((t) => t.name === "capture_screenshot");
assert.ok(cap.inputSchema?.properties?.url, "capture_screenshot advertises a url param");
assert.ok(cap.inputSchema?.properties?.full_page, "capture_screenshot advertises full_page");
assert.ok(cap.inputSchema?.properties?.strict_country, "capture_screenshot advertises strict_country");
assert.match(
  cap.inputSchema.properties.country.description,
  /ISO 3166-1 alpha-2/,
  "country param must document ISO codes, not full country names",
);

await client.close();
console.log(`ok — MCP handshake + tools/list works. Tools: ${names.join(", ")}`);
