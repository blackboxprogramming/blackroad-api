# BlackRoad API

> Proprietary software of **BlackRoad OS, Inc.** — Not open source.

JSON-only REST API powering BlackRoad services. Deployable to Cloudflare Workers, Railway, Vercel, or bare-metal (systemd + nginx).

## Quick Start

```bash
# Install dependencies
npm ci

# Run locally (port 4000)
npm start

# Run tests
npm test

# Lint check
npm run lint
```

## API Endpoints

| Method | Path                | Description          |
|--------|---------------------|----------------------|
| GET    | `/`                 | API root / status    |
| GET    | `/api/health`       | Health check         |
| GET    | `/api/status`       | System status        |
| GET    | `/api/routes`       | List all routes      |
| GET    | `/api/openapi.json` | OpenAPI 3.1.0 spec   |
| GET    | `/api/agents`       | List agents          |
| POST   | `/api/agents`       | Create agent         |
| POST   | `/api/echo`         | Echo request body    |

### Example Requests

```bash
# Health check
curl https://api.blackroad.io/api/health

# Create an agent
curl -X POST https://api.blackroad.io/api/agents \
  -H "Content-Type: application/json" \
  -d '{"id": "my-agent", "role": "ops", "active": true}'

# Echo test
curl -X POST https://api.blackroad.io/api/echo \
  -H "Content-Type: application/json" \
  -d '{"message": "hello"}'
```

### Response Format

All responses follow a consistent JSON envelope:

```json
{
  "ok": true,
  "status": 200,
  "data": { ... },
  "meta": {}
}
```

Error responses:

```json
{
  "ok": false,
  "status": 400,
  "error": {
    "message": "Bad Request",
    "details": {}
  }
}
```

## Deployment

### Cloudflare Workers

Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets in GitHub.

```bash
npx wrangler deploy --env production
```

Cloudflare Worker entry point: `worker.js`
Configuration: `wrangler.toml`

### Railway

Configured via `railway.toml`. Health checks hit `/api/health`.

### Vercel

Configured via `vercel.json`. Routes all traffic to `server_json.js`.

### Bare Metal (systemd + nginx)

```bash
# Copy service file
sudo cp systemd/blackroad-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now blackroad-api

# Copy nginx config
sudo cp nginx/sites-available/blackroad.io /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/blackroad.io /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## CI/CD Workflows

| Workflow            | Trigger                 | Description                          |
|---------------------|-------------------------|--------------------------------------|
| **CORE CI**         | Push/PR to main/master  | Lint + test suite                    |
| **Deploy**          | Push to main            | Cloudflare Workers deploy            |
| **Auto Label**      | PR opened               | Labels PRs (core/labs)               |
| **CI Failure Tracker** | CI failure           | Creates issue on CI failure          |
| **Project Sync**    | PR opened/reopened      | Syncs PRs to GitHub project board    |

All GitHub Actions are **pinned to specific commit hashes** for supply-chain security.

## Required Secrets

| Secret                  | Used By        | Description                    |
|-------------------------|----------------|--------------------------------|
| `CLOUDFLARE_API_TOKEN`  | Deploy         | Cloudflare API token           |
| `CLOUDFLARE_ACCOUNT_ID` | Deploy         | Cloudflare account identifier  |
| `PROJECT_PAT`           | Project Sync   | PAT with project:write scope   |

## Required Variables

| Variable        | Used By | Description                              |
|-----------------|---------|------------------------------------------|
| `DEPLOY_TARGET` | Deploy  | Set to `cloudflare` or `all` to deploy   |

## Tech Stack

- **Runtime**: Node.js 20+
- **Framework**: Express 4.21.2
- **Security**: Helmet 8.0.0, CORS, rate limiting (120 req/min)
- **Edge**: Cloudflare Workers (`worker.js`)
- **Testing**: Node.js built-in test runner

## Security

- Rate limiting: 120 requests/minute per IP
- Helmet security headers
- JSON-only enforcement (415 for non-JSON write requests)
- CORS enabled
- Request body limit: 2 MB
- All dependencies pinned to exact versions
- GitHub Actions pinned to commit SHAs

## License

Proprietary. Copyright (c) 2025 BlackRoad OS, Inc. All rights reserved.
See [LICENSE](LICENSE) for details. This software is **not open source**.
Stripe products and other third-party assets are included under their respective terms.
