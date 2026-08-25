# Multi-stage build for efficient container size
FROM node:26-alpine AS builder

# Build arguments
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (--ignore-scripts prevents 'prepare' from running before source is copied)
RUN npm ci --ignore-scripts

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:26-alpine AS production

# Create a non-root user for security
RUN addgroup -g 1001 -S cwmanage && \
    adduser -S cwmanage -u 1001 -G cwmanage

# Set working directory
WORKDIR /app

# Copy package files and built application from builder stage
COPY package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Prune dev dependencies
RUN npm prune --omit=dev && npm cache clean --force

# Create logs directory
RUN mkdir -p /app/logs && chown -R cwmanage:cwmanage /app

# Switch to non-root user
USER cwmanage

# Expose port for HTTP transport
EXPOSE 8080

# Health check against the HTTP endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Set environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=env

# Define volume for logs
VOLUME ["/app/logs"]

# Start the application
CMD ["node", "dist/index.js"]

# Labels for metadata
LABEL maintainer="engineering@wyre.ai"
LABEL version="${VERSION}"
LABEL description="ConnectWise Manage MCP Server - Model Context Protocol server for ConnectWise PSA"
LABEL org.opencontainers.image.title="connectwise-manage-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for ConnectWise Manage (PSA) integration"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/WYRE-AI/connectwise-manage-mcp"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/connectwise-manage-mcp"
