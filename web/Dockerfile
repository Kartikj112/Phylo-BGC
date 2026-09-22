# Phylo-BGC website image, used by the root docker-compose.yml.
#
# NEXT_PUBLIC_API_URL is compiled into the browser bundle AND named in the
# page's Content-Security-Policy (see next.config.mjs), so it is a build
# argument, not a runtime variable: it must be the API address as the
# VIEWER'S BROWSER sees it — for a local compose run, http://localhost:8000,
# not the container-network name.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN npx next build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.mjs ./
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "--port", "3000", "--hostname", "0.0.0.0"]
