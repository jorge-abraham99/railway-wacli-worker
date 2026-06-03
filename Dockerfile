FROM golang:1.25-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    sqlite3 \
    bash \
    git \
    build-essential \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

RUN CGO_ENABLED=1 CGO_CFLAGS="-Wno-error=missing-braces" \
    go install -tags sqlite_fts5 github.com/openclaw/wacli/cmd/wacli@latest

ENV PATH="/go/bin:${PATH}"
ENV WACLI_STORE_DIR="/data/wacli"

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN chmod +x /app/start.sh

CMD ["/app/start.sh"]
