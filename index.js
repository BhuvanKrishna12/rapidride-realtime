const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const Trip = require('../models/Trip');
const logger = require('../utils/logger.js');

// Initialize Redis
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryStrategy: (times) => {
    return 5000; // Retry every 5 seconds
  },
});

redis.on('error', (err) => {
  logger.error('Redis connection error', {
    error: err.message,
    stack: err.stack,
  });
});

redis.on('connect', () => {
  logger.info('Redis connected successfully');
});

// ---- Helper functions to track driver online/offline ----
async function markDriverOnline(driverId, vehicleType = 'car') {
  const key = `driver:${driverId}`;
  const multi = redis.multi();
  multi.hset(
    key,
    'status',
    'online',
    'ts',
    Date.now(),
    'vehicleType',
    vehicleType
  );
  multi.sadd('online_drivers', driverId);
  // Also add to vehicle-specific set for filtering
  multi.sadd(`online_drivers:${vehicleType}`, driverId);
  await multi.exec();
}

async function markDriverOffline(driverId) {
  const key = `driver:${driverId}`;
  // Get vehicle type before removing
  const vehicleType = (await redis.hget(key, 'vehicleType')) || 'car';

  const multi = redis.multi();
  multi.hset(key, 'status', 'offline', 'ts', Date.now());
  multi.srem('online_drivers', driverId);
  // Also remove from vehicle-specific set
  multi.srem(`online_drivers:${vehicleType}`, driverId);
  // Also remove from geospatial index
  multi.zrem('drivers:locations', driverId);
  await multi.exec();
}

// Helper: safely parse lat/lng from various shapes
function parseLatLng(pickup) {
  if (!pickup) return { lat: null, lng: null };

  if (typeof pickup === 'object') {
    const lat = pickup.lat != null ? parseFloat(pickup.lat) : null;
    const lng = pickup.lng != null ? parseFloat(pickup.lng) : null;
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
      return { lat, lng };
    }
    return { lat: null, lng: null };
  }

  if (typeof pickup === 'string') {
    try {
      const p = JSON.parse(pickup);
      const lat = p.lat != null ? parseFloat(p.lat) : null;
      const lng = p.lng != null ? parseFloat(p.lng) : null;
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        return { lat, lng };
      }
    } catch (e) {
      return { lat: null, lng: null };
    }
  }

  return { lat: null, lng: null };
}

// Helper: GEO search using modern command (instead of deprecated GEORADIUS)
async function findNearbyDrivers(lng, lat, radiusKm = 10) {
  // Using raw command to avoid georadius deprecation issues
  // GEOSEARCH drivers:locations FROMLONLAT lng lat BYRADIUS radiusKm km
  const res = await redis.call(
    'GEOSEARCH',
    'drivers:locations',
    'FROMLONLAT',
    lng,
    lat,
    'BYRADIUS',
    radiusKm,
    'km'
  );
  // Returns array of driverIds
  return res || [];
}

const ACTIVE_LINK_TTL_SEC = 60 * 60; // 1 hour, adjust as needed

