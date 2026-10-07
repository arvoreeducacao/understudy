FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.292
ARG CODEX_VERSION=0.160.1
ARG PLAYWRIGHT_MCP_VERSION=0.0.83

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tmux git curl tini fonts-noto-color-emoji fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb openbox xdotool x11-utils xauth \
      tint2 lxterminal pcmanfm hsetroot papirus-icon-theme gnome-themes-extra \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      python3 python3-pip python3-pandas python3-openpyxl \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-por \
      pandoc ffmpeg poppler-utils sqlite3 fonts-dejavu-core \
 && pip3 install --no-cache-dir --break-system-packages pdfplumber==0.11.4 \
 && rm -rf /var/lib/apt/lists/* /root/.cache

RUN npm install -g \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
      @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
 && npm cache clean --force

RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/computer/package.json apps/computer/package.json
COPY apps/host/package.json apps/host/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/characters/package.json packages/characters/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/runtime/package.json packages/runtime/package.json
RUN pnpm install --frozen-lockfile --prod --filter @understudy/computer... \
 && cd apps/computer \
 && pnpm exec playwright-core install --with-deps chromium \
 && pnpm store prune \
 && rm -rf /var/lib/apt/lists/* /root/.cache /root/.local/share/pnpm
COPY packages/protocol/src packages/protocol/src
COPY packages/runtime/src packages/runtime/src
COPY apps/computer/src apps/computer/src
COPY apps/computer/dev apps/computer/dev

RUN for dir in /etc/opt/chrome_for_testing/policies/managed /etc/opt/chrome/policies/managed /etc/chromium/policies/managed; do \
      mkdir -p "$dir" && printf '%s' '{"URLBlocklist":["file://*"],"AllowFileSelectionDialogs":false,"BrowserSignin":0,"SyncDisabled":true,"PromotionalTabsEnabled":false,"DefaultBrowserSettingEnabled":false}' > "$dir/understudy.json"; \
    done

RUN userdel -r node 2>/dev/null || true \
 && useradd --create-home --home-dir /home/agent --uid 1000 --shell /bin/bash agent \
 && mkdir -p /run/bench && chown agent:agent /run/bench \
 && mkdir -p /home/agent/files/inbox /home/agent/files/outbox /home/agent/runs /home/agent/memory /home/agent/.understudy \
 && chown -R agent:agent /home/agent

USER agent
ENV HOME=/home/agent
WORKDIR /home/agent
VOLUME /home/agent

ARG UNDERSTUDY_VERSION=dev
ENV UNDERSTUDY_VERSION=${UNDERSTUDY_VERSION}

ENTRYPOINT ["tini", "-s", "--"]
CMD ["node", "--experimental-strip-types", "--no-warnings", "/app/apps/computer/src/main.ts"]
