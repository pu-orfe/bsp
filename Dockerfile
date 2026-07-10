# Multi-stage build for Drupal UI automation platform
FROM node:26-bullseye as base

# Install system dependencies for headful browser and VNC
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    curl \
    supervisor \
    xvfb \
    x11vnc \
    fluxbox \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Install noVNC
RUN mkdir -p /opt/noVNC && \
    cd /opt/noVNC && \
    wget -qO- https://github.com/novnc/noVNC/archive/refs/tags/v1.4.0.tar.gz | tar xz --strip-components=1 && \
    ln -s /opt/noVNC/vnc.html /opt/noVNC/index.html

# Generate self-signed certificate for noVNC
RUN openssl req -new -x509 -days 365 -nodes -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost" -out /opt/noVNC/self.pem -keyout /opt/noVNC/self.pem

# Install websockify
RUN mkdir -p /opt/websockify && \
    cd /opt/websockify && \
    wget -qO- https://github.com/novnc/websockify/archive/refs/tags/v0.11.0.tar.gz | tar xz --strip-components=1

# Set up application directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Install Playwright browsers
RUN npx playwright install --with-deps chromium

# Production stage
FROM base as production

# Copy application code
COPY . .

# Create necessary directories
RUN mkdir -p /tmp /app/storage

# Set environment variables
ENV DISPLAY=:99
ENV NODE_ENV=production
ENV NOVNC_PORT=8080
ENV VNC_PORT=5900

# Create supervisord configuration
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Expose ports
EXPOSE 3000 8080 5900

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start supervisord
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]