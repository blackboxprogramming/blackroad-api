# BlackRoad API

A lightweight, JSON-only REST API server built with Express.js.

> **Note:** This repository is from the `blackboxprogramming` organization. Development has moved to the **BlackRoad-OS** organization. See [Canonical Repositories](#canonical-repositories) below.

## Features

- JSON-only API with standardized response envelopes
- Full CRUD operations for Agents resource
- Input validation with Zod schemas
- Request ID tracing for all requests
- Rate limiting (configurable)
- Security headers via Helmet
- CORS support with configurable origins
- Graceful shutdown handling
- Auto-discovered route listing
- OpenAPI 3.1.0 specification
- Comprehensive test suite

## Quick Start

```bash
# Install dependencies
npm install

# Start development server (with auto-reload)
npm run dev

# Start production server
npm start
```

The API will be available at `http://localhost:4000`

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 4000 | Server port |
| `NODE_ENV` | production | Environment (development/production) |
| `API_VERSION` | 1.0.0 | API version shown in responses |
| `RATE_LIMIT_WINDOW_MS` | 60000 | Rate limit window (ms) |
| `RATE_LIMIT_MAX_REQUESTS` | 120 | Max requests per window |
| `CORS_ORIGINS` | * | Allowed origins (comma-separated) |

## API Endpoints

### Meta

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | API info and status |
| GET | `/api/health` | Health check |
| GET | `/api/status` | Server status (PID, memory, uptime) |
| GET | `/api/routes` | List all routes |
| GET | `/api/openapi.json` | OpenAPI specification |

### Agents CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents` | List all agents |
| GET | `/api/agents/:id` | Get agent by ID |
| POST | `/api/agents` | Create new agent |
| PUT | `/api/agents/:id` | Update agent |
| DELETE | `/api/agents/:id` | Delete agent |

### Utility

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/echo` | Echo request body |

## Response Format

All responses follow a standardized envelope:

```json
// Success
{
  "ok": true,
  "status": 200,
  "data": { ... },
  "meta": { ... }
}

// Error
{
  "ok": false,
  "status": 400,
  "error": {
    "message": "Error description",
    "details": { ... }
  }
}
```

## Request Tracing

All requests include an `X-Request-Id` header in responses. You can provide your own ID via the `X-Request-Id` request header.

## Development

```bash
# Run tests
npm test

# Run tests with watch mode
npm run test:watch

# Run linter
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format
```

## Deployment

### systemd

A systemd service file is provided in `systemd/blackroad-api.service`.

```bash
# Copy service file
sudo cp systemd/blackroad-api.service /etc/systemd/system/

# Enable and start
sudo systemctl enable blackroad-api
sudo systemctl start blackroad-api
```

### Nginx

An Nginx configuration is provided in `nginx/sites-available/blackroad.io`.

```bash
# Copy and link config
sudo cp nginx/sites-available/blackroad.io /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/blackroad.io /etc/nginx/sites-enabled/

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

## Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Express.js
- **Validation:** Zod
- **Security:** Helmet, CORS, Rate Limiting
- **Testing:** Jest, Supertest
- **Linting:** ESLint, Prettier

## Canonical Repositories

Development has moved to the BlackRoad-OS organization:

| Purpose | Repository |
|---------|------------|
| Core OS | [blackroad-os-core](https://github.com/BlackRoad-OS/blackroad-os-core) |
| Web / UI | [blackroad-os-web](https://github.com/BlackRoad-OS/blackroad-os-web) |
| Operator | [blackroad-os-operator](https://github.com/BlackRoad-OS/blackroad-os-operator) |
| Agents | [blackroad-os-agents](https://github.com/BlackRoad-OS/blackroad-os-agents) |
| API Gateway | [blackroad-os-api-gateway](https://github.com/BlackRoad-OS/blackroad-os-api-gateway) |
| Documentation | [blackroad-os-docs](https://github.com/BlackRoad-OS/blackroad-os-docs) |

## License

MIT
