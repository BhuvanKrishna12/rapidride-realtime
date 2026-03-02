# RapidRide — Realtime Service

Handles the realtime side of a ride-booking app. Built with Socket.io, Redis, and JWT auth.

## What it does

- Matches riders to nearby drivers using Redis geospatial search
- Filters matches by vehicle type (car, bike, etc.)
- Prevents two drivers from accepting the same ride using a Redis distributed lock
- Streams live driver location to the rider during the trip
- Manages trip state: offered → accepted → in progress → completed
- Handles edge cases like driver disconnect, ride cancellation, and SOS alerts

## Stack

Node.js, Socket.io, Redis (ioredis), JWT, MongoDB

## Running locally

```bash
npm install
node index.js
```

Needs a `.env` with `REDIS_URL`, `JWT_SECRET`, and `MONGODB_URI`.
