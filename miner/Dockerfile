# The miner is one file with no dependencies, so the image is the runtime plus
# that file. Nothing to install, nothing to build.
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./

# Never run the miner as root: it takes unauthenticated input from the network.
USER node

ENV PORT=8080
EXPOSE 8080

# Telegraph drops a miner whose endpoint stops answering, so the container must
# fail fast rather than sit there unresponsive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "server.mjs"]
