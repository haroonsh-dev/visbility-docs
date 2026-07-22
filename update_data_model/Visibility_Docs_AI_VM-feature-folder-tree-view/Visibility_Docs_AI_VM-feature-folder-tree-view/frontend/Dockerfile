FROM node:20-alpine AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /build/.next/standalone ./
COPY --from=builder /build/public ./public
COPY --from=builder /build/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
