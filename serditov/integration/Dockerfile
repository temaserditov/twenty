FROM node:24.10.0-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=3034 CRM_QUEUE_PATH=/data/crm.sqlite
EXPOSE 3034
CMD ["node", "src/server.mjs"]
