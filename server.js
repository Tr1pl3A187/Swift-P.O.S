// server.js — Production-Grade, Globally-Distributed POS Backend
// REVISION: v2.3 — Fixed static file serving for CSS/JS

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

/* -------------------------
   Environment Validation
   ------------------------- */
const requiredEnv = ['MONGODB_URI'];
if (process.env.NODE_ENV === 'production') {
  requiredEnv.push('JWT_SECRET', 'CORS_ORIGINS');
}
const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`💀 Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

/* -------------------------
   Mongoose Global Settings
   ------------------------- */
mongoose.set('strictQuery', false);

/* -------------------------
   Express & HTTP Server
   ------------------------- */
const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1);

/* -------------------------
   CORS — Bulletproof for Dev & Prod
   ------------------------- */
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim())
  : '*';

const corsOptions = {
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-store-id', 'idempotency-key']
};

if (process.env.NODE_ENV === 'production') {
  corsOptions.origin = corsOrigins;
  console.log('[CORS] Production mode — allowed origins:', corsOrigins);
} else {
  corsOptions.origin = function (origin, callback) {
    if (!origin) return callback(null, true);
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    if (corsOrigins === '*' || corsOrigins.includes(origin)) {
      return callback(null, true);
    }
    console.warn(`[CORS] Blocked origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  };
  console.log('[CORS] Development mode — allowing all localhost origins');
}

app.use(cors(corsOptions));

/* -------------------------
   Socket.IO — Resilient & Scoped
   ------------------------- */
const io = new Server(server, {
  cors: {
    origin: corsOptions.origin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  transports: ['websocket', 'polling'],
});

/* -------------------------
   Middleware
   ------------------------- */
app.use(express.json({ limit: '10kb' }));
app.use(
  morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev')
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 200 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});
app.use('/api/', apiLimiter);

app.use((req, res, next) => {
  req.io = io;
  next();
});

/* -------------------------
   Health Check
   ------------------------- */
app.get('/api/health', async (req, res) => {
  let dbHealthy = false;
  let pingError = null;

  try {
    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      await mongoose.connection.db.admin().ping();
      dbHealthy = true;
    }
  } catch (err) {
    dbHealthy = false;
    pingError = err.message;
  }

  res.status(dbHealthy ? 200 : 503).json({
    status: dbHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: {
      state: mongoose.connection.readyState,
      stateLabel:
        ['disconnected', 'connected', 'connecting', 'disconnecting'][
          mongoose.connection.readyState
        ] || 'unknown',
      pingError: pingError || undefined,
    },
    environment: process.env.NODE_ENV || 'development',
  });
});

/* -------------------------
   API Routes
   ------------------------- */
app.use('/api/categories', require('./routes/categories'));
app.use('/api/products', require('./routes/products'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/stock', require('./routes/stock'));

/* -------------------------
   API 404 Handler — JSON only
   ------------------------- */
app.use('/api/*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
});

/* -------------------------
   FIXED: Static Files — Serve CSS, JS, and pages from root
   ------------------------- */
// Serve css/ and js/ folders directly from project root
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/js', express.static(path.join(__dirname, 'js')));

// Serve public/ folder (for index.html and any other public assets)
app.use(express.static(path.join(__dirname, 'public')));

/* -------------------------
   FIXED: Page Routes — Point to correct paths
   ------------------------- */
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.get('/dashboard', (req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'dashboard.html'))
);

app.get('/inventory', (req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'inventory.html'))
);

app.get('/sales-history', (req, res) =>
  res.sendFile(path.join(__dirname, 'pages', 'sales-history.html'))
);

// Catch-all: redirect unknown routes to home
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

/* -------------------------
   Socket.IO — Auth & Multi-Tenant Isolation
   ------------------------- */
