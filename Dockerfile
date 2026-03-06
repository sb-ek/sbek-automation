# SBEK Automation — backend service
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false

# Install Chromium dependencies for Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY src/templates ./dist/templates

# Copy optional asset directories — use shell so build doesn't fail if missing
RUN mkdir -p /app/seo /app/creatives
COPY . /tmp/ctx/
RUN cp -r /tmp/ctx/seo/* /app/seo/ 2>/dev/null || true; \
    cp -r /tmp/ctx/creatives/* /app/creatives/ 2>/dev/null || true; \
    cp -r /tmp/ctx/scripts /app/scripts 2>/dev/null || true; \
    rm -rf /tmp/ctx

# Include source for dashboard seed/reset button
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm install tsx --save-optional --no-save 2>/dev/null || true

RUN mkdir -p /app/reports

EXPOSE 3000

CMD ["node", "dist/index.js"]
