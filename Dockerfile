FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev && npm install tsx --no-save
COPY --from=builder /app/dist ./dist
COPY server.ts ./
COPY server ./server
COPY src ./src
EXPOSE 3000
CMD ["npx", "tsx", "server.ts"]
