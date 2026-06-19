// index.js
// Complete, self-contained Express server for Agricultural Notification App
// Uses Turso (LibSQL) for edge DB, node-cron for weather polling, Open-Meteo free API
// Run with: node index.js  (after setting .env)

require('dotenv').config();

const express = require('express');
const { createClient } = require('@libsql/client');
const cron = require('node-cron');
const Pusher = require('pusher');

// ============== CONFIG & INITIALIZATION ==============
const app = express();
app.use(express.json());

// Initialize Pusher client
let pusher = null;
if (process.env.PUSHER_APP_ID && process.env.PUSHER_KEY && process.env.PUSHER_SECRET && process.env.PUSHER_CLUSTER) {
  pusher = new Pusher({
    appId: process.env.PUSHER_APP_ID,
    key: process.env.PUSHER_KEY,
    secret: process.env.PUSHER_SECRET,
    cluster: process.env.PUSHER_CLUSTER,
    useTLS: true
  });
  console.log('✓ Pusher client initialized successfully');
} else {
  console.warn('⚠️ Pusher credentials missing in .env. Real-time alerts will be console-logged only.');
}

// Enable CORS for frontend API requests
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Environment variables (required)
const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  console.error('ERROR: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set in .env');
  process.exit(1);
}

// Initialize Turso client
const db = createClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN,
});

