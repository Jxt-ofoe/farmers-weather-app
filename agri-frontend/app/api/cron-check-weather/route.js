import { NextResponse } from 'next/server';
import { db, initializeDatabase } from '../../lib/db';
import { pusher } from '../../lib/pusher';

export async function GET(request) {
  console.log('\n🌾 [Vercel Cron] Starting weather check for all farmers...');

  try {
    // Ensure database is initialized
    await initializeDatabase();

    // Query all registered farmers
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
      return NextResponse.json({ success: true, message: 'No farmers registered yet.' });
    }

    console.log(`[CRON] Checking weather for ${farmers.length} farmer(s)...`);
    const summary = [];

    // Loop through each farmer and fetch weather
    for (const farmer of farmers) {
      const { 
        username, 
        latitude, 
        longitude, 
        rain_threshold: rainThreshold, 
        wind_threshold: windThreshold 
      } = farmer;

      try {
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

        // Threshold validation
        const triggeredAlerts = [];

        if (precipitation > rainThreshold) {
          triggeredAlerts.push({
            type: 'HEAVY_RAIN',
            value: precipitation,
            threshold: rainThreshold,
            unit: 'mm',
            message: `Heavy rainfall detected: ${precipitation}mm (threshold: ${rainThreshold}mm)`
          });
        }

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

          console.log(`🚨 WEATHER ALERT TRIGGERED for ${username}:`);
          console.log(JSON.stringify(alertPayload, null, 2));

          // Broadcast via Pusher if initialized
          if (pusher) {
            await pusher.trigger(`channel-${username}`, 'weather-alert', alertPayload);
            console.log(`📡 Broadcasted weather-alert via Pusher to channel-${username}`);
          }
          
          summary.push({ username, alert: true, details: triggeredAlerts });
        } else {
          console.log(`✅ Weather stable for ${username}: Temp: ${temperature}°C | Precip: ${precipitation}mm | Wind: ${windSpeed}km/h`);
          summary.push({ username, alert: false });
        }
      } catch (fetchError) {
        console.error(`❌ Weather fetch failed for farmer ${username}:`, fetchError.message);
        summary.push({ username, error: fetchError.message });
      }

      // Small delay between API calls to be respectful
      await new Promise(resolve => setTimeout(resolve, 150));
    }

    console.log('[CRON] Weather check cycle completed.\n');
    return NextResponse.json({ success: true, summary });

  } catch (error) {
    console.error('[CRON] Error during weather check:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
