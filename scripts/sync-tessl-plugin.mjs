// Regenerates the Tessl plugin's derived files from their single sources, so a release that bumps
// package.json or edits the shared skill cannot leave the Tessl copy behind:
//   - skills/website-screenshots/SKILL.md and LICENSE: byte copies of the Claude/Codex plugin's
//     skill and the repo LICENSE (Tessl packages a directory, so the skill cannot be shared by path);
//   - .tessl-plugin/plugin.json "version" and the pinned site-shot-mcp@<version> in .mcp.json.
// test/plugin-metadata.test.mjs fails if these drift, and names this script as the fix.
//
//   npm run sync:tessl
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tessl = join(root, "plugins", "site-shot-tessl");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const skill = join(tessl, "skills", "website-screenshots", "SKILL.md");
mkdirSync(dirname(skill), { recursive: true });
copyFileSync(join(root, "plugins", "site-shot", "skills", "website-screenshots", "SKILL.md"), skill);
copyFileSync(join(root, "LICENSE"), join(tessl, "LICENSE"));

const manifestPath = join(tessl, ".tessl-plugin", "plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const mcpPath = join(tessl, ".mcp.json");
const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
mcp.mcpServers["site-shot"].args = ["-y", `site-shot-mcp@${version}`];
writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);

console.log(`Tessl plugin synced to site-shot-mcp@${version}`);
