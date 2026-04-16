# ECG Admin Panel — Backend API

REST API backend for the ECG Wearable Wellness Platform admin panel.

## Tech Stack

- **Runtime:** Node.js 20
- **Framework:** Express.js
- **Database:** MongoDB (Mongoose ODM)
- **Auth:** JWT (access + refresh token rotation)
- **Security:** Helmet, CORS, express-mongo-sanitize, rate limiting, bcrypt

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create your .env (copy and edit)
cp .env.example .env

# 3. Make sure MongoDB is running, then seed the database
node seed.js

# 4. Start the server
npm run dev     # development (nodemon)
npm start       # production
```

The server runs on `http://localhost:3001` by default.

## Seed Data

The seed script creates data that matches the frontend mock data exactly:

| Collection | Count | Notes |
|------------|-------|-------|
| Admins     | 2     | super_admin + client_admin |
| Users      | 47    | Same names, emails, IDs as frontend |
| Devices    | 32    | Same IDs, firmware, license status |
| Sessions   | 64    | Same durations, data sources, HR data |
| Licenses   | 32    | One per device, matching status |
| Readings   | 38,400 | 600 per session (ECG + temperature) |

**Default credentials:**
- Super Admin: `admin@ecgplatform.com` / `Admin123!`
- Client Admin: `client@ecgplatform.com` / `Client123!`

## API Endpoints

All endpoints under `/api/admin`. All require JWT except login.

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/admin/login` | Login, returns accessToken + sets refresh cookie |
| POST | `/api/admin/token/refresh` | Rotate tokens via httpOnly cookie |
| POST | `/api/admin/logout` | Clear refresh token |

### Users
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/users` | Paginated list (search, filter, sort) |
| GET | `/api/admin/users/:id` | User detail with devices + sessions |
| PUT | `/api/admin/users/:id/deactivate` | Deactivate user (audit logged) |
| PUT | `/api/admin/users/:id/reactivate` | Reactivate user (audit logged) |

### Sessions (Readings)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/readings` | Paginated session list |
| GET | `/api/admin/readings/:sessionId` | Full session with ECG/temp arrays |

### Devices
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/devices` | Paginated device list |
| GET | `/api/admin/devices/:id` | Device detail with license + sessions |
| PUT | `/api/admin/devices/:id/deactivate` | Deactivate (audit logged) |
| PUT | `/api/admin/devices/:id/reactivate` | Reactivate (audit logged) |
| POST | `/api/admin/devices/register` | Register new device (super_admin only) |

### Licenses
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/licenses` | Paginated license list |
| POST | `/api/admin/licenses/generate` | Generate key for a device |
| PUT | `/api/admin/licenses/:id/activate` | Activate license |
| PUT | `/api/admin/licenses/:id/deactivate` | Deactivate license |

### Dashboard
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/dashboard` | Summary metrics + trends |

### Export
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/export/:type` | CSV download (users, devices, licenses, sessions) |

## Response Format

All endpoints return:

```json
{
  "success": true,
  "data": { ... },
  "error": null,
  "pagination": {
    "page": 1,
    "limit": 25,
    "total": 47,
    "totalPages": 2
  }
}
```

## RBAC

- **super_admin:** Full access to all data across all clients
- **client_admin:** Automatically scoped to their own `clientId`

## Project Structure

```
backend/
├── src/
│   ├── config/          db.js, env.js
│   ├── middleware/       auth.js, rbac.js, rateLimiter.js, auditLogger.js
│   ├── models/          Admin, User, Session, Reading, Device, License, AuditLog
│   ├── routes/          adminAuth, users, sessions, devices, licenses, dashboard, export
│   ├── controllers/     Matching controllers for each route
│   ├── utils/           tokenUtils.js, csvExport.js
│   └── server.js
├── seed.js
├── .env.example
└── package.json
```
