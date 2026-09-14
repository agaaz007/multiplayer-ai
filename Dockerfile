# Ledger MCP over HTTP: the ChatGPT / claude.ai test endpoint (scratch ledger, no login yet).
# Run: LEDGER_HTTP_SECRET=<random> ; the MCP URL is https://<host>/mcp/<secret>
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# the package's install lifecycle runs the build, which needs the sources copied below
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build
ENV NODE_ENV=production LEDGER_SCRATCH_DIR=/data/scratch LEDGER_AUTHOR=chatgpt-test
EXPOSE 8787
CMD ["node", "dist/cli.js", "mcp", "--http", "--scratch"]
