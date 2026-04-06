#!/bin/bash
set -e

# ───────────────────────────────────────────────
# ES Studio - Nginx + HTTPS Setup for EC2
# ───────────────────────────────────────────────
# Usage: sudo ./setup-nginx.sh your-api-domain.com
#
# This sets up Nginx as a reverse proxy with
# Let's Encrypt SSL for the backend API.
# ───────────────────────────────────────────────

DOMAIN="${1:?Usage: sudo ./setup-nginx.sh <your-domain.com>}"

echo "📦 Installing Nginx and Certbot..."
apt update
apt install -y nginx certbot python3-certbot-nginx

echo "🔧 Writing Nginx config..."
cat > /etc/nginx/sites-available/es-studio << EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;

        # CORS handled by NestJS, not Nginx
    }
}
EOF

ln -sf /etc/nginx/sites-available/es-studio /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

echo "✅ Testing Nginx config..."
nginx -t

echo "🔄 Restarting Nginx..."
systemctl restart nginx

echo "🔒 Obtaining SSL certificate..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email admin@$DOMAIN

echo "🔄 Restarting Nginx with SSL..."
systemctl restart nginx

echo ""
echo "✅ Done! Your API is now available at:"
echo "   https://$DOMAIN"
echo ""
echo "⚠️  Don't forget to update these:"
echo "   1. Backend .env.production: FRONTEND_URL=https://your-vercel-app.vercel.app"
echo "   2. Vercel env vars: NEXT_PUBLIC_API_URL=https://$DOMAIN"
echo "   3. EC2 security group: Allow ports 80 and 443"
