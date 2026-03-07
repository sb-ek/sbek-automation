# SBEK Automation — backend service
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN NODE_OPTIONS="--max-old-space-size=512" npm ci --maxsockets=2

COPY tsconfig.json ./
COPY src/ ./src/

RUN NODE_OPTIONS="--max-old-space-size=512" npx tsc --declaration false --sourceMap false

FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --maxsockets=2

COPY --from=builder /app/dist ./dist
COPY src/templates ./dist/templates

# Copy optional asset directories — use shell so build doesn't fail if missing
RUN mkdir -p /app/seo /app/creatives
COPY . /tmp/ctx/
RUN cp -r /tmp/ctx/seo/* /app/seo/ 2>/dev/null || true; \
    cp -r /tmp/ctx/creatives/* /app/creatives/ 2>/dev/null || true; \
    cp -r /tmp/ctx/scripts /app/scripts 2>/dev/null || true; \
    rm -rf /tmp/ctx

COPY src/ ./src/
COPY tsconfig.json ./
RUN npm install tsx --save-optional --no-save 2>/dev/null || true

RUN mkdir -p /app/reports

EXPOSE 3000

CMD ["node", "dist/index.js"]
