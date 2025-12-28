# Build stage
FROM node:20-alpine AS builder

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source code
COPY . .

# Production stage
FROM node:20-alpine

# Install runtime dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && \
    npm cache clean --force

# Copy source from builder
COPY --from=builder /app/src ./src

# Create data directory
RUN mkdir -p /app/data && chown -R nodejs:nodejs /app/data

# Set ownership
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Environment
ENV NODE_ENV=production
ENV PORT=4000
ENV DB_PATH=/app/data/blackroad.db

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

# Start
CMD ["node", "src/app.js"]
