# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
# Node 24 ("Krypton") is the active LTS line. Deliberately not tracking Current:
# this image is meant to hold land tenure records and move money, so it should
# sit on a release that receives security backports for 30 months.
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY docs ./docs

RUN npm run build

# ---- runtime --------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app

# Fail closed by default: the app refuses to start under NODE_ENV=production
# because Release 0 defines no authentication contract. Compose overrides this
# for local use; a real deployment must wire a PrincipalResolver first.
ENV NODE_ENV=production
ENV SPEC_ROOT=/app/docs/forest_platform_machine_readable_release0/forest_platform_release0
ENV WEB_ROOT=/app/web
ENV PORT=3000
ENV HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
# The specification package is read at runtime — it is the source of truth for
# error statuses, permissions and the event envelope, not a build-time input.
COPY docs ./docs
# The UI is served as static files. branding.json is read by the browser, so it
# can be swapped by mounting a volume over it without rebuilding the image.
COPY web ./web

RUN addgroup -S forest && adduser -S forest -G forest && chown -R forest:forest /app
USER forest

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server.js"]
