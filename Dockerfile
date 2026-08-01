FROM node:20-slim

# ffmpeg + ffprobe are required for transcoding and duration probing.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Make sure runtime folders exist even if empty in the repo.
RUN mkdir -p public/hls cache

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "src/server.js"]
