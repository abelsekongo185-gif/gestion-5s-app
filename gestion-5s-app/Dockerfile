FROM node:20-alpine
WORKDIR /app
COPY server.js package.json ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data TZ=Africa/Abidjan
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
