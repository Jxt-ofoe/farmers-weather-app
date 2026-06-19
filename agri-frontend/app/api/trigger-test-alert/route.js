import { NextResponse } from 'next/server';
import { db, initializeDatabase } from '../../lib/db';
import { pusher } from '../../lib/pusher';

export async function POST(request) {
  try {
    const body = await request.json();
    const { username, alertType, value } = body;

    if (!username) {
      return NextResponse.json(
        { success: false, error: 'username is required' },
        { status: 400 }
      );
    }

    // Ensure database is initialized
    await initializeDatabase();

    // Retrieve farmer from DB to get location and thresholds
    const result = await db.execute({
      sql: 'SELECT latitude, longitude, rain_threshold, wind_threshold FROM farmers WHERE username = ?',
      args: [username]
    });

    if (result.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: `Farmer ${username} not found in database. Please register them first.` },
        { status: 404 }
      );
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
      return NextResponse.json({
        success: true,
        message: `Test alert sent successfully to channel-${username}`,
        data: alertPayload
      });
    } else {
      return NextResponse.json(
        { success: false, error: 'Pusher is not configured/initialized on backend' },
        { status: 503 }
      );
    }
  } catch (error) {
    console.error('Failed to trigger test alert:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