io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;
  if (process.env.NODE_ENV === 'production' && !token) {
    return next(new Error('Authentication required'));
  }
  socket.storeId = socket.handshake.query.storeId || 'default';
  next();
});

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id} | Store: ${socket.storeId}`);
  socket.join(`store:${socket.storeId}`);

  socket.on('disconnect', (reason) => {
    console.log(`🔌 Client disconnected: ${socket.id} | Reason: ${reason}`);
  });

  socket.on('error', (err) => {
    console.error(`💥 Socket error (${socket.id}):`, err);
  });
});

/* -------------------------
   MongoDB — Nuclear-Grade Configuration v2.0
   ------------------------- */
const MONGODB_URI = process.env.MONGODB_URI;

const mongooseOptions = {
  maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL_SIZE, 10) || 50,
  minPoolSize: parseInt(process.env.MONGODB_MIN_POOL_SIZE, 10) || 5,
  maxIdleTimeMS: parseInt(process.env.MONGODB_MAX_IDLE_TIME_MS, 10) || 300000,
  waitQueueTimeoutMS: parseInt(process.env.MONGODB_WAIT_QUEUE_TIMEOUT, 10) || 10000,
  serverSelectionTimeoutMS:
    parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT, 10) || 30000,
  connectTimeoutMS:
    parseInt(process.env.MONGODB_CONNECT_TIMEOUT, 10) || 10000,
  socketTimeoutMS:
    parseInt(process.env.MONGODB_SOCKET_TIMEOUT, 10) || 45000,
  heartbeatFrequencyMS:
    parseInt(process.env.MONGODB_HEARTBEAT_FREQUENCY, 10) || 5000,
  retryWrites: true,
  retryReads: true,
  w: 'majority',
  wtimeoutMS: 5000,
  journal: true,
  readPreference: process.env.MONGODB_READ_PREFERENCE || 'primaryPreferred',
  maxStalenessSeconds: 90,
  appName: process.env.MONGODB_APP_NAME || 'swiftpos-api',
  bufferCommands: false,
  autoIndex: process.env.NODE_ENV !== 'production',
};

const db = mongoose.connection;

db.on('connecting', () => console.log('⏳ MongoDB connecting...'));
db.on('connected', () => console.log('✅ MongoDB connected'));
db.on('open', () => {
  console.log('✅ MongoDB connection open');
  const client = mongoose.connection.getClient();
  if (client && client.options) {
    console.log('📊 MongoDB Pool Config:', {
      maxPoolSize: client.options.maxPoolSize,
      minPoolSize: client.options.minPoolSize,
      maxIdleTimeMS: client.options.maxIdleTimeMS,
      waitQueueTimeoutMS: client.options.waitQueueTimeoutMS,
    });
  }
});
db.on('disconnecting', () => console.log('⚠️ MongoDB disconnecting...'));
db.on('disconnected', () => console.log('❌ MongoDB disconnected'));
db.on('reconnected', () => console.log('🔄 MongoDB reconnected'));
db.on('error', (err) => console.error('💥 MongoDB connection error:', err));
db.on('close', () => console.log('🔒 MongoDB connection closed'));

db.once('open', () => {
  const client = mongoose.connection.getClient();
  client.on('connectionPoolCreated', (event) => {
    console.log('🏊 Pool created:', {
      maxPoolSize: event.options.maxPoolSize,
      minPoolSize: event.options.minPoolSize,
    });
  });
  client.on('connectionPoolClosed', () => {
    console.log('🏊 Pool closed');
  });
  client.on('connectionClosed', (event) => {
    console.log('🏊 Connection closed. Reason:', event.reason);
  });
});

/* -------------------------
   Connection Retry with Exponential Backoff
   ------------------------- */
async function connectWithRetry(maxRetries = 5, baseDelayMs = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (mongoose.connection.readyState !== 0) {
        console.log('🧹 Cleaning up stale connection before retry...');
        await mongoose.disconnect();
      }

      console.log(`🔄 MongoDB connection attempt ${attempt}/${maxRetries}...`);
      await mongoose.connect(MONGODB_URI, mongooseOptions);
      return;
    } catch (err) {
      console.error(`❌ MongoDB attempt ${attempt} failed:`, err.message);

      if (attempt === maxRetries) {
        console.error('💀 All MongoDB connection attempts exhausted.');
        throw err;
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.log(`⏳ Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/* -------------------------
   Graceful Shutdown
   ------------------------- */
function setupGracefulShutdown() {
  let isShuttingDown = false;

  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n${signal} received. Starting graceful shutdown...`);

    const forceExit = setTimeout(() => {
      console.error('💀 Graceful shutdown timed out. Forcing exit.');
      process.exit(1);
    }, 30000);

    try {
      await new Promise((resolve) => {
        server.close(() => {
          console.log('🛑 HTTP server closed');
          resolve();
        });
      });

      await new Promise((resolve) => {
        io.close(() => {
          console.log('🛑 Socket.IO server closed');
          resolve();
        });
      });

      await mongoose.disconnect();
      console.log('🛑 MongoDB disconnected');

      clearTimeout(forceExit);
      console.log('👋 Graceful shutdown complete.');
      process.exit(0);
    } catch (err) {
      console.error('❌ Error during graceful shutdown:', err);
      clearTimeout(forceExit);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  });
}

/* -------------------------
   Bootstrap
   ------------------------- */
async function bootstrap() {
  try {
    await connectWithRetry();
    setupGracefulShutdown();

    const port = Number(process.env.PORT) || 3000;
    server.listen(port, () => {
      console.log(
        `🚀 POS Server running on port ${port} | Env: ${
          process.env.NODE_ENV || 'development'
        }`
      );
    });
  } catch (err) {
    console.error('💀 Bootstrap failed:', err);
    process.exit(1);
  }
}

bootstrap();