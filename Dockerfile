FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/butterboy77/triptaster" \
      org.opencontainers.image.description="A self-hosted food diary and lucky dip for trips with friends" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 NODE_NO_WARNINGS=1
WORKDIR /app
COPY package.json server.js cli.js ./
COPY src ./src
COPY public ./public
# Created here so a new named volume inherits ownership by the node user.
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
