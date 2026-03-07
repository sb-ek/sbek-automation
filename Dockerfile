# SBEK Automation — backend service (no build step, runs TS directly via tsx)
FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --maxsockets=2

COPY tsconfig.json ./
COPY src/ ./src/

# Copy optional asset directories
RUN mkdir -p /app/seo /app/creatives /app/reports
COPY . /tmp/ctx/
RUN cp -r /tmp/ctx/seo/* /app/seo/ 2>/dev/null || true; \
    cp -r /tmp/ctx/creatives/* /app/creatives/ 2>/dev/null || true; \
    cp -r /tmp/ctx/scripts /app/scripts 2>/dev/null || true; \
    rm -rf /tmp/ctx

EXPOSE 3000

# Run TypeScript directly with tsx — no tsc build needed
CMD ["npx", "tsx", "src/index.ts"]
