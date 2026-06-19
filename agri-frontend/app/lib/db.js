import { createClient } from '@libsql/client';

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

export const db = createClient({
  url: TURSO_DATABASE_URL || 'file:local.db',
  authToken: TURSO_AUTH_TOKEN || 'dummy-token',
});

export async function initializeDatabase() {
  try {
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

    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_farmers_location 
      ON farmers (latitude, longitude)
    `);
  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  }
}
