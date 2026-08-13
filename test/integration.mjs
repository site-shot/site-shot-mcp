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

// The package forwards width/height/wait_ms only when the caller passes them, so the value
// that applies otherwise belongs to the API and rots on its release cycle, not ours. Naming a
// number here ships to agents as fact — which is how "default 1280" outlived being true. This
// asserts on the served schema rather than the source, because the served schema is what agents
// actually read.
for (const p of ["width", "height", "wait_ms"]) {
  assert.doesNotMatch(
    cap.inputSchema.properties[p].description,
    /[0-9]/,
    `${p} description must not restate a default the package never sends`,
  );
}

await client.close();
console.log(`ok — MCP handshake + tools/list works. Tools: ${names.join(", ")}`);