// ============== DATABASE SETUP ==============
async function initializeDatabase() {
  try {
    // Create farmers table if it doesn't exist
    // username is unique primary key for simple registration (no email/auth complexity)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS farmers (
        username TEXT PRIMARY KEY,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        rain_threshold REAL DEFAULT 15.0,
        wind_threshold REAL DEFAULT 20.0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Optional: Add index for faster queries (username already primary)
    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_farmers_location 
      ON farmers (latitude, longitude)
    `);

    console.log('✓ Database initialized: farmers table ready');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  }
}

// ============== FARMER REGISTRATION ENDPOINT ==============
app.post('/api/register-farm', async (req, res) => {
  try {
    const { username, latitude, longitude } = req.body;

    // Basic validation
    if (!username || typeof username !== 'string' || username.trim() === '') {
      return res.status(400).json({ 
        success: false, 
        error: 'username is required and must be a non-empty string' 
      });
    }

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);

    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json({ 
        success: false, 
        error: 'Valid latitude (-90 to 90) and longitude (-180 to 180) are required' 
      });
    }

    // UPSERT: Insert or update on username conflict (simple, no email auth)
    const result = await db.execute({
      sql: `
        INSERT INTO farmers (username, latitude, longitude, updated_at) 
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(username) DO UPDATE SET 
          latitude = excluded.latitude, 
          longitude = excluded.longitude,
          updated_at = CURRENT_TIMESTAMP
      `,
      args: [username.trim(), lat, lon]
    });

    console.log(`✓ Farmer registered/updated: ${username} at (${lat}, ${lon})`);

    res.json({
      success: true,
      message: 'Farmer registered successfully',
      data: {
        username: username.trim(),
        latitude: lat,
        longitude: lon,
        rain_threshold: 15,
        wind_threshold: 20
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to register farmer' 
    });
  }
});

// ============== WEATHER CRON JOB (every 2 hours) ==============
async function checkWeatherForAllFarmers() {
  console.log('\n🌾 [CRON] Starting weather check for all farmers...');

  try {
    // Query all registered farmers (include thresholds)
    const result = await db.execute(`
      SELECT 
        username, 
        latitude, 
        longitude, 
        COALESCE(rain_threshold, 15.0) as rain_threshold,
        COALESCE(wind_threshold, 20.0) as wind_threshold 
      FROM farmers
    `);

    const farmers = result.rows;

    if (!farmers || farmers.length === 0) {
      console.log('[CRON] No farmers registered yet.');
      return;
    }

    console.log(`[CRON] Checking weather for ${farmers.length} farmer(s)...`);

    // Loop through each farmer and fetch localized weather
    for (const farmer of farmers) {
      const { 
        username, 
        latitude, 
        longitude, 
        rain_threshold: rainThreshold, 
        wind_threshold: windThreshold 
      } = farmer;

      try {
        // Open-Meteo free API call (no API key required)
        // Current weather parameters requested: temperature_2m, precipitation, wind_speed_10m
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,precipitation,wind_speed_10m&timezone=auto`;

        const response = await fetch(weatherUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
          throw new Error(`Open-Meteo API error: ${response.status}`);
        }

        const weatherData = await response.json();
        const current = weatherData.current || {};

        const temperature = current.temperature_2m ?? null;
        const precipitation = current.precipitation ?? 0;
        const windSpeed = current.wind_speed_10m ?? 0;

        // ============== THRESHOLD LOGIC ==============
        const triggeredAlerts = [];

        // Rain threshold (mm)
        if (precipitation > rainThreshold) {
          triggeredAlerts.push({
            type: 'HEAVY_RAIN',
            value: precipitation,
            threshold: rainThreshold,
            unit: 'mm',
            message: `Heavy rainfall detected: ${precipitation}mm (threshold: ${rainThreshold}mm)`
          });
        }

        // Wind threshold (km/h)
        if (windSpeed > windThreshold) {
          triggeredAlerts.push({
            type: 'HIGH_WIND',
            value: windSpeed,
            threshold: windThreshold,
            unit: 'km/h',
            message: `High winds detected: ${windSpeed}km/h (threshold: ${windThreshold}km/h)`
          });
        }

        if (triggeredAlerts.length > 0) {
          // Structured alert payload
          const alertPayload = {
            username: username,
            timestamp: new Date().toISOString(),
            location: { latitude, longitude },
            currentWeather: {
              temperature: temperature,
              precipitation: precipitation,
              wind_speed: windSpeed
            },
            alerts: triggeredAlerts,
            thresholds: {
              rain: rainThreshold,
              wind: windThreshold
            }
          };

          // LOG THE ALERT (structured JSON)
          console.log('🚨 WEATHER ALERT TRIGGERED:');
          console.log(JSON.stringify(alertPayload, null, 2));

          // Broadcast via Pusher if initialized
          if (pusher) {
            try {
              await pusher.trigger(`channel-${username}`, 'weather-alert', alertPayload);
              console.log(`📡 Broadcasted weather-alert via Pusher to channel-${username}`);
            } catch (pusherError) {
              console.error(`❌ Pusher trigger failed for ${username}:`, pusherError.message);
            }
          }
        } else {
          // No thresholds met — stable weather
          console.log(
            `✅ Weather stable for ${username}: ` +
            `Temp: ${temperature}°C | Precip: ${precipitation}mm | Wind: ${windSpeed}km/h ` +
            `(thresholds: rain>${rainThreshold}mm, wind>${windThreshold}km/h)`
          );
        }

      } catch (fetchError) {
        console.error(`❌ Weather fetch failed for farmer ${username}:`, fetchError.message);
      }

      // Small delay between API calls to be respectful (optional but good practice)
      await new Promise(resolve => setTimeout(resolve, 150));
    }

    console.log('[CRON] Weather check cycle completed.\n');

  } catch (error) {
    console.error('[CRON] Error during weather check:', error);
  }
}

// Schedule the cron job: every hour (at minute 0 of every hour)
// Format: '0 * * * *' = At minute 0 past every hour
const weatherCron = cron.schedule('0 * * * *', checkWeatherForAllFarmers, {
  scheduled: false, // Start manually after DB init
  timezone: 'UTC'   // Use UTC for consistent agricultural timing globally
});

// ============== UTILITY ROUTES ==============
app.get('/', (req, res) => {
  res.json({
    message: 'Agricultural Notification API',
    status: 'running',
    endpoints: {
      register: 'POST /api/register-farm',
      health: 'GET /health'
    },
    cron: 'Weather checks every hour'
  });
});

app.get('/health', async (req, res) => {
  try {
    // Quick DB connectivity check
    const result = await db.execute('SELECT COUNT(*) as count FROM farmers');
    const farmerCount = result.rows[0]?.count || 0;

    res.json({
      status: 'healthy',
      database: 'connected',
      farmersRegistered: farmerCount,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'error',
      error: error.message
    });
  }
});

