# Dockerfile for analytics-bff (Cloud Build source path: repo root)
# Multi-stage: build TS, then runtime with vendored @usgcp/* libs.
FROM node:20-slim AS builder
WORKDIR /workspace
COPY package.json package-lock.json* tsconfig.base.json ./
COPY libs/ ./libs/
COPY apps/ ./apps/
RUN npm ci --no-audit --no-fund
# Build all libs first
RUN npm run build -w libs/events && \
    npm run build -w libs/firestore && \
    npm run build -w libs/pubsub && \
    npm run build -w libs/auth && \
    npm run build -w libs/http && \
    npm run build -w libs/proto-decode
# Then the app
RUN npm run build -w apps/analytics-bff

# Runtime
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# 1) Install 3rd-party deps FIRST. Strip @usgcp/* (file:..) from package.json
#    so npm install doesn't try to resolve workspace siblings.
COPY --chown=node:node --from=builder /workspace/apps/analytics-bff/package.json /app/package.json
COPY terraform/scripts/strip-usgcp-deps.sh /tmp/strip-usgcp-deps.sh
RUN sh /tmp/strip-usgcp-deps.sh && \
    npm install --omit=dev --ignore-scripts --no-audit --no-fund

# 2) THEN vendor the @usgcp/* workspace libs into node_modules.
RUN mkdir -p /app/node_modules/@usgcp
COPY --chown=node:node --from=builder /workspace/libs/events       /app/node_modules/@usgcp/events
COPY --chown=node:node --from=builder /workspace/libs/firestore    /app/node_modules/@usgcp/firestore
COPY --chown=node:node --from=builder /workspace/libs/pubsub       /app/node_modules/@usgcp/pubsub
COPY --chown=node:node --from=builder /workspace/libs/auth         /app/node_modules/@usgcp/auth
COPY --chown=node:node --from=builder /workspace/libs/http         /app/node_modules/@usgcp/http
COPY --chown=node:node --from=builder /workspace/libs/proto-decode /app/node_modules/@usgcp/proto-decode

# 3) Copy the compiled app last; drop privileges for runtime.
COPY --chown=node:node --from=builder /workspace/apps/analytics-bff/dist ./dist
RUN chown -R node:node /app
USER node
CMD ["node", "./dist/index.js"]
