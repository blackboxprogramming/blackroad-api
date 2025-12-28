# BlackRoad API v2

A production-grade JSON REST API server built with Express.js, featuring authentication, SQLite persistence, and comprehensive observability.

> **Note:** This repository is from the `blackboxprogramming` organization. See [Canonical Repositories](#canonical-repositories) for the main BlackRoad-OS project.

## Features

### Core
- **JSON-only API** with standardized response envelopes
- **Full CRUD operations** for Agents resource
- **Input validation** with Zod schemas
- **SQLite persistence** with better-sqlite3

### Security
- **JWT Authentication** with Bearer tokens
- **API Key support** for service-to-service auth
- **Role-based authorization** (user/admin)
- **Rate limiting** (configurable per-endpoint)
- **Security headers** via Helmet
- **CORS support** with configurable origins

### Observability
- **Structured logging** with Pino
- **Request ID tracing** for all requests
- **Prometheus metrics** endpoint
- **Audit logging** for all mutations
- **Health checks** with database status

### Developer Experience
- **Swagger UI** for interactive API docs
- **OpenAPI 3.1.0** specification
- **API versioning** (/api/v1/)
- **Docker support** with docker-compose
- **Comprehensive test suite** with Jest

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
- API Documentation: `http://localhost:4000/docs`
- Metrics: `http://localhost:4000/metrics`

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 4000 | Server port |
| `NODE_ENV` | production | Environment |
| `DB_PATH` | ./data/blackroad.db | SQLite database path |
| `JWT_SECRET` | (random) | JWT signing secret (min 32 chars) |
| `JWT_EXPIRES_IN` | 24h | Token expiration |
| `RATE_LIMIT_MAX_REQUESTS` | 120 | Max requests per minute |
| `CORS_ORIGINS` | * | Allowed origins |
| `LOG_LEVEL` | info | Logging level |
| `METRICS_ENABLED` | true | Enable Prometheus metrics |

## API Endpoints

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | API info and status |
| GET | `/health` | Health check |
| GET | `/status` | Server status |
| GET | `/metrics` | Prometheus metrics |
| GET | `/routes` | List all routes |
| GET | `/docs` | Swagger UI |
| GET | `/openapi.json` | OpenAPI spec |

### Authentication (`/api/v1/auth`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/register` | - | Register new user |
| POST | `/login` | - | Login, get JWT token |
| GET | `/me` | Required | Get current user |
| POST | `/api-keys` | Required | Generate API key |
| POST | `/refresh` | Required | Refresh JWT token |

### Agents (`/api/v1/agents`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Optional | List agents (paginated) |
| GET | `/:id` | Optional | Get agent by ID |
| POST | `/` | Required | Create agent |
| PUT | `/:id` | Required | Update agent |
| PATCH | `/:id` | Required | Partial update |
| DELETE | `/:id` | Admin | Delete agent |

### Query Parameters (List Endpoints)

| Param | Type | Description |
|-------|------|-------------|
| `page` | int | Page number (default: 1) |
| `limit` | int | Items per page (max: 100, default: 20) |
| `sort` | string | Sort field (id, role, created_at) |
| `order` | asc/desc | Sort order |
| `role` | string | Filter by role |
| `active` | bool | Filter by active status |
| `search` | string | Search in id/role |

### Audit (`/api/v1/audit`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Admin | Get audit logs |

## Authentication

### JWT Token

```bash
# Register
curl -X POST http://localhost:4000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"myuser","password":"MyPass123"}'

# Login
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"myuser","password":"MyPass123"}'

# Use token
curl http://localhost:4000/api/v1/agents \
  -H "Authorization: Bearer <token>"
```

### API Key

```bash
# Generate API key (requires JWT auth)
curl -X POST http://localhost:4000/api/v1/auth/api-keys \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-service","expiresIn":"30d"}'

# Use API key
curl http://localhost:4000/api/v1/agents \
  -H "X-API-Key: br_..."
```

## Response Format

```json
// Success
{
  "ok": true,
  "status": 200,
  "data": { ... },
  "meta": {
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 100,
      "totalPages": 5,
      "hasNext": true,
      "hasPrev": false
    }
  }
}

// Error
{
  "ok": false,
  "status": 400,
  "error": {
    "message": "Validation failed",
    "details": { "errors": [...] }
  }
}
```

## Development

```bash
# Run tests
npm test

# Run tests with watch
npm run test:watch

# Lint code
npm run lint

# Format code
npm run format

# Reset database
npm run db:reset
```

## Docker

```bash
# Build image
npm run docker:build

# Run container
npm run docker:run

# Or use docker-compose
docker-compose up -d

# With nginx proxy
docker-compose --profile with-nginx up -d
```

## Deployment

### Docker (Recommended)

```bash
# Create .env file
cp .env.example .env
# Edit .env with production values

# Start with docker-compose
docker-compose up -d
```

### systemd

```bash
sudo cp systemd/blackroad-api.service /etc/systemd/system/
sudo systemctl enable blackroad-api
sudo systemctl start blackroad-api
```

### Nginx

```bash
sudo cp nginx/sites-available/blackroad.io /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/blackroad.io /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Express.js
- **Database:** SQLite (better-sqlite3)
- **Auth:** JWT (jsonwebtoken)
- **Validation:** Zod
- **Logging:** Pino
- **Docs:** Swagger UI
- **Testing:** Jest, Supertest
- **Containerization:** Docker

## Architecture

```
src/
├── app.js              # Main application entry
├── config/             # Configuration management
├── db/                 # Database layer (SQLite)
├── middleware/         # Express middleware
│   ├── auth.js        # JWT/API key authentication
│   ├── logger.js      # Request logging
│   └── metrics.js     # Prometheus metrics
├── routes/
│   └── v1/            # API v1 routes
│       ├── agents.js
│       ├── auth.js
│       └── audit.js
├── services/          # Business logic
│   ├── agent.service.js
│   ├── auth.service.js
│   └── audit.service.js
├── utils/             # Helpers
│   ├── response.js
│   └── validation.js
└── openapi.js         # OpenAPI specification
```

## Canonical Repositories

This is part of the BlackRoad ecosystem:

| Purpose | Repository |
|---------|------------|
| Core OS | [blackroad-os-core](https://github.com/BlackRoad-OS/blackroad-os-core) |
| Web / UI | [blackroad-os-web](https://github.com/BlackRoad-OS/blackroad-os-web) |
| Operator | [blackroad-os-operator](https://github.com/BlackRoad-OS/blackroad-os-operator) |
| Agents | [blackroad-os-agents](https://github.com/BlackRoad-OS/blackroad-os-agents) |
| API Gateway | [blackroad-os-api-gateway](https://github.com/BlackRoad-OS/blackroad-os-api-gateway) |

## License

MIT
