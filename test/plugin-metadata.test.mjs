// Metadata tests for the Claude Code plugin packaging.
//
// Nothing here talks to the Site-Shot API. These tests guard the packaging
// claims instead: that the marketplace entry resolves to a real directory, that
// the MCP command stays pinned to the released npm package, that the API key is
// a placeholder rather than a baked-in secret, that the plugin ships only the
// files it is supposed to ship, that the skill names tools the server actually
// serves, and that the README's copy-paste commands match the manifests they
// document. Each of these has a silent-wrong failure mode: a plugin that
// installs and looks fine while pointing at the wrong package, leaking a key, or
// telling an agent to call a tool that does not exist.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (...p) => readFileSync(join(repoRoot, ...p), "utf8");
const readJson = (...p) => JSON.parse(read(...p));

const pkg = readJson("package.json");
const marketplace = readJson(".claude-plugin", "marketplace.json");
const entry = marketplace.plugins?.[0];
const pluginDir = String(entry?.source ?? "").replace(/^\.\//, "");
const plugin = readJson(pluginDir, ".claude-plugin", "plugin.json");
const mcp = readJson(pluginDir, ".mcp.json");
const readme = read("README.md");

// Codex installs the same plugin directory through its own marketplace and its own
// manifest. The two hosts share everything except credential wiring: Claude Code
// substitutes ${user_config.*}, Codex forwards a named variable from the session.
const codexMarketplace = readJson(".agents", "plugins", "marketplace.json");
const codexEntry = codexMarketplace.plugins?.[0];
const codexPlugin = readJson(pluginDir, ".codex-plugin", "plugin.json");

/** Every file under dir, as repo-relative POSIX paths. */
function filesUnder(dir) {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      const child = join(abs, name);
      if (statSync(child).isDirectory()) walk(child);
      else out.push(relative(repoRoot, child).split(sep).join("/"));
    }
  };
  walk(join(repoRoot, dir));
  return out.sort();
}

/** The README text under a `## ` heading, up to the next `## ` heading. */
function section(heading) {
  const start = readme.indexOf(heading);
  assert.ok(start > -1, `README has a "${heading}" section`);
  const next = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, next === -1 ? undefined : next);
}

