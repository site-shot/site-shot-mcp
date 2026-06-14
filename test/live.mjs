import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const key = process.env.SITESHOT_API_KEY;
if (!key) throw new Error("set SITESHOT_API_KEY");
const target = process.argv[2] || "https://example.com";

const transport = new StdioClientTransport({
  command: "node",
  args: ["src/index.js"],
  env: { ...process.env, SITESHOT_API_KEY: key },
});
const client = new Client({ name: "live-test", version: "1.0.0" });
await client.connect(transport);
console.log("calling capture_screenshot on", target, "...");
const res = await client.callTool({
  name: "capture_screenshot",
  arguments: { url: target, width: 1280 },
});
if (res.isError) {
  console.error("ERROR:", JSON.stringify(res.content));
  await client.close();
  process.exit(1);
}
const img = res.content.find((c) => c.type === "image");
assert.ok(img, "expected image content");
const bytes = Buffer.from(img.data, "base64");
const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
const out = "/tmp/site-shot-mcp-live.png";
writeFileSync(out, bytes);
console.log(`ok — ${img.mimeType}, ${bytes.length} bytes, validPNG=${isPng} -> ${out}`);
await client.close();
