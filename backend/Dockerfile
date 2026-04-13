# AUDIT FIX (W-ARCH-1): Multi-stage build.
# Stage "builder": installa TUTTE le dipendenze (incluse devDependencies come tsc-alias)
# per compilare TypeScript e risolvere gli alias @/*.
# Stage finale: copia solo dist/ compilato + dipendenze di produzione (immagine minima).

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
