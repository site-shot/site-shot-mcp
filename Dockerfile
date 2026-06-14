# Container image for Glama (https://glama.ai) and other container-based MCP hosts.
#
# site-shot-mcp is a stdio MCP server: the container speaks the MCP protocol over
# stdin/stdout. It starts and answers introspection (tools/list) WITHOUT a key —
# SITESHOT_API_KEY is only required at call time, so pass it at run time, e.g.:
#   docker run -i -e SITESHOT_API_KEY=... site-shot-mcp
FROM node:20-slim

WORKDIR /app

# Install production dependencies against the committed lockfile.
# Both deps (@modelcontextprotocol/sdk, zod) are pure JS — no native build tools needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source.
COPY src ./src
COPY README.md LICENSE ./

ENV NODE_ENV=production

# stdio transport: the server's stdin/stdout carry MCP messages.
ENTRYPOINT ["node", "src/index.js"]
