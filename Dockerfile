# Azure Container Registry's dependency scanner does not understand an inline
# FROM --platform flag. Use --platform on the build command when building from
# ARM machines locally.

FROM node:24-alpine AS builder
WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci

COPY . .
RUN mkdir -p public
RUN npx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Prune devDependencies; prisma is now in dependencies so it stays
RUN npm prune --omit=dev

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache openssl

# Copy standalone Next.js server (self-contained, includes traced node_modules)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy Prisma schema + migrations so migrate deploy can run at startup.
COPY --from=builder /app/prisma ./prisma

# Copy full node_modules from the builder. This keeps Prisma CLI runtime
# dependencies intact for `migrate deploy` in startup.sh.
COPY --from=builder /app/node_modules ./node_modules

COPY startup.sh ./
COPY scripts/review-worker.mjs ./scripts/review-worker.mjs
COPY scripts/import-livit-surveys.mjs ./scripts/import-livit-surveys.mjs
COPY surveys/livit.json ./surveys/livit.json
# Normalize line endings in case startup.sh is checked out with CRLF on Windows.
RUN sed -i 's/\r$//' startup.sh && chmod +x startup.sh

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["sh", "startup.sh"]
