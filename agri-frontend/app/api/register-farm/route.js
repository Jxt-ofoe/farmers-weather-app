import { NextResponse } from 'next/server';
import { db, initializeDatabase } from '../../lib/db';

export async function POST(request) {
  try {
    const body = await request.json();
    const { username, latitude, longitude } = body;

    // Basic validation
    if (!username || typeof username !== 'string' || username.trim() === '') {
      return NextResponse.json(
        { success: false, error: 'username is required and must be a non-empty string' },
        { status: 400 }
      );
    }

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);

    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return NextResponse.json(
        { success: false, error: 'Valid latitude (-90 to 90) and longitude (-180 to 180) are required' },
        { status: 400 }
      );
    }

    // Ensure database is initialized
    await initializeDatabase();

    // UPSERT: Insert or update on username conflict
    await db.execute({
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

    return NextResponse.json({
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
    return NextResponse.json(
      { success: false, error: 'Failed to register farmer' },
      { status: 500 }
    );
  }
}
