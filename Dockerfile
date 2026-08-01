# Dockerfile — primarily for the Glama MCP registry (https://glama.ai/mcp/servers).
#
# Builds the MCP server and runs it over stdio. The server starts cleanly
# WITHOUT PPSSPP present: it attempts a connection in the background and
# still serves tools/list over stdio even if that connection fails. That's
# exactly what Glama's "start + respond to introspection" check needs.
#
# For actual use you don't need Docker — `npm install -g mcp-ppsspp` and
# point it at a running PPSSPP instance with "Allow remote debugger" enabled
# (PPSSPP_HOST / PPSSPP_PORT env vars). See README.md.

FROM node:22-trixie-slim@sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba
WORKDIR /app

# Install dependencies. --ignore-scripts skips the `prepare` hook; we run the
# build explicitly below so the layer caching is predictable.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Compile TypeScript -> dist/
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# The MCP server speaks JSON-RPC over stdio and connects out to PPSSPP's
# WebSocket debugger — no bridge/plugin to ship alongside it.
ENTRYPOINT ["node", "dist/index.js"]
