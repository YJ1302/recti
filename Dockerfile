# Rectificación — Express + EJS
FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# App source (.env excluded via .dockerignore — injected at runtime by compose)
COPY . .

ENV PORT=3003
EXPOSE 3003

CMD ["node", "app.js"]
