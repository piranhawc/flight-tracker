FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates sqlite3 && rm -rf /var/lib/apt/lists/*
COPY package.json .
RUN npm install --production
COPY server.js .
COPY apa-sabre-client.js .
COPY apa-logbook-client.js .
COPY crew-cache.js .
COPY fa-tracker.js .
COPY friends-client.js .
COPY agentmail-client.js .
COPY signup-tracker.js .
COPY gates-seed.json .
COPY public/ public/
RUN mkdir -p /app/data /data
EXPOSE 3000
CMD ["node", "server.js"]
