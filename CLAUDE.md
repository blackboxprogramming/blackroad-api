# CLAUDE.md - AI Assistant Guidelines

## Repository Status

> **DEPRECATED**: This repository is archived and read-only. Active development has moved to the [BlackRoad-OS organization](https://github.com/BlackRoad-OS). See `README.md` and `ARCHIVED.md` for migration details.

The canonical replacement for this repo is: `BlackRoad-OS/blackroad-os-api`

---

## Project Overview

**blackroad-api** is a JSON-only REST API server built with Node.js and Express. It serves as a lightweight API gateway providing health checks, status endpoints, and agent management capabilities.

### Tech Stack

- **Runtime**: Node.js (CommonJS modules)
- **Framework**: Express.js 4.x
- **Security**: helmet, cors, express-rate-limit
- **Performance**: compression
- **Logging**: morgan (combined format)
- **Reverse Proxy**: nginx
- **Process Manager**: systemd

---

## Codebase Structure

```
blackroad-api/
├── server_json.js          # Main API server (single-file architecture)
├── package.json            # Node.js dependencies and scripts
├── nginx/
│   └── sites-available/
│       └── blackroad.io    # nginx reverse proxy configuration
├── systemd/
│   └── blackroad-api.service  # systemd unit file
├── README.md               # Deprecation notice
└── ARCHIVED.md             # Migration guide
```

### Key Files

| File | Purpose |
|------|---------|
| `server_json.js` | Complete API implementation (routes, middleware, helpers) |
| `package.json` | Dependencies: express, helmet, cors, compression, morgan, express-rate-limit |
| `nginx/sites-available/blackroad.io` | Reverse proxy config for blackroad.io domain |
| `systemd/blackroad-api.service` | Service config (runs on port 4000) |

---

## API Conventions

### Response Envelope

All responses follow a consistent JSON envelope:

```javascript
// Success (200, 201)
{ "ok": true, "status": 200, "data": {...}, "meta": {...} }

// Error (4xx, 5xx)
{ "ok": false, "status": 400, "error": { "message": "...", "details": {...} } }
```

### Helper Functions (in server_json.js)

- `send.ok(res, data, meta)` - 200 response
- `send.created(res, data, meta)` - 201 response
- `send.bad(res, message, details, status)` - 400/4xx error
- `send.notFound(res, path)` - 404 error
- `send.serverErr(res, err)` - 500 error

### Content-Type Requirements

- All responses are `application/json`
- POST/PUT/PATCH requests **must** send `Content-Type: application/json`
- Non-JSON content types receive 415 Unsupported Media Type

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | API root with name, version, status, uptime |
| GET | `/api/health` | Health check (`{ healthy: true }`) |
| GET | `/api/status` | Process status (pid, memory, uptime, env) |
| GET | `/api/routes` | List all available routes |
| GET | `/api/openapi.json` | OpenAPI 3.1.0 specification |
| GET | `/api/agents` | List agents (in-memory demo data) |
| POST | `/api/agents` | Create agent (requires `id`, `role` fields) |
| POST | `/api/echo` | Echo request body for testing |

---

## Development Workflow

### Running Locally

```bash
# Install dependencies
npm install

# Start the server (default port 4000)
npm start

# Or with custom port
PORT=3000 npm start
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | Server listen port |
| `NODE_ENV` | `production` | Environment mode |
| `API_VERSION` | `1.0.0` | Version shown in API root |

### Testing Endpoints

```bash
# Health check
curl http://localhost:4000/api/health

# Create agent (requires JSON content-type)
curl -X POST http://localhost:4000/api/agents \
  -H "Content-Type: application/json" \
  -d '{"id":"test","role":"worker"}'

# Echo test
curl -X POST http://localhost:4000/api/echo \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

---

## Deployment Configuration

### systemd Service

Located at `systemd/blackroad-api.service`:
- Runs as `www-data` user
- Working directory: `/srv/blackroad-api`
- Auto-restarts on failure (2 second delay)
- Starts after network target

### nginx Reverse Proxy

Located at `nginx/sites-available/blackroad.io`:
- Proxies all requests to `127.0.0.1:4000`
- Sets standard proxy headers (X-Real-IP, X-Forwarded-For, etc.)
- Adds security headers (X-Content-Type-Options, X-Frame-Options, etc.)
- Separate health check endpoint at `/health`

---

## Security Features

1. **Rate Limiting**: 120 requests/minute per IP
2. **Helmet**: Security headers (CSP disabled)
3. **CORS**: Enabled with credentials
4. **Trust Proxy**: Enabled for nginx forwarding
5. **JSON-Only**: Rejects non-JSON content types for write methods

---

## Conventions for AI Assistants

### Code Style

- Single-file architecture for the main server
- Use the existing `send.*` helper functions for all responses
- Follow the established response envelope pattern
- Keep middleware order: helmet -> cors -> compression -> morgan -> custom -> express.json -> rate-limit

### When Making Changes

1. **Preserve the response envelope** - Always use `send.*` helpers
2. **Update the `routes` array** when adding new endpoints
3. **Update the `openapi` object** when adding/modifying endpoints
4. **Maintain JSON-only enforcement** - Don't add non-JSON response types
5. **Test rate limiting** - Ensure new endpoints respect the existing limit

### Do NOT

- Add new dependencies without strong justification (this is a minimal API)
- Change the response envelope format (breaks client compatibility)
- Disable security middleware
- Add file uploads or non-JSON content types
- Create additional JS files (maintain single-file architecture)

### Important Notes

- In-memory data (`AGENTS` array) resets on restart - this is intentional for demo purposes
- The server trusts the proxy for IP addresses (`trust proxy: 1`)
- Morgan logs in combined format for production use

---

## Related Repositories (Active Development)

| Purpose | Repository |
|---------|------------|
| Core OS | [BlackRoad-OS/blackroad-os-core](https://github.com/BlackRoad-OS/blackroad-os-core) |
| API Gateway | [BlackRoad-OS/blackroad-os-api-gateway](https://github.com/BlackRoad-OS/blackroad-os-api-gateway) |
| Operator | [BlackRoad-OS/blackroad-os-operator](https://github.com/BlackRoad-OS/blackroad-os-operator) |
| Agents | [BlackRoad-OS/blackroad-os-agents](https://github.com/BlackRoad-OS/blackroad-os-agents) |
| Documentation | [BlackRoad-OS/blackroad-os-docs](https://github.com/BlackRoad-OS/blackroad-os-docs) |
