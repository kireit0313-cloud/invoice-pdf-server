FROM node:20-slim

# Puppeteerに必要なライブラリをインストール
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-noto-cjk \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# PuppeteerにシステムのChromiumを使わせる
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 8080
CMD ["node", "index.js"]
