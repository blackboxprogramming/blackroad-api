server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name blackroad.io www.blackroad.io;

  # If you use HTTPS, keep your existing SSL server block; mirror the same proxy rules there.

  # Proxy all routes to the JSON API
  location / {
    proxy_pass         http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection $connection_upgrade;

    # Never override Content-Type from upstream (Express sets application/json)
    proxy_hide_header  X-Powered-By;
  }

  # Health check (optional): hits API’s /api/health
  location = /health {
    proxy_pass http://127.0.0.1:4000/api/health;
  }

  # Basic hardening
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer-when-downgrade always;
  add_header X-Frame-Options SAMEORIGIN always;
  add_header X-XSS-Protection "1; mode=block" always;

  access_log /var/log/nginx/blackroad.access.log;
error_log  /var/log/nginx/blackroad.error.log warn;
}
}
