FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .
COPY gates-seed.json .
COPY public/ public/
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "server.js"]
