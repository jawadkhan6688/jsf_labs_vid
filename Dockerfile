FROM node:22-bookworm-slim

# Install FFmpeg and verify
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    ffmpeg -version && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]