# kitp — multi-stage production image.
#
# Build (context = repo root):
#   docker build -t kitp:latest .
#
# Run (minimal prod config — see README "Container / deployment"):
#   docker run --rm -p 8080:8080 \
#     -e DATABASE_URL='postgres://kitp:secret@db.internal:5432/kitp?sslmode=require' \
#     -e ENV=production \
#     -e AUTH_MODE=oidc \
#     -e OIDC_ISSUER='https://id.example.com' \
#     -e OIDC_CLIENT_ID='kitp' \
#     -e OIDC_CLIENT_SECRET='…'            # omit for a PKCE-only public client \
#     -e OIDC_REDIRECT_URI='https://kitp.example.com/api/v1/auth/oidc/callback' \
#     -e KITP_COMM_SECRET_KEY='…32+ byte random…' \
#     kitp:latest
#
# Schema is applied on startup from /app/db/schema (idempotent). The web bundle
# is served at GET / from /app/web. Both are baked into the image.

# ---------- stage 1: web bundle (esbuild) ----------
# esbuild is the SOLE web build dependency, and it's itself a Go program — there
# is no official esbuild image, and npm is only its delivery vehicle. So we
# `go install` the pinned CLI (keep in sync with web/package-lock.json) and skip
# Node entirely: the whole image is built with one toolchain.
FROM golang:1.26-alpine AS web
RUN go install github.com/evanw/esbuild/cmd/esbuild@v0.21.5
WORKDIR /app/web
# Source only (vendored dompurify/marked + design tokens are bundled from
# relative imports — no install step).
COPY web/ ./
# Bundle the two named entries to dist/{app.js,styles.css} (styles.css's @import
# of design/tokens.css is inlined), then rewrite index.html's asset refs from
# relative to absolute so deep SPA routes resolve them. Mirrors `make web`,
# minified for production (no sourcemaps).
RUN esbuild app=src/main.ts styles=styles.css \
        --bundle --format=esm --target=es2022 --minify --outdir=dist \
 && sed -e 's#\./dist/app\.js#/app.js#' -e 's#\./styles\.css#/styles.css#' \
        index.html > dist/index.html

# ---------- stage 2: static Go binary ----------
FROM golang:1.26-alpine AS server
WORKDIR /src/server
# Module cache layer.
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
# CGO off → a fully static binary that runs on scratch. KITP_SCHEMA_DIR (set in
# the runtime stage) means the binary never depends on the build-time source
# layout, so -trimpath is safe.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' \
        -o /out/kitpd ./cmd/kitpd

# ---------- ca-certs + tzdata for the scratch runtime ----------
FROM alpine:3.20 AS certs
RUN apk add --no-cache ca-certificates tzdata

# ---------- stage 3: runtime (scratch) ----------
FROM scratch
# Outbound TLS (OIDC JWKS, IMAP/SMTP) needs the CA bundle; tzdata for time zones.
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=certs /usr/share/zoneinfo /usr/share/zoneinfo
# Binary + the disk assets it reads (schema applied on startup; web served at /).
COPY --from=server /out/kitpd /usr/local/bin/kitpd
COPY db/schema /app/db/schema
COPY --from=web /app/web/dist /app/web

ENV KITP_SCHEMA_DIR=/app/db/schema \
    WEB_DIR=/app/web \
    LISTEN_ADDR=:8080 \
    ENV=production
EXPOSE 8080
# Run unprivileged (nobody). scratch has no /etc/passwd, so use the numeric uid.
USER 65534:65534
ENTRYPOINT ["/usr/local/bin/kitpd"]
