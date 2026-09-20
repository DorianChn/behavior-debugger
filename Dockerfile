# Behavior Debugger — container image
#
# Note: this runs the API and dashboard. The data root is a volume so the
# append-only event log survives container restarts — which is the point of
# the WAIT persistence guarantee.
FROM node:22-alpine

WORKDIR /app

# Dependencies first, for layer caching. There are no runtime dependencies,
# so this layer is only the devDependencies needed to run TypeScript.
COPY package.json package-lock.json* ./
RUN npm ci --omit=optional || npm install

# Source
COPY tsconfig.json ./
COPY shared/ ./shared/
COPY collector/ ./collector/
COPY behavior/ ./behavior/
COPY reasoning/ ./reasoning/
COPY intervention/ ./intervention/
COPY verification/ ./verification/
COPY database/ ./database/
COPY frontend/ ./frontend/
COPY scripts/ ./scripts/
COPY service.ts server.ts ./

# The event log lives on a volume, not in the image.
ENV BEHAVIOR_DEBUGGER_HOME=/data
ENV PORT=4317
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 4317

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
