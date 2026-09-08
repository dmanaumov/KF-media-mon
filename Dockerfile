FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

# migrate.sql использует CREATE TABLE IF NOT EXISTS — безопасно гонять при каждом старте
CMD ["sh", "-c", "node src/migrate.js && node src/server.js"]
