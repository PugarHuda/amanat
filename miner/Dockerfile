# The miner has no dependencies to install, so the image is the runtime plus the
# source. It is not one file, though: server.mjs imports ten modules from lib/
# and reads four files out of public/, so copying server.mjs alone produced an
# image that died on boot with ERR_MODULE_NOT_FOUND. This is the documented
# fallback if Vercel is the thing that failed, so it has to actually run.
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./
COPY lib ./lib
COPY public ./public

# Never run the miner as root: it takes unauthenticated input from the network.
USER node

ENV PORT=8080
EXPOSE 8080

# Telegraph drops a miner whose endpoint stops answering, so the container must
# fail fast rather than sit there unresponsive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "server.mjs"]
