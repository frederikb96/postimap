FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS production
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/config ./config
RUN npm ci --omit=dev
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget -q --spider http://localhost:8090/healthz || exit 1
CMD ["node", "dist/index.js"]
