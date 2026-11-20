FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
ENV DATA_DIR=/data PORT=8787
VOLUME /data
EXPOSE 8787
CMD ["node", "src/server.ts"]
