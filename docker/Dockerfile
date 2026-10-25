# syntax=docker/dockerfile:1.7
#
# DocPilot's own docs site under the server runtime — engine-spec 028.
#
# One image, one process: `docpilot serve` answers `/ai/turn` and serves the
# built site beside it, so the panel's endpoint is same-origin. The index is the
# committed `docs/public/rag-local` (bge-m3); the chat model and the embedder are
# reached at run time through OLLAMA_BASE_URL. No key and no `.env*` file ever
# enters a layer — see Dockerfile.dockerignore.
FROM node:22-bookworm-slim

# VitePress's `lastUpdated` shells out to git at build time. `.git` is not in the
# context, so every page simply has no timestamp — but the binary must exist.
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# `prepare` builds dist/ from src/, which is not copied yet.
RUN npm ci --ignore-scripts

COPY . .

# Read by docs/.vitepress/config.mjs at build time AND at run time: the panel is
# compiled as a thin client, and `serve` re-reads the same settings.
ENV DOCPILOT_EMBED_LOCAL=1 \
    DOCPILOT_RUNTIME=server \
    NODE_ENV=production

RUN npm run docs:build

# The turn log, one docpilot.turn/1 file per UTC day — owned by the user the
# process runs as, which is not root (engine-spec 033): a turn that found a way
# to write a file should find nothing it could overwrite.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8787/ai/turn/manifest').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "bin/docpilot.js", "serve", \
     "--host=0.0.0.0", "--port=8787", \
     "--dir=docs/.vitepress/dist", \
     "--log=/data/turns", "--log-prompts", "--retention-days=30"]
