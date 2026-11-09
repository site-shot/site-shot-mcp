// Regenerates the Cursor plugin's derived files from their single sources, so a release that
// bumps package.json or edits the shared skill cannot leave the Cursor copy behind:
//   - plugins/site-shot-cursor/skills/website-screenshots/SKILL.md and LICENSE: byte copies of the
//     Claude/Codex plugin's skill and the repo LICENSE. Cursor needs its own directory because
//     plugins/site-shot/.mcp.json carries Claude Code's ${user_config.SITESHOT_API_KEY}, which
//     Cursor would pass to the server literally;
//   - "version" in plugins/site-shot-cursor/.cursor-plugin/plugin.json and in
//     .cursor-plugin/marketplace.json (top level and metadata), and the pinned
//     site-shot-mcp@<version> in plugins/site-shot-cursor/.mcp.json.
// test/plugin-metadata.test.mjs fails if these drift, and names this script as the fix.
//
//   npm run sync:cursor
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cursor = join(root, "plugins", "site-shot-cursor");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const skill = join(cursor, "skills", "website-screenshots", "SKILL.md");
mkdirSync(dirname(skill), { recursive: true });
copyFileSync(join(root, "plugins", "site-shot", "skills", "website-screenshots", "SKILL.md"), skill);
copyFileSync(join(root, "LICENSE"), join(cursor, "LICENSE"));

const pluginPath = join(cursor, ".cursor-plugin", "plugin.json");
const plugin = readJson(pluginPath);
plugin.version = version;
writeJson(pluginPath, plugin);

const marketplacePath = join(root, ".cursor-plugin", "marketplace.json");
const marketplace = readJson(marketplacePath);
marketplace.version = version;
marketplace.metadata.version = version;
writeJson(marketplacePath, marketplace);

const mcpPath = join(cursor, ".mcp.json");
const mcp = readJson(mcpPath);
mcp.mcpServers["site-shot"].args = ["-y", `site-shot-mcp@${version}`];
writeJson(mcpPath, mcp);

console.log(`Cursor plugin synced to site-shot-mcp@${version}`);
