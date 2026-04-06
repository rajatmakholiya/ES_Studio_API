#!/bin/bash
set -e

# ───────────────────────────────────────────────
# ES Studio Backend - EC2 Deployment Script
# ───────────────────────────────────────────────
# Usage: ./deploy.sh
#
# Prerequisites on EC2:
#   1. Docker installed: sudo apt install docker.io
#   2. .env.production file at /opt/es-studio/.env.production
#   3. GCP key file at /opt/es-studio/gcp-key.json
#   4. Nginx + Certbot for HTTPS (see setup-nginx.sh)
# ───────────────────────────────────────────────

APP_NAME="es-studio-backend"
APP_DIR="/opt/es-studio"
IMAGE_NAME="es-studio-backend:latest"

echo "📦 Building Docker image..."
docker build -t "$IMAGE_NAME" -f DockerFile .

echo "🛑 Stopping existing container (if any)..."
docker stop "$APP_NAME" 2>/dev/null || true
docker rm "$APP_NAME" 2>/dev/null || true

echo "🚀 Starting new container..."
docker run -d \
  --name "$APP_NAME" \
  --restart unless-stopped \
  -p 5000:5000 \
  --env-file "$APP_DIR/.env.production" \
  -v "$APP_DIR/gcp-key.json:/app/gcp-key.json:ro" \
  "$IMAGE_NAME"

echo "⏳ Waiting for health check..."
sleep 5

if docker ps | grep -q "$APP_NAME"; then
  echo "✅ Deployment successful! Container is running."
  docker logs --tail 20 "$APP_NAME"
else
  echo "❌ Deployment failed. Container logs:"
  docker logs "$APP_NAME"
  exit 1
fi
