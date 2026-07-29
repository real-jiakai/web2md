# web2md — static + JS-rendered pages to AI-ready Markdown.
# Node 22 server + Camoufox (anti-detect Firefox) dynamic fallback.

FROM node:22-bookworm-slim

# Python for the Camoufox renderer.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node dependencies (cached layer; devDeps included for the TS build).
COPY package.json package-lock.json ./
RUN npm ci

# Camoufox + browser binary + Firefox system libraries (heavy, cached layer).
RUN python3 -m venv .venv \
    && .venv/bin/pip install --no-cache-dir camoufox \
    && .venv/bin/python -m camoufox fetch \
    && .venv/bin/playwright install-deps firefox \
    && rm -rf /var/lib/apt/lists/*

# Application: build TypeScript, then drop dev dependencies.
COPY tsconfig.json ./
COPY src/ src/
COPY test/ test/
RUN npm run build && npm prune --omit=dev

ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
