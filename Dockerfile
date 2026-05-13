FROM node:22-slim
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .
COPY apa-sabre-client.js .
COPY crew-cache.js .
COPY gates-seed.json .
COPY public/ public/
RUN mkdir -p /app/data /data
EXPOSE 3000
CMD ["node", "server.js"]
