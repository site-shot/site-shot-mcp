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

// `country` is where an agent decides to geotarget, so it is where the free plan's location
// bound has to be stated: on a free-plan key every other country is refused with an error
// instead of an image, and the refused request still counts toward the month. No status code is
// named: the API answers that refusal as a JSON-mode 200 with an error body, a 403 in image mode,
// and a known server bug can turn the 403 into an empty 404, so "403" here would be read as fact
// and be wrong for some callers. Both tools share the schema; check both.
for (const t of tools) {
  const country = t.inputSchema.properties.country.description;
  assert.match(
    country,
    /\bfree plan\b[^.]*\bdefault location\b[^.]*"US"[^.]*\bother countries need a paid plan\b/,
    `${t.name}: country states the free plan's location bound`,
  );
  assert.match(country, /\bstill counts\b/, `${t.name}: country says a refused request still counts`);
  assert.doesNotMatch(country, /\b(?:403|404|HTTP\s*\d{3})\b/i, `${t.name}: country names no status code for the refusal`);
  assert.doesNotMatch(country, /\btrial\b/i, `${t.name}: the free plan is not called a trial`);
}

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
