server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name blackroad.io www.blackroad.io;

  location / {
    proxy_pass         http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection "upgrade";

    proxy_hide_header  X-Powered-By;
  }

  location = /health {
    proxy_pass http://127.0.0.1:4000/api/health;
  }

  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer-when-downgrade always;
  add_header X-Frame-Options SAMEORIGIN always;
  add_header X-XSS-Protection "1; mode=block" always;

  access_log /var/log/nginx/blackroad.access.log;
  error_log  /var/log/nginx/blackroad.error.log warn;
}