const initSockets = (server) => {
  const io = socketIo(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // Middleware for Auth
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) {
      logger.warn('Socket connection attempt without token', {
        socketId: socket.id,
      });
      return next(new Error('Authentication error'));
    }

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = { id: payload.id, role: payload.role };
      next();
    } catch (err) {
      logger.warn('Socket authentication failed', {
        error: err.message,
      });
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', async (socket) => {
    const { id: userId, role } = socket.user;
    logger.info('User connected via socket', {
      userId,
      role,
      socketId: socket.id,
    });

    if (role === 'driver') {
      // Track all sockets of this driver
      await redis.sadd(`sockets:driver:${userId}`, socket.id);
      socket.join(`driver:${userId}`);
      socket.join('drivers'); // Join all drivers room

      // Also join vehicle-specific room
      try {
        const Driver = require('../models/Driver');
        const driver = await Driver.findOne({ user: userId });
        const vehicleType =
          (driver && driver.vehicle && driver.vehicle.type) || 'car';
        socket.join(`drivers:${vehicleType}`);
        logger.info('Driver joined rooms', {
          driverId: userId,
          vehicleType,
        });
      } catch (err) {
        socket.join('drivers:car'); // Default to car
        console.log(
          `✅ Driver ${userId} joined 'drivers' and 'drivers:car' (default) rooms`
        );
      }

      // DEBUG: Show how many sockets are in the drivers room
      const driversRoom = io.sockets.adapter.rooms.get('drivers');
      // console.log(
      //   `📊 Drivers room now has ${driversRoom ? driversRoom.size : 0} sockets`
      // );
    } else {
      socket.join(`rider:${userId}`);
      logger.info('Rider joined room', {
        riderId: userId,
      });

      // Clear stale mappings for this rider on reconnect
      await redis.del(`rider:${userId}:active-driver`);
      await redis.del(`rider:${userId}:active-ride`);
    }

    // --- DRIVER EVENTS ---

    socket.on('driver-go-online', async () => {
      if (role !== 'driver') return;

      // Get driver's vehicle type from database
      let vehicleType = 'car';
      try {
        const Driver = require('../models/Driver');
        const driver = await Driver.findOne({ user: userId });
        if (driver && driver.vehicle && driver.vehicle.type) {
          vehicleType = driver.vehicle.type;
        }
      } catch (err) {
        console.error('Error fetching driver vehicle type:', err);
      }

      await markDriverOnline(userId, vehicleType);
      socket.emit('online-status', { online: true, vehicleType });
      logger.info('Driver went online', {
        driverId: userId,
        vehicleType,
      });
    });

    socket.on('driver-go-offline', async () => {
      if (role !== 'driver') return;
      await markDriverOffline(userId);
      socket.emit('online-status', { online: false });
      logger.info('Driver went offline', {
        driverId: userId,
      });
    });

    socket.on('location-update', async ({ lat, lng }) => {
      if (role !== 'driver') return;

      const parsedLat = lat != null ? parseFloat(lat) : null;
      const parsedLng = lng != null ? parseFloat(lng) : null;

      if (
        parsedLat == null ||
        parsedLng == null ||
        Number.isNaN(parsedLat) ||
        Number.isNaN(parsedLng)
      ) {
        logger.warn('Invalid driver location update', {
          driverId: userId,
          lat,
          lng,
        });

        return;
      }

      // console.log(
      //   `📍 Driver ${userId} location update: ${parsedLat}, ${parsedLng}`
      // );

      // Who is the rider connected to this driver?
      const riderId = await redis.get(`driver:${userId}:active-rider`);
      if (!riderId) {
        // If not in a ride, just update geospatial location for matching
        await redis.geoadd('drivers:locations', parsedLng, parsedLat, userId);
        await redis.hmset(`driver:${userId}:location`, {
          lat: parsedLat,
          lng: parsedLng,
          updatedAt: Date.now(),
        });
        return;
      }

      // Does this driver have an active ride?
      const rideId = await redis.get(`driver:${userId}:active-ride`);
      if (!rideId) return;

      const rideKey = `ride:${rideId}`;
      const ride = await redis.hgetall(rideKey);
      if (!ride || ride.status === 'completed' || ride.status === 'cancelled')
        return;

      // Store location (metadata)
      await redis.hmset(`driver:${userId}:location`, {
        lat: parsedLat,
        lng: parsedLng,
        updatedAt: Date.now(),
      });

      // Also update geospatial index
      await redis.geoadd('drivers:locations', parsedLng, parsedLat, userId);

      // Stream to rider
      io.to(`rider:${riderId}`).emit('driver-location', {
        lat: parsedLat,
        lng: parsedLng,
        driverId: userId,
      });
    });

    socket.on('accept-ride', async ({ rideId }) => {
      if (role !== 'driver') return;
      if (!rideId) {
        socket.emit('accept-failed', { rideId, reason: 'Invalid rideId' });
        return;
      }

      // Ensure driver is not already in a ride
      const existingRide = await redis.get(`driver:${userId}:active-ride`);
      if (existingRide) {
        socket.emit('accept-failed', {
          rideId,
          reason: 'Driver already has an active ride',
        });
        return;
      }

      // Try to lock the ride
      const lockKey = `ride:${rideId}:lock`;
      const lockTTL = 60; // seconds
      const success = await redis.set(lockKey, userId, 'NX', 'EX', lockTTL);

      if (success === null) {
        socket.emit('accept-failed', { rideId, reason: 'Already accepted' });
        return;
      }

      const rideKey = `ride:${rideId}`;
      const ride = await redis.hgetall(rideKey);

      if (!ride || !ride.riderId) {
        socket.emit('accept-failed', { rideId, reason: 'Ride not found' });
        return;
      }

      // Do not re-accept a non-offered ride
      if (ride.status && ride.status !== 'offered') {
        socket.emit('accept-failed', {
          rideId,
          reason: 'Ride no longer available',
        });
        return;
      }

      const riderId = ride.riderId;

      const now = Date.now();

      // Mark ride as accepted and set mappings atomically
      const multi = redis.multi();
      multi.hmset(rideKey, {
        status: 'accepted',
        driverId: userId,
        acceptedAt: now,
      });

      multi.set(
        `driver:${userId}:active-rider`,
        riderId,
        'EX',
        ACTIVE_LINK_TTL_SEC
      );
      multi.set(
        `rider:${riderId}:active-driver`,
        userId,
        'EX',
        ACTIVE_LINK_TTL_SEC
      );
      multi.set(
        `rider:${riderId}:active-ride`,
        rideId,
        'EX',
        ACTIVE_LINK_TTL_SEC
      );
      multi.set(
        `driver:${userId}:active-ride`,
        rideId,
        'EX',
        ACTIVE_LINK_TTL_SEC
      );

      await multi.exec();

      // Notify winning driver
      socket.emit('accept-success', { rideId, riderId, driverId: userId });

      // Fetch driver details to send to rider
      let driverInfo = {
        name: 'Driver',
        vehicle: null,
        rating: 5,
        totalTrips: 0,
      };
      try {
        const Driver = require('../models/Driver');
        const User = require('../models/User');
        const driver = await Driver.findOne({ user: userId });
        const user = await User.findById(userId);
        if (driver && user) {
          driverInfo = {
            name: user.name || 'Driver',
            vehicle: driver.vehicle || null,
            rating: driver.rating || 5,
            totalTrips: driver.totalTrips || 0,
          };
        }
      } catch (err) {
        console.error('Error fetching driver details:', err);
      }

      // Notify rider with driver details
      io.to(`rider:${riderId}`).emit('ride-accepted', {
        rideId,
        driverId: userId,
        driverName: driverInfo.name,
        vehicle: driverInfo.vehicle,
        driverRating: driverInfo.rating,
        driverTrips: driverInfo.totalTrips,
      });

      // Notify other drivers (they should treat this as "closed")
      socket.broadcast.to('drivers').emit('ride-closed', { rideId });

      logger.info('Ride accepted', {
        rideId,
        driverId: userId,
        riderId,
      });
    });

    socket.on('start-trip', async ({ tripId }) => {
      if (role !== 'driver') return;
      const rideKey = `ride:${tripId}`;
      const ride = await redis.hgetall(rideKey);

      if (ride && ride.riderId && ride.driverId === String(userId)) {
        await redis.hset(rideKey, 'status', 'in_progress');
        io.to(`rider:${ride.riderId}`).emit('trip_started', {
          message: 'Your ride has started!',
          tripId: tripId,
        });
        logger.info('Trip started', {
          tripId,
          driverId: userId,
        });
      } else {
        socket.emit('start-trip-failed', {
          tripId,
          reason: 'Invalid ride or driver',
        });
      }
    });

    // NEW: Handler for driver arrived at pickup
    socket.on('driver_arrived', async ({ tripId }) => {
      if (role !== 'driver') return;
      const rideKey = `ride:${tripId}`;
      const ride = await redis.hgetall(rideKey);

      if (ride && ride.riderId && ride.driverId === String(userId)) {
        await redis.hset(rideKey, 'status', 'driver_arrived');
        io.to(`rider:${ride.riderId}`).emit('driver_arrived', {
          message: 'Your driver has arrived!',
          tripId: tripId,
          driverId: userId,
        });
        console.log(`Driver ${userId} arrived at pickup for trip ${tripId}`);
      }
    });

    // NEW: Handler for SOS alerts
    socket.on(
      'sos_alert',
      async ({ tripId, userType, location, emergencyContact }) => {
        console.log(
          `🚨 SOS ALERT from ${userType} ${userId} for trip ${tripId}`
        );
        logger.error('SOS alert triggered', {
          tripId,
          userId,
          userType,
          location,
        });

        // Store emergency alert
        const alertData = {
          tripId,
          userId,
          userType,
          location: JSON.stringify(location),
          timestamp: Date.now(),
          status: 'active',
        };
        await redis.hset(`sos:${Date.now()}:${userId}`, alertData);

        // Notify relevant parties
        const rideKey = `ride:${tripId}`;
        const ride = await redis.hgetall(rideKey);

        if (ride) {
          // Notify the other party
          if (userType === 'driver' && ride.riderId) {
            io.to(`rider:${ride.riderId}`).emit('sos_triggered', {
              message: 'Driver has triggered an SOS!',
              tripId,
            });
          } else if (userType === 'rider' && ride.driverId) {
            io.to(`driver:${ride.driverId}`).emit('sos_triggered', {
              message: 'Rider has triggered an SOS!',
              tripId,
            });
          }
        }

        // Acknowledge
        socket.emit('sos_acknowledged', {
          tripId,
          message: 'SOS received. Help is on the way.',
        });
      }
    );

    async function completeRide(rideId, extraPayload = {}) {
      const rideKey = `ride:${rideId}`;
      const ride = await redis.hgetall(rideKey);

      if (!ride || ride.driverId !== String(userId)) {
        return { ok: false, reason: 'Invalid ride' };
      }

      const riderId = ride.riderId;

      // --- PERSISTENCE: Save to MongoDB ---
      try {
        // Parse Locations
        const parseLoc = (str) => {
          try {
            const parsed = JSON.parse(str);
            return {
              type: 'Point',
              coordinates: [
                parsed.lng || (parsed.coordinates ? parsed.coordinates[0] : 0),
                parsed.lat || (parsed.coordinates ? parsed.coordinates[1] : 0),
              ],
              address: parsed.address || parsed.name || 'Unknown Location',
            };
          } catch (e) {
            return {
              type: 'Point',
              coordinates: [0, 0],
              address: str || 'Unknown',
            };
          }
        };

        const start = parseInt(ride.acceptedAt || Date.now());
        const end = Date.now();
        const durationMins = Math.round((end - start) / 60000);

        // Safely parse numeric values to prevent NaN errors
        const safeParseFare = (val) => {
          const parsed = parseFloat(val);
          return isNaN(parsed) ? 0 : parsed;
        };

        const safeParseDistance = (val) => {
          // Handle "X km" format
          if (typeof val === 'string') {
            val = val.replace(/[^\d.]/g, ''); // Remove non-numeric chars except decimal
          }
          const parsed = parseFloat(val);
          return isNaN(parsed) ? 0 : parsed;
        };

        await Trip.create({
          rider: riderId,
          driver: userId,
          pickupLocation: parseLoc(ride.pickup),
          dropoffLocation: parseLoc(ride.drop),
          fare: safeParseFare(ride.fare),
          distance: safeParseDistance(ride.distance),
          status: 'completed',
          otp: Math.floor(1000 + Math.random() * 9000).toString(),
          duration: durationMins > 0 ? durationMins : 1,
          paymentStatus: 'pending',
          tripType: ride.vehicleType || 'car',
        });
        logger.info('Trip persisted to MongoDB', {
          rideId,
          driverId: userId,
        });
      } catch (dbErr) {
        logger.error('Failed to persist trip to MongoDB', {
          rideId,
          driverId: userId,
          error: dbErr.message,
          stack: dbErr.stack,
        });

        // We do NOT block the flow, just log error
      }

      const multi = redis.multi();
      multi.hmset(rideKey, {
        status: 'completed',
        completedAt: Date.now(),
        ...(extraPayload.rideFields || {}),
      });

      // Clear active mappings
      multi.del(`driver:${userId}:active-rider`);
      multi.del(`driver:${userId}:active-ride`);
      if (riderId) {
        multi.del(`rider:${riderId}:active-driver`);
        multi.del(`rider:${riderId}:active-ride`);
      }

      await multi.exec();

      return { ok: true, riderId, fare: ride.fare, distance: ride.distance };
    }

    socket.on('end-ride', async ({ rideId }) => {
      if (role !== 'driver') return;

      const result = await completeRide(rideId);
      if (!result.ok) {
        socket.emit('end-ride-failed', { rideId, reason: result.reason });
        return;
      }

      socket.emit('ride-ended', { rideId, fare: result.fare });
      if (result.riderId) {
        io.to(`rider:${result.riderId}`).emit('ride-ended', {
          rideId,
          driverId: userId,
          fare: result.fare,
          distance: result.distance,
        });
      }

      logger.info('Ride completed', {
        rideId,
        driverId: userId,
        fare: result.fare,
        distance: result.distance,
      });
    });

    // Legacy support if needed
    socket.on('end_trip', async (data) => {
      const rideId = data.tripId || data.rideId;
      if (role !== 'driver') return;
      const result = await completeRide(rideId, {
        rideFields: { fare: data.fare },
      });
      if (!result.ok) return;

      socket.emit('ride-ended', { rideId });
      if (result.riderId) {
        io.to(`rider:${result.riderId}`).emit('trip_ended', {
          message: 'Trip completed.',
          fare: data.fare,
          tripId: rideId,
        });
      }
    });

    // --- RIDER EVENTS ---

    socket.on('request-ride', async (rideData) => {
      if (role !== 'rider') return;

      const rideId = `ride-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const { pickup, drop, fare, distance, vehicleType } = rideData;
      const requestedVehicle = vehicleType || 'car'; // Default to car if not specified

      logger.info('Ride requested', {
        rideId,
        riderId: userId,
        vehicleType: requestedVehicle,
      });

      const { lat: pickupLat, lng: pickupLng } = parseLatLng(pickup);
      console.log(
        `🔍 Searching for ${requestedVehicle} drivers near: ${pickupLat}, ${pickupLng}`
      );

      // Standardize pickup/drop as JSON strings
      const pickupStr =
        typeof pickup === 'string' ? pickup : JSON.stringify(pickup || {});
      const dropStr =
        typeof drop === 'string' ? drop : JSON.stringify(drop || {});

      await redis.hmset(`ride:${rideId}`, {
        riderId: userId,
        pickup: pickupStr,
        drop: dropStr,
        fare: fare,
        distance: distance,
        vehicleType: requestedVehicle,
        status: 'offered',
        createdAt: Date.now(),
      });

      let nearbyDriverIds = [];

      if (
        pickupLat != null &&
        pickupLng != null &&
        !Number.isNaN(pickupLat) &&
        !Number.isNaN(pickupLng)
      ) {
        nearbyDriverIds = await findNearbyDrivers(pickupLng, pickupLat, 10);
      }

      // Filter nearby drivers by vehicle type
      if (nearbyDriverIds && nearbyDriverIds.length > 0) {
        const filteredDrivers = [];
        for (const driverId of nearbyDriverIds) {
          const driverVehicle = await redis.hget(
            `driver:${driverId}`,
            'vehicleType'
          );
          if (driverVehicle === requestedVehicle) {
            filteredDrivers.push(driverId);
          }
        }
        nearbyDriverIds = filteredDrivers;
      }

      if (!nearbyDriverIds || nearbyDriverIds.length === 0) {
        // Fallback: get online drivers with matching vehicle type
        nearbyDriverIds = await redis.smembers(
          `online_drivers:${requestedVehicle}`
        );
        console.log(
          `📋 Fallback: Found ${nearbyDriverIds ? nearbyDriverIds.length : 0} ${requestedVehicle} drivers online`
        );
      }

      if (!nearbyDriverIds || nearbyDriverIds.length === 0) {
        console.log(`⚠️ No online drivers found for ride ${rideId}`);
        socket.emit('no-drivers-available', { rideId });
        return;
      }

      // Prepare the ride offer payload
      const rideOfferPayload = {
        rideId,
        riderId: userId,
        pickup: pickupStr,
        drop: dropStr,
        fare,
        distance,
        vehicleType: requestedVehicle,
      };

      // Log the driver matching attempt
      console.log(
        `🔍 Found ${nearbyDriverIds.length} ${requestedVehicle} drivers:`,
        nearbyDriverIds
      );

      // Broadcast to individual driver sockets if found
      let sentCount = 0;
      for (const driverId of nearbyDriverIds) {
        const driverSocketIds = await redis.smembers(
          `sockets:driver:${driverId}`
        );
        console.log(`📡 Driver ${driverId} socket IDs:`, driverSocketIds);

        if (!driverSocketIds || driverSocketIds.length === 0) {
          console.log(`⚠️ No active socket IDs for driver ${driverId}`);
          continue;
        }

        for (const socketId of driverSocketIds) {
          io.to(socketId).emit('ride-offer', rideOfferPayload);
          sentCount++;
        }
      }

      // Broadcast ONLY to vehicle-specific room (strict filtering)
      const vehicleRoom = `drivers:${requestedVehicle}`;
      const roomSize = io.sockets.adapter.rooms.get(vehicleRoom)?.size || 0;
      console.log(
        `📢 Broadcasting ride-offer to '${vehicleRoom}' room (${roomSize} sockets)`
      );
      io.to(vehicleRoom).emit('ride-offer', rideOfferPayload);

      console.log(
        `✅ Ride ${rideId} (${requestedVehicle}) sent to ${sentCount} individual + ${vehicleRoom} room.`
      );
    });

    // Handler for rider cancelling the ride
    socket.on('rider-cancel-ride', async ({ rideId, riderId }) => {
      if (role !== 'rider') return;
      console.log(`🚫 Rider ${userId} cancelling ride ${rideId}`);

      const rideKey = `ride:${rideId}`;
      const ride = await redis.hgetall(rideKey);

      if (!ride) {
        console.log(`Ride ${rideId} not found for cancellation`);
        return;
      }

      const driverId = ride.driverId;

      // Update ride status to cancelled
      await redis.hset(
        rideKey,
        'status',
        'cancelled',
        'cancelledAt',
        Date.now(),
        'cancelledBy',
        'rider'
      );

      // Clear active mappings
      if (driverId) {
        await redis.del(`driver:${driverId}:active-rider`);
        await redis.del(`driver:${driverId}:active-ride`);

        // Notify the driver that the ride was cancelled
        io.to(`driver:${driverId}`).emit('ride-cancelled-by-rider', {
          rideId,
          message: 'The rider has cancelled this trip.',
          riderId: userId,
        });
        console.log(`✅ Notified driver ${driverId} about ride cancellation`);
      }

      // Clear rider mappings
      await redis.del(`rider:${userId}:active-driver`);
      await redis.del(`rider:${userId}:active-ride`);

      // Also broadcast to all drivers to remove this ride from their offers
      io.to('drivers').emit('ride-closed', { rideId });

      logger.info('Ride cancelled by rider', {
        rideId,
        riderId: userId,
      });
    });

    socket.on('get-trip-status', async ({ tripId }) => {
      console.log(`🔍 Checking status for trip: ${tripId}`);
      const ride = await redis.hgetall(`ride:${tripId}`);
      if (ride && ride.status) {
        console.log(`✅ Status found for ${tripId}: ${ride.status}`);
        socket.emit('trip-status', {
          status: ride.status,
          fare: ride.fare,
          rideId: tripId,
        });
      } else {
        console.log(`❌ No ride found for ${tripId}`);
        socket.emit('trip-status', {
          status: 'not_found',
          rideId: tripId,
        });
      }
    });

    // // SOS Alert Handler - Store in Redis for admin dashboard
    // socket.on('sos_alert', async (data) => {
    //   try {
    //     const sosId = `sos-${Date.now()}-${userId}`;
    //     const sosKey = `sos:${sosId}`;

    //     await redis.hmset(sosKey, {
    //       userId: userId,
    //       userName: user?.name || 'Unknown',
    //       userRole: role,
    //       type: data.type || 'SOS',
    //       message: data.message || 'Emergency SOS Alert',
    //       location: JSON.stringify(data.location || {}),
    //       rideId: data.rideId || '',
    //       timestamp: Date.now(),
    //       status: 'active',
    //     });

    //     // Set expiry for 24 hours
    //     await redis.expire(sosKey, 86400);

    //     console.log(`🚨 SOS Alert from ${role} ${userId}:`, sosId);

    //     // Emit to admin/support channels (if implemented)
    //     io.emit('admin-sos-alert', {
    //       id: sosId,
    //       userId,
    //       userName: user?.name,
    //       userRole: role,
    //       type: data.type || 'SOS',
    //       message: data.message || 'Emergency SOS Alert',
    //       location: data.location,
    //       timestamp: new Date(),
    //     });

    //     socket.emit('sos-confirmed', {
    //       sosId,
    //       message: 'SOS alert sent successfully',
    //     });
    //   } catch (err) {
    //     console.error('SOS alert error:', err);
    //     socket.emit('sos-error', { message: 'Failed to send SOS alert' });
    //   }
    // });

    socket.on('disconnect', async () => {
      if (role === 'driver') {
        await redis.srem(`sockets:driver:${userId}`, socket.id);
        const remaining = await redis.scard(`sockets:driver:${userId}`);

        if (remaining === 0) {
          // Mark offline and clean socket tracking.
          // DO NOT auto-end rides here; that should be explicit.
          await markDriverOffline(userId);
          await redis.del(`sockets:driver:${userId}`);
          console.log(`Driver ${userId} fully offline (no sockets)`);
        }
      }
      logger.info('Socket disconnected', {
        socketId: socket.id,
        userId,
        role,
      });
    });
  });

  return io;
};

module.exports = initSockets;
