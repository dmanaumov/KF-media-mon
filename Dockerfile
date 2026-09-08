FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

# initSchema() в db.js гоняется при каждом старте (CREATE TABLE IF NOT EXISTS)
CMD ["node", "src/server.js"]