app.post('/api/trigger-test-alert', async (req, res) => {
  try {
    const { username, alertType, value } = req.body;

    if (!username) {
      return res.status(400).json({ success: false, error: 'username is required' });
    }

    // Retrieve farmer from DB to get location and thresholds
    const result = await db.execute({
      sql: 'SELECT latitude, longitude, rain_threshold, wind_threshold FROM farmers WHERE username = ?',
      args: [username]
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: `Farmer ${username} not found in database. Please register them first.` });
    }

    const { latitude, longitude, rain_threshold: rainThreshold, wind_threshold: windThreshold } = result.rows[0];

    const type = alertType || 'HEAVY_RAIN';
    const val = value !== undefined ? parseFloat(value) : (type === 'HEAVY_RAIN' ? rainThreshold + 5 : windThreshold + 5);
    const unit = type === 'HEAVY_RAIN' ? 'mm' : 'km/h';
    const msg = type === 'HEAVY_RAIN' 
      ? `TEST ALERT - Heavy rainfall detected: ${val}mm (threshold: ${rainThreshold}mm)`
      : `TEST ALERT - High winds detected: ${val}km/h (threshold: ${windThreshold}km/h)`;

    const alertPayload = {
      username: username,
      timestamp: new Date().toISOString(),
      location: { latitude, longitude },
      currentWeather: {
        temperature: 24.5,
        precipitation: type === 'HEAVY_RAIN' ? val : 0,
        wind_speed: type === 'HIGH_WIND' ? val : 10
      },
      alerts: [{
        type: type,
        value: val,
        threshold: type === 'HEAVY_RAIN' ? rainThreshold : windThreshold,
        unit: unit,
        message: msg
      }],
      thresholds: {
        rain: rainThreshold,
        wind: windThreshold
      }
    };

    console.log(`🚨 Triggering TEST ALERT for ${username} via Pusher:`);
    console.log(JSON.stringify(alertPayload, null, 2));

    if (pusher) {
      await pusher.trigger(`channel-${username}`, 'weather-alert', alertPayload);
      return res.json({ success: true, message: `Test alert sent successfully to channel-${username}`, data: alertPayload });
    } else {
      return res.status(503).json({ success: false, error: 'Pusher is not configured/initialized on backend' });
    }

  } catch (error) {
    console.error('Failed to trigger test alert:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/cron-check-weather', async (req, res) => {
  console.log('⏰ Vercel Cron trigger received: checking weather for all farmers...');
  try {
    // Run DB initialization if needed (Vercel serverless functions can be cold-started)
    await initializeDatabase();
    await checkWeatherForAllFarmers();
    res.json({ success: true, message: 'Weather check completed successfully' });
  } catch (error) {
    console.error('Vercel Cron weather check failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============== SERVER STARTUP ==============
async function startServer() {
  try {
    // Initialize DB first
    await initializeDatabase();

    // Start the weather monitoring cron only if not on Vercel
    if (!process.env.VERCEL) {
      weatherCron.start();
      console.log('✓ Cron job scheduled: Weather checks every hour');

      console.log('→ Running initial weather check on startup...');
      await checkWeatherForAllFarmers();

      // Start Express server
      const PORT = process.env.PORT || 3000;
      app.listen(PORT, () => {
        console.log(`\n🚀 Agricultural Notification Server running on http://localhost:${PORT}`);
        console.log(`   • Register farmers: POST /api/register-farm`);
        console.log(`   • Health check:     GET /health`);
        console.log(`   • Weather cron:     Every hour (UTC)`);
        console.log(`   • Database:         Turso (connected)\n`);
      });
    } else {
      console.log('✓ Running in Vercel Serverless environment (node-cron disabled, port listener handled by Vercel)');
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    if (!process.env.VERCEL) {
      process.exit(1);
    }
  }
}

// Graceful shutdown
if (!process.env.VERCEL) {
  process.on('SIGINT', () => {
    console.log('\nShutting down gracefully...');
    weatherCron.stop();
    process.exit(0);
  });
}

// Start everything
startServer();

module.exports = app; // For testing if needed