/** The tools and params the server actually serves, read over a real MCP session. */
async function servedTools() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ apiKey: "TEST_KEY_NOT_USED", fetchImpl: async () => {
    throw new Error("metadata tests must never call the API");
  } });
  const client = new Client({ name: "plugin-metadata-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

/** What the server states about itself in the handshake, read over a real MCP session. */
async function servedIdentity() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ apiKey: "TEST_KEY_NOT_USED", fetchImpl: async () => {
    throw new Error("metadata tests must never call the API");
  } });
  const client = new Client({ name: "plugin-metadata-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const identity = client.getServerVersion();
  await client.close();
  return identity;
}

test("marketplace entry resolves to the plugin directory it names", () => {
  assert.equal(marketplace.name, "site-shot", "marketplace keeps the brand name");
  assert.match(marketplace.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case marketplace name");
  assert.ok(marketplace.owner?.name, "marketplace declares an owner");
  assert.equal(marketplace.plugins.length, 1, "exactly one plugin is offered");

  assert.equal(entry.source, "./plugins/site-shot", "relative-path source, not a remote fetch");
  assert.ok(entry.source.startsWith("./"), "relative sources must start with ./");
  assert.ok(statSync(join(repoRoot, pluginDir)).isDirectory(), `${pluginDir} exists`);

  // The install id users type is `<entry.name>@<marketplace.name>`. If the entry name
  // and the manifest name drift apart, that id silently stops resolving.
  assert.equal(entry.name, plugin.name, "marketplace entry name matches plugin.json name");
  assert.equal(pluginDir.split("/").pop(), plugin.name, "directory name matches plugin name");
});

test("metadata is real and attributable, with no invented endorsements", () => {
  for (const url of [plugin.homepage, plugin.repository, marketplace.plugins[0].homepage]) {
    if (url) assert.match(url, /^https:\/\//, `${url} must be https`);
  }
  assert.equal(plugin.repository, pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""));
  assert.equal(plugin.license, pkg.license);
  assert.ok(plugin.author?.name, "plugin names its author");

  const text = JSON.stringify(marketplace) + JSON.stringify(plugin);
  assert.doesNotMatch(
    text,
    /\b(official(ly)? (approved|endorsed|verified)|anthropic[- ]approved|openai[- ]approved|certified|verified partner)\b/i,
    "no vendor approval or badge we have not been granted",
  );
});

/**
 * Both hosts launch the same released package over stdio; only the credential wiring
 * differs. Asserted once so the two descriptors cannot drift apart unnoticed.
 */
function assertPinnedRelease(descriptor, label) {
  const servers = descriptor.mcpServers;
  assert.ok(servers, `${label}: uses the documented mcpServers wrapper`);
  assert.deepEqual(Object.keys(servers), ["site-shot"], `${label}: one server, named for the brand`);

  const server = servers["site-shot"];
  assert.equal(server.command, "npx", `${label}: launched through npx`);
  assert.deepEqual(server.args, ["-y", `site-shot-mcp@${pkg.version}`], `${label}: pinned to this repo's version`);

  // A floating tag would let a future npm release change what installed users run,
  // with no commit here to review it.
  assert.match(server.args.at(-1), /^site-shot-mcp@\d+\.\d+\.\d+$/, `${label}: exact version, never @latest or a range`);

  // stdio is the only transport this package speaks; a url here would mean a remote
  // server that does not exist yet.
  assert.equal(server.url, undefined, `${label}: no remote URL — the public HTTPS server is not built`);
  assert.equal(server.headers, undefined, `${label}: no HTTP headers, stdio server`);
  return server;
}

test("the MCP command stays pinned to the released npm package", () => {
  assertPinnedRelease(mcp, "claude");
});

test("the Codex marketplace installs the same plugin directory", () => {
  assert.equal(codexMarketplace.name, marketplace.name, "one brand name across both hosts");
  assert.equal(codexMarketplace.plugins.length, 1, "exactly one plugin is offered");

  // Codex's own contract: an explicit local source object plus install/auth policy —
  // not Claude's bare string. A compatibility default would work until it stopped.
  assert.deepEqual(
    codexEntry.source,
    { source: "local", path: "./plugins/site-shot" },
    "native local source object, not a Claude-shaped string",
  );
  assert.deepEqual(
    codexEntry.policy,
    { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    "install and auth policy stated explicitly",
  );
  assert.equal(codexEntry.category, "Developer Tools");

  // Same directory as Claude's entry — compared after resolving each host's own shape,
  // since the two manifests are not byte-identical and are not meant to be.
  const dirOf = (s) => String(typeof s === "string" ? s : s.path).replace(/^\.\//, "");
  assert.equal(dirOf(codexEntry.source), dirOf(entry.source), "both hosts install the same directory, not a copy");
  assert.equal(dirOf(codexEntry.source), pluginDir);

  assert.equal(codexEntry.name, codexPlugin.name, "entry name matches the manifest it points at");
  assert.equal(codexPlugin.name, plugin.name, "the plugin has one name everywhere");
  assert.equal(codexPlugin.version, pkg.version, "version tracks the package it installs");
});

test("the Codex manifest inlines its server map and shares the skill", () => {
  // A `mcpServers` string path must resolve to `.mcp.json`, and that filename is already
  // Claude's user_config descriptor. Inlining the map keeps one launch path per host
  // without a second file competing for the same name.
  assert.equal(typeof codexPlugin.mcpServers, "object", "server map is inline, not a path");
  assert.ok(!Array.isArray(codexPlugin.mcpServers), "inline map is an object");
  assert.throws(
    () => statSync(join(repoRoot, pluginDir, ".codex-plugin", "mcp.json")),
    /ENOENT/,
    "no redundant nested descriptor left behind",
  );
  assert.deepEqual(
    readdirSync(join(repoRoot, pluginDir, ".codex-plugin")),
    ["plugin.json"],
    ".codex-plugin holds only plugin.json, as the native layout expects",
  );

  // One skill folder, shared. A second copy would drift from the tools it documents.
  assert.equal(codexPlugin.skills, "./skills/", "skills come from the shared folder");
  assert.ok(
    statSync(join(repoRoot, pluginDir, "skills", "website-screenshots", "SKILL.md")).isFile(),
    "the shared skill is where both manifests point",
  );

  const allowedKeys = new Set([
    "name", "version", "description", "author", "homepage", "repository",
    "license", "keywords", "skills", "mcpServers", "interface",
  ]);
  for (const key of Object.keys(codexPlugin)) {
    assert.ok(allowedKeys.has(key), `Codex manifest must not declare "${key}"`);
  }
  for (const key of ["hooks", "monitors", "scheduledTasks", "apps", "appTemplates"]) {
    assert.equal(codexPlugin[key], undefined, `no ${key} in the Codex manifest`);
  }
});

test("the Codex interface metadata is complete and claims nothing extra", () => {
  const ui = codexPlugin.interface;
  assert.ok(ui && typeof ui === "object" && !Array.isArray(ui), "interface is an object");

  for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
    assert.equal(typeof ui[field], "string", `interface.${field} is a string`);
    assert.ok(ui[field].trim().length > 0, `interface.${field} is non-empty`);
  }
  assert.equal(ui.category, codexEntry.category, "one category across manifest and marketplace entry");
  assert.equal(ui.developerName, codexPlugin.author.name, "publisher name matches the author block");

  assert.ok(
    Array.isArray(ui.capabilities) && ui.capabilities.every((c) => typeof c === "string" && c.trim()),
    "capabilities is an array of non-empty strings",
  );
  // The plugin returns images. It creates nothing on the user's machine, so claiming
  // a write capability would overstate what installing it lets an agent do.
  assert.ok(!ui.capabilities.includes("Write"), "no Write capability: this plugin writes nothing");

  // The spec keeps at most three starter prompts, each capped at 128 characters;
  // anything past that is silently dropped or truncated in the UI.
  assert.ok(Array.isArray(ui.defaultPrompt), "defaultPrompt is an array");
  assert.ok(ui.defaultPrompt.length > 0 && ui.defaultPrompt.length <= 3, "one to three starter prompts");
  for (const prompt of ui.defaultPrompt) {
    assert.ok(prompt.length <= 128, `starter prompt stays within 128 chars: "${prompt}"`);
  }

  const copy = JSON.stringify(ui);
  assert.doesNotMatch(copy, /\bdirector(?:y|ies)\b|\bcatalog\b/i, "no claim of a directory listing");
  assert.doesNotMatch(copy, /\bguarantee|\bfree (?:trial|tier|key|plan)\b/i, "no guarantee or free-tier claim");
  assert.doesNotMatch(copy, /\bsigns? you in\b|\bauthenticates?\b|\blogs? in\b/i, "no authentication claim");
});

test("the Codex descriptor forwards the key by name and never borrows Claude's wiring", () => {
  const server = assertPinnedRelease(codexPlugin, "codex");

  assert.deepEqual(server.env_vars, ["SITESHOT_API_KEY"], "forwarded by name from the session environment");
  assert.equal(server.env, undefined, "no literal env block — a value there would sit in the repo");

  // ${user_config.*} is Claude Code's substitution. Codex does not implement it, so it
  // would reach the server verbatim and be sent as the API key.
  assert.doesNotMatch(JSON.stringify(codexPlugin.mcpServers), /user_config/, "no Claude interpolation in the Codex descriptor");
  assert.equal(codexPlugin.userConfig, undefined, "no userConfig on the Codex manifest");

  // And the reverse: Claude Code has no env_vars concept, so the key would never arrive.
  assert.equal(mcp.mcpServers["site-shot"].env_vars, undefined, "env_vars stays Codex-only");
  assert.match(
    mcp.mcpServers["site-shot"].env.SITESHOT_API_KEY,
    /^\$\{user_config\./,
    "Claude keeps its own substitution",
  );
});

test("the plugin asks Claude Code for the key as required sensitive config", () => {
  const cfg = plugin.userConfig?.SITESHOT_API_KEY;
  assert.ok(cfg, "plugin.json declares userConfig.SITESHOT_API_KEY");
  assert.deepEqual(Object.keys(plugin.userConfig), ["SITESHOT_API_KEY"], "one value, nothing else asked for");

  assert.equal(cfg.type, "string");
  assert.equal(cfg.title, "Site-Shot API key");
  assert.equal(cfg.sensitive, true, "sensitive: the value is masked, not echoed back");
  assert.equal(cfg.required, true, "required: enabling without a key fails loudly");
  assert.match(cfg.description, /\bpaid\b/i, "the prompt states the API is paid before anyone types a key");
  assert.doesNotMatch(cfg.description, /\bfree (?:trial|tier|api key|key|plan)\b/i, "no free-API-trial claim");

  // Keys are managed in the dashboard. /start/ is the signup path and /pricing/ sells
  // plans; sending someone there to find an existing key is a dead end.
  assert.match(cfg.description, /https:\/\/www\.site-shot\.com\/dashboard\//, "key management link is the dashboard");
  assert.doesNotMatch(cfg.description, /site-shot\.com\/start\//, "not the signup path");

  // A default would be a key someone shipped, and a fallback would quietly capture
  // against the wrong account rather than stopping.
  assert.equal(cfg.default, undefined, "no default value");
  assert.equal(cfg.options, undefined, "not an enum");
});

test("the API key is forwarded as a placeholder, never embedded", () => {
  const server = mcp.mcpServers["site-shot"];
  assert.deepEqual(Object.keys(server.env), ["SITESHOT_API_KEY"], "only the documented secret");
  assert.equal(
    server.env.SITESHOT_API_KEY,
    "${user_config.SITESHOT_API_KEY}",
    "documented user_config substitution, so the key never has to be pasted into a config file",
  );

  // Belt and braces: scan every shipped plugin file for anything key-shaped that is
  // not an interpolation placeholder.
  for (const file of filesUnder(pluginDir)) {
    const body = read(file);
    for (const [, value] of body.matchAll(/SITESHOT_API_KEY["'\s:=]+([A-Za-z0-9_\-]{8,})/g)) {
      assert.fail(`${file} looks like it embeds a key: ${value.slice(0, 12)}…`);
    }
  }
});

test("the plugin ships only the files it declares — no hooks, no executables", () => {
  const shipped = filesUnder(pluginDir);
  assert.deepEqual(
    shipped,
    [
      `${pluginDir}/.claude-plugin/plugin.json`,
      `${pluginDir}/.codex-plugin/plugin.json`,
      `${pluginDir}/.mcp.json`,
      `${pluginDir}/skills/website-screenshots/SKILL.md`,
    ],
    "plugin contents are exactly one manifest and MCP config per host, plus one shared skill",
  );

  // Hooks, bin/ and monitors run code on the user's machine on Claude Code's schedule
  // rather than on an explicit tool call. This plugin is not approved to do that.
  const allowedKeys = new Set([
    "name", "displayName", "version", "description",
    "author", "homepage", "repository", "license", "keywords", "userConfig",
  ]);
  for (const key of Object.keys(plugin)) {
    assert.ok(allowedKeys.has(key), `plugin.json must not declare "${key}"`);
  }
  for (const key of ["hooks", "bin", "agents", "commands", "workflows", "channels", "experimental"]) {
    assert.equal(plugin[key], undefined, `no ${key} in plugin.json`);
  }
  assert.equal(plugin.name, "site-shot");
  assert.equal(plugin.version, pkg.version, "plugin version tracks the package it installs");

  // The mcpb bundle and the marketplace are different distribution channels; shipping
  // Claude Code manifests inside the Claude Desktop bundle just bloats it.
  const mcpbignore = read(".mcpbignore").split("\n").map((l) => l.trim());
  assert.ok(mcpbignore.includes("plugins"), ".mcpbignore excludes plugins/");
  assert.ok(mcpbignore.includes(".claude-plugin"), ".mcpbignore excludes .claude-plugin/");
  assert.ok(mcpbignore.includes(".agents"), ".mcpbignore excludes .agents/");

  // The npm whitelist is unchanged by plugin work: the package ships the server, the
  // marketplaces ship from git. Listing a plugin dir here would publish it twice.
  assert.deepEqual(pkg.files, ["src", "README.md", "CHANGELOG.md", "LICENSE"], "npm files whitelist unchanged");
});

test("the skill only names tools and params the server actually serves", async () => {
  const skillPath = `${pluginDir}/skills/website-screenshots/SKILL.md`;
  const skill = read(skillPath);

  const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  assert.ok(fm, "SKILL.md starts with YAML frontmatter");
  const name = /^name:\s*(.+)$/m.exec(fm[1])?.[1].trim();
  const description = /^description:\s*(.+)$/m.exec(fm[1])?.[1].trim();
  assert.equal(name, "website-screenshots", "frontmatter name matches the skill directory");
  assert.ok(description && description.length > 40, "skill carries a description that can trigger it");

  const tools = await servedTools();
  const toolNames = tools.map((t) => t.name).sort();
  assert.deepEqual(toolNames, ["capture_full_page", "capture_screenshot"], "the two real tools");
  const known = new Set(toolNames);
  for (const t of tools) for (const p of Object.keys(t.inputSchema?.properties ?? {})) known.add(p);

  // Any backticked snake_case token in the skill is an identifier an agent will try to
  // use. Tokens without an underscore (npx, png) are prose, not API surface.
  const cited = new Set();
  for (const [, token] of skill.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) cited.add(token);
  assert.ok(cited.size > 0, "the skill actually names the tools it tells agents to call");
  for (const token of cited) {
    assert.ok(known.has(token), `SKILL.md cites "${token}", which the server does not serve`);
  }
  for (const toolName of toolNames) {
    assert.ok(cited.has(toolName), `SKILL.md never mentions the ${toolName} tool`);
  }

  // Tool families this server has never had. An agent told to "save to the library"
  // burns a turn discovering there is no such tool.
  assert.doesNotMatch(
    skill,
    /\b(?:list|save|delete|search|schedule)_[a-z_]*(?:screenshot|capture|page)\w*\b|\b(?:screenshot|capture)_(?:library|history|schedule|markdown|list)\b/i,
    "no invented tool families (no saved library, list, markdown or schedule tools)",
  );
});

test("the skill states the paid requirement and claims nothing it cannot do", () => {
  const skill = read(`${pluginDir}/skills/website-screenshots/SKILL.md`);

  assert.match(skill, /SITESHOT_API_KEY/, "names the variable the user has to set");
  assert.match(skill, /\bpaid\b/i, "says the key is paid before the first call");
  assert.doesNotMatch(skill, /\bfree (?:trial|tier|api key|key|plan)\b/i, "no free-API-trial claim");

  // Point at the command the installer itself names, not at an enable-time prompt nobody
  // has observed. And the skill must not carry the direct-stdio tool-error behaviour over
  // to the plugin path — what Claude Code does with a required setting unset is untested.
  assert.ok(
    skill.includes(`/plugin configure ${entry.name}@${marketplace.name}`),
    "the skill points at the real configure command",
  );

  // One skill, two hosts. `/plugin configure` does not exist in Codex, so it has to be
  // attributed rather than offered to whoever is reading.
  const at = skill.indexOf("/plugin configure");
  assert.match(
    skill.slice(Math.max(0, at - 220), at + 60),
    /Claude Code/,
    "the configure command is attributed to Claude Code, not handed to every host",
  );
  assert.match(skill, /\bCodex\b/, "the other supported host is covered");
  assert.match(skill, /\benvironment\b/i, "says where the key comes from under Codex");
  assert.doesNotMatch(skill, /prompts? for it when you enable/i, "no unobserved enable-time prompt claim");
  assert.doesNotMatch(
    skill,
    /if it is not configured,? the tools return/i,
    "no categorical claim about the native-plugin path",
  );
  assert.match(skill, /\bstop\b/i, "tells the agent to stop on incomplete setup");
  assert.match(
    skill,
    /never[^.]*(?:ask|request)[^.]*key|do not[^.]*(?:ask|hunt)[^.]*key/i,
    "never seek the key in conversation or on disk",
  );

  // The capture runs on Site-Shot's own browser. Saying otherwise sends an agent to
  // this tool for pages only the user's signed-in browser can reach.
  assert.match(skill, /\b(?:signed-out|anonymous|not signed in)\b/i, "states the capture is signed out");
  assert.match(skill, /\b(?:signed-in|logged-in|authenticated)\b/i, "covers pages that need a session");
  assert.doesNotMatch(
    skill,
    /\b(?:uses?|reuses?|shares?|inherits?) (?:your|the user's) (?:browser|session|cookies|login)\b/i,
    "never claims the remote capture logs into the user's browser",
  );

  assert.doesNotMatch(skill, /\bguarantee/i, "no guaranteed SEO or growth outcome");
  assert.doesNotMatch(skill, /\balways (?:use|choose|prefer|call)\b/i, "no always-choose-our-tool rule");
  assert.doesNotMatch(skill, /\bautomatic(?:ally)? retr|\bretry (?:ladder|loop)\b/i, "no automated retries");
  assert.match(skill, /\bre-?captur/i, "addresses re-capturing explicitly");
});

test("the skill permits a requested comparison, not unsolicited repeats", () => {
  const skill = read(`${pluginDir}/skills/website-screenshots/SKILL.md`);

  // "One page means one capture" read as a hard cap, so a US-vs-DE or mobile-vs-desktop
  // comparison of one URL — the thing actually asked for — came back half-answered.
  assert.doesNotMatch(skill, /one page means one capture/i, "no blanket one-capture-per-URL rule");
  assert.match(skill, /\bcompar\w+/i, "comparisons are addressed at all");
  assert.match(skill, /\bminimum\b/i, "the comparison's captures are bounded by what it needs");
  assert.match(
    skill,
    /\bunsolicited\b|\bnobody asked\b|\bwere not asked for\b/i,
    "unrequested repeats are still refused",
  );
});

test("the skill does not hand geo work back to an already-open browser", () => {
  const skill = read(`${pluginDir}/skills/website-screenshots/SKILL.md`);
  const heading = "## Choosing between this and a browser";
  const start = skill.indexOf(heading);
  assert.ok(start > -1, `SKILL.md has a "${heading}" section`);
  const choosing = skill.slice(start);

  // An open browser renders from this machine's IP, locale and profile — the exact
  // variables a country capture exists to control. Preferring it for a geo request
  // answers a different question than the one asked.
  assert.match(choosing, /\b(?:country|geo)\w*/i, "the geo case is named where the tool choice is made");
  assert.match(choosing, /\bIP\b|\blocale\b/i, "says why an open browser cannot stand in for it");
  assert.match(choosing, /\bindependent\b|\bsigned-out\b/i, "covers the independent-render case too");
  assert.doesNotMatch(
    choosing,
    /browser is (?:already )?open[^.]*\bis the better tool\b|\bthat is the better tool\b(?![^.]*session)/i,
    "no unconditional preference for whatever browser happens to be open",
  );
});

test("README commands match the manifests they document", () => {
  const repoSlug = pkg.repository.url.replace(/^git\+https:\/\/github\.com\//, "").replace(/\.git$/, "");
  assert.equal(repoSlug, "site-shot/site-shot-mcp", "repo slug read from package.json");

  // Every id below is derived from the manifests, so renaming the marketplace or the
  // plugin fails here instead of leaving users a command that resolves to nothing.
  assert.ok(
    readme.includes(`claude plugin marketplace add ${repoSlug}`),
    "README documents the marketplace add command with the real repo slug",
  );
  assert.ok(
    readme.includes(`${entry.name}@${marketplace.name}`),
    "README installs <plugin>@<marketplace> exactly as the manifests name them",
  );
  // --plugin-dir resolves against the session's cwd, and the one cwd that cannot work is
  // this repo: it *is* the site-shot-mcp package, so npx resolves the name locally, finds
  // no linked bin, and the server exits 127 with "command not found" before the handshake.
  const pluginDirArg = /claude --plugin-dir (\S+)/.exec(readme)?.[1];
  assert.ok(pluginDirArg, "README shows how to test the plugin before publication");
  assert.ok(pluginDirArg.startsWith("/"), `--plugin-dir example must be absolute, got "${pluginDirArg}"`);
  assert.ok(
    readme.includes(`site-shot-mcp@${pkg.version}`),
    "README quotes the same pinned version the plugin runs",
  );

  // The marketplace commands only resolve once these manifests are on the public
  // default branch. Printing them without that caveat reads as "already published".
  const marketplaceSection = readme.slice(readme.indexOf("claude plugin marketplace add"));
  assert.match(
    marketplaceSection.slice(0, 1200),
    /\b(?:after|once)\b[^.]*\b(?:published|public|default branch|merged)\b/i,
    "README says the marketplace commands need the manifests published first",
  );

  assert.ok(readme.includes("[mcp_servers.site-shot]"), "README documents the Codex TOML table");
  assert.ok(
    readme.includes('env_vars = ["SITESHOT_API_KEY"]'),
    "Codex instructions forward the key instead of writing it into config.toml",
  );

  // Claude Code collects the key itself through required sensitive userConfig. Telling
  // users to export it anyway would send a credential somewhere nothing reads it from.
  const claudeCodeSection = section("## Claude Code");
  assert.match(
    claudeCodeSection,
    /prompts you for\s+(?:it|the key|your [^.]{0,40}key)\b/i,
    "README says Claude Code prompts for the key",
  );
  assert.doesNotMatch(
    claudeCodeSection,
    /export SITESHOT_API_KEY|"SITESHOT_API_KEY":\s*"YOUR/i,
    "the Claude Code path never asks the user to paste or export the key",
  );
  assert.match(
    claudeCodeSection,
    /\bnot from this\s+checkout\b/i,
    "local testing warns against running from the MCP source checkout",
  );
  assert.match(
    claudeCodeSection,
    /command not found/,
    "README names the observed failure so it is recognisable when hit",
  );

  // Where Claude Code puts a sensitive value is its business and varies by platform.
  assert.doesNotMatch(readme, /\bkeychain\b/i, "no claim about which OS credential store is used");

  // The masked prompt is the only credential route this documents. A --config flag would
  // put the key in argv and shell history, and offering it as an "or" makes that the
  // convenient option precisely for the people least likely to weigh the tradeoff.
  assert.ok(
    claudeCodeSection.includes(`/plugin configure ${entry.name}@${marketplace.name}`),
    "README gives the configure command the installer actually points at",
  );
  assert.doesNotMatch(claudeCodeSection, /--config\b/, "no command-line flag route for the key");
  assert.doesNotMatch(claudeCodeSection, /SITESHOT_API_KEY\s*=/, "the key is never shown on a command line");

  // Claude Desktop is an existing, documented integration; the plugin work must not
  // quietly drop it.
  assert.match(readme, /claude_desktop_config\.json/, "Claude Desktop setup is preserved");
});

test("README describes what the plugin runs, and what a missing key really does", () => {
  const claudeCodeSection = section("## Claude Code");

  // "No background jobs, nothing else runs" was vaguer than the manifest. Name the
  // component types that are absent, and the one process that is not.
  assert.doesNotMatch(claudeCodeSection, /no background jobs/i, "say which components, not a vague sweep");
  assert.match(claudeCodeSection, /no hooks/i, "hooks named");
  assert.match(claudeCodeSection, /\bmonitors?\b/i, "monitors named");
  assert.match(claudeCodeSection, /scheduled[^.]*\bjobs?\b/i, "scheduled capture jobs named");
  assert.match(claudeCodeSection, /stdio MCP server/i, "names the one process the plugin does launch");

  // Two separate layers, and only one of them has been exercised. The isolated
  // install/list run never started a model session, so whether Claude Code launches the
  // server or offers the tools with a required setting unset is simply unknown here.
  // The missing-key tool error is a fact about the stdio server, observed directly;
  // carrying it over to the plugin path would be inventing the untested half.
  assert.doesNotMatch(
    readme,
    /\b(?:server|plugin)[^.]{0,40}(?:will not|won't|refuses to|does not) start\b/i,
    "no invented startup guarantee",
  );
  assert.doesNotMatch(
    readme,
    /missing key (?:therefore )?surfaces as a failed tool call/i,
    "no categorical claim about the untested native-plugin path",
  );
  assert.match(
    claudeCodeSection,
    /configure[^.]*before[^.]*captur|captur[^.]*requires?[^.]*configur/i,
    "captures through the plugin require the native setting to be configured",
  );
  assert.match(readme, /\bdirectly over stdio\b/i, "the missing-key tool error is attributed to direct stdio use");
  assert.match(readme, /tools? return[^.]*error/i, "says what a missing key produces on that path");
});

test("README documents the native Codex install without a key on the command line", () => {
  const repoSlug = pkg.repository.url.replace(/^git\+https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const codex = section("## Codex CLI");

  assert.ok(codex.includes(`codex plugin marketplace add ${repoSlug}`), "native marketplace add, with the real slug");
  assert.ok(
    codex.includes(`codex plugin add ${codexEntry.name}@${codexMarketplace.name}`),
    "installs <plugin>@<marketplace> exactly as the Codex manifests name them",
  );
  assert.ok(codex.includes(`site-shot-mcp@${pkg.version}`), "quotes the same pinned release the descriptor runs");
  assert.match(codex, /0\.147/, "names the CLI version this was exercised against");

  // The whole point of env_vars is that the value never appears in a command, argv or
  // config literal. Documenting `KEY=value` anywhere here would undo that.
  assert.doesNotMatch(codex, /SITESHOT_API_KEY=[A-Za-z0-9]/, "no key value in any documented command");
  assert.match(codex, /\benvironment\b/i, "says the key is provisioned in the session environment");

  // macOS defaults to zsh, where `read -p` starts a coprocess instead of prompting. A
  // bash-labelled fence does not change the reader's shell, so the example must say bash.
  assert.match(
    codex,
    /bash -c '[^']*\bread -r -s -p\b/,
    "the key prompt runs under bash explicitly, not whatever shell the reader pastes into",
  );

  // Native plugin plus a manual `codex mcp add` entry are two configurations of one
  // server. Users must pick, and nothing here should rewrite what they already have.
  assert.match(codex, /\binstead\b|\bboth\b|\beither\b/i, "manual setup is an alternative, not an addition");
});

test("README is honest about where this is and is not distributed", () => {
  // The stdio package genuinely is on npm and in the MCP Registry — understating that
  // is as wrong as overstating the rest.
  assert.match(readme, /\bMCP Registry\b/, "names the registry that does list this package");

  // Name the two routes that actually need a hosted endpoint. "Public directories
  // require HTTPS" would be false: the MCP Registry lists this stdio package today.
  assert.match(readme, /not listed[\s\S]{0,200}?\bdirectory\b/i, "states plainly that those listings do not exist");
  assert.match(readme, /hosted HTTPS/i, "names what those routes require");
  assert.doesNotMatch(
    readme,
    /https:\/\/mcp\.site-shot\.com|\bremote (?:mcp )?(?:endpoint|server) (?:is|at) (?:live|available)\b/i,
    "no remote MCP endpoint is advertised",
  );
  assert.doesNotMatch(readme, /\b(?:app|client)[_ ]?id\b/i, "no invented registered application id");

  // The repo now ships a native Codex plugin. Installing it from this marketplace is
  // not the same as being admitted to the public ChatGPT/Codex directory.
  const codex = section("## Codex CLI");
  assert.match(codex, /codex plugin add/, "gives the native install command");
  assert.match(codex, /\binstall\w*\b[^.]*\bnot\b[^.]*\bconfigured\b/i, "install, configured and capturing are distinguished");
});

test("copy does not imply per-capture charges or promise every page", () => {
  const copy = [
    readme,
    JSON.stringify(marketplace),
    JSON.stringify(plugin),
    JSON.stringify(codexMarketplace),
    JSON.stringify(codexPlugin),
    read(`${pluginDir}/skills/website-screenshots/SKILL.md`),
  ];
  for (const text of copy) {
    // A key draws on an account's existing API allowance; it is not a card charged per call,
    // and a failed capture is not automatically a paid one.
    assert.doesNotMatch(text, /\bbilled\b|\bcharged\b|\bper[- ]capture (?:charge|cost|fee)\b/i, "no per-invocation billing claim");
    assert.doesNotMatch(text, /\bany (?:public )?web page\b/i, "no promise to capture any page whatsoever");
  }
});

// The versions the tests above could not see. Everything they check is a file this
// suite reads; `serverInfo.version` is a value the server states over the wire during
// the handshake, and it is what a client -- or a directory reviewer -- actually sees.
// It drifted exactly because it was a literal nobody had to touch: 1.1.2 went to npm
// while the handshake kept answering 1.1.1. src/server.js now derives it from
// package.json, and this test is what keeps that true if someone puts a literal back.
// manifest.json and server.json are the other two release descriptors no other test
// reads, and they can drift the same silent way.
test("every version this package states agrees with package.json", async () => {
  const identity = await servedIdentity();
  assert.equal(identity?.version, pkg.version, "the MCP handshake states this package's version");
  assert.equal(identity?.name, "site-shot", "the handshake keeps the brand name");

  assert.equal(readJson("manifest.json").version, pkg.version, "MCPB manifest tracks the package");

  const registry = readJson("server.json");
  assert.equal(registry.version, pkg.version, "MCP Registry entry tracks the package");
  for (const entry of registry.packages ?? []) {
    assert.equal(entry.version, pkg.version, `registry package "${entry.identifier}" tracks the package`);
  }
});
