'use client';

import React, { useState, useEffect } from 'react';
import Pusher from 'pusher-js';

// Tailwind-based minimalist agricultural UI
// Single file: app/page.js (Next.js App Router)

export default function AgriNotificationApp() {
  // State management
  const [username, setUsername] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [isOnboarded, setIsOnboarded] = useState(false);
  const [location, setLocation] = useState(null); // { latitude, longitude }
  const [alerts, setAlerts] = useState([]);
  const [currentAlert, setCurrentAlert] = useState(null);
  const [isLoadingLocation, setIsLoadingLocation] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [pusherStatus, setPusherStatus] = useState('disconnected');

  // Live weather state
  const [currentWeather, setCurrentWeather] = useState(null);
  const [isLoadingWeather, setIsLoadingWeather] = useState(false);
  const [lastUpdatedTime, setLastUpdatedTime] = useState(null);

  // Check localStorage on initial load
  useEffect(() => {
    const savedUsername = localStorage.getItem('agri_username');
    if (savedUsername) {
      setUsername(savedUsername);
      setIsOnboarded(true);
      const savedLoc = localStorage.getItem('agri_last_location');
      if (savedLoc) {
        try {
          setLocation(JSON.parse(savedLoc));
        } catch (e) {
          console.error('Failed to parse saved location', e);
        }
      }
    }
  }, []);

  // Fetch current weather based on coordinates
  useEffect(() => {
    if (!location) return;

    const fetchCurrentWeather = async () => {
      setIsLoadingWeather(true);
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,precipitation,wind_speed_10m,relative_humidity_2m,weather_code&timezone=auto`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          setCurrentWeather(data.current);
          setLastUpdatedTime(new Date());
        }
      } catch (err) {
        console.error('Failed to fetch current weather:', err);
      } finally {
        setIsLoadingWeather(false);
      }
    };

    fetchCurrentWeather();
    // Refresh weather every 5 minutes
    const interval = setInterval(fetchCurrentWeather, 300000);
    return () => clearInterval(interval);
  }, [location]);

  // Weather code to icon helper
  const getWeatherIcon = (code) => {
    if (code === 0) return '☀️';
    if ([1, 2, 3].includes(code)) return '⛅';
    if ([45, 48].includes(code)) return '🌫️';
    if ([51, 53, 55, 80, 81, 82].includes(code)) return '🌦️';
    if ([61, 63, 65].includes(code)) return '🌧️';
    if ([71, 73, 75].includes(code)) return '❄️';
    if ([95, 96, 99].includes(code)) return '⛈️';
    return '🌡️';
  };

  // Pusher Real-Time Integration
  useEffect(() => {
    if (!username || !isOnboarded) return;

    const pusherKey = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const pusherCluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER || 'us2';

    if (!pusherKey) {
      console.warn('⚠️ NEXT_PUBLIC_PUSHER_KEY is not set. Real-time alerts disabled.');
      setPusherStatus('no-key');
      return;
    }

    // Initialize Pusher
    const pusher = new Pusher(pusherKey, {
      cluster: pusherCluster,
      // For future private channels: 
      // authEndpoint: '/api/pusher-auth',
      // auth: { params: { username } }
    });

    const channelName = `channel-${username}`;
    const channel = pusher.subscribe(channelName);

    setPusherStatus('connected');

    // Listen for weather-alert events
    channel.bind('weather-alert', (data) => {
      console.log('🔔 Received weather-alert via Pusher:', data);

      // Add to alerts history (keep last 8)
      setAlerts((prev) => {
        const newAlerts = [data, ...prev];
        return newAlerts.slice(0, 8);
      });

      // Set prominent current alert
      setCurrentAlert(data);

      // Auto-clear current alert banner after 45 seconds
      setTimeout(() => {
        setCurrentAlert((current) => (current?.timestamp === data.timestamp ? null : current));
      }, 45000);
    });

    // Connection state logging
    pusher.connection.bind('connected', () => setPusherStatus('connected'));
    pusher.connection.bind('disconnected', () => setPusherStatus('disconnected'));
    pusher.connection.bind('error', (err) => {
      console.error('Pusher connection error:', err);
      setPusherStatus('error');
    });

    // Cleanup on unmount or username change
    return () => {
      channel.unbind_all();
      pusher.unsubscribe(channelName);
      pusher.disconnect();
      setPusherStatus('disconnected');
    };
  }, [username, isOnboarded]);

  // Clear messages after delay
  useEffect(() => {
    if (successMessage || errorMessage) {
      const timer = setTimeout(() => {
        setSuccessMessage('');
        setErrorMessage('');
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [successMessage, errorMessage]);

  // === ONBOARDING: Save username to localStorage ===
  const handleOnboard = (e) => {
    e.preventDefault();
    const trimmed = usernameInput.trim();
    
    if (!trimmed) {
      setErrorMessage('Please enter a unique username');
      return;
    }
    
    if (trimmed.length < 3) {
      setErrorMessage('Username must be at least 3 characters');
      return;
    }

    localStorage.setItem('agri_username', trimmed);
    setUsername(trimmed);
    setIsOnboarded(true);
    setUsernameInput('');
    setErrorMessage('');
  };

  // === GEOLOCATION + BACKEND REGISTRATION ===
  const handleSetFarmLocation = () => {
    if (!navigator.geolocation) {
      setErrorMessage('Geolocation is not supported by your browser');
      return;
    }

    setIsLoadingLocation(true);
    setErrorMessage('');
    setSuccessMessage('');

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        const newLocation = { latitude: parseFloat(latitude.toFixed(6)), longitude: parseFloat(longitude.toFixed(6)) };
        
        setLocation(newLocation);
        setIsLoadingLocation(false);

        // POST to Express backend
        await registerFarmLocation(newLocation);
      },
      (error) => {
        setIsLoadingLocation(false);
        let msg = 'Failed to get location. ';
        
        switch (error.code) {
          case error.PERMISSION_DENIED:
            msg += 'Please allow location access.';
            break;
          case error.POSITION_UNAVAILABLE:
            msg += 'Location information unavailable.';
            break;
          case error.TIMEOUT:
            msg += 'Request timed out.';
            break;
          default:
            msg += 'Unknown error.';
        }
        setErrorMessage(msg);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      }
    );
  };

  const registerFarmLocation = async (loc) => {
    setIsRegistering(true);
    
    try {
      const response = await fetch('/api/register-farm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username,
          latitude: loc.latitude,
          longitude: loc.longitude,
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setSuccessMessage(`✅ Farm location saved for ${username}!`);
        // Optional: store last location in localStorage
        localStorage.setItem('agri_last_location', JSON.stringify(loc));
      } else {
        setErrorMessage(data.error || 'Failed to register farm location');
      }
    } catch (err) {
      console.error('Registration error:', err);
      setErrorMessage('Could not connect to backend. Is the Express server running on port 3000?');
    } finally {
      setIsRegistering(false);
    }
  };

  // === LOGOUT / CLEAR STORAGE ===
  const handleLogout = () => {
    localStorage.removeItem('agri_username');
    localStorage.removeItem('agri_last_location');
    setUsername('');
    setIsOnboarded(false);
    setLocation(null);
    setAlerts([]);
    setCurrentAlert(null);
    setSuccessMessage('');
    setErrorMessage('');
    setPusherStatus('disconnected');
  };

  // Format timestamp for display
  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  // Render alert card content
  const renderAlertCard = (alertData, isProminent = false) => {
    if (!alertData) return null;

    const { alerts: alertList = [], currentWeather = {}, timestamp, location: alertLoc } = alertData;

    return (
      <div className={`rounded-xl border p-5 ${isProminent 
        ? 'bg-amber-50 border-amber-400 shadow-lg' 
        : 'bg-white border-slate-200 shadow-sm'}`}>
        
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">🌾</span>
              <span className="font-semibold text-lg text-slate-800">
                Weather Alert
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {formatTime(timestamp)} • {alertLoc ? `${alertLoc.latitude}, ${alertLoc.longitude}` : ''}
            </p>
          </div>
          {isProminent && (
            <span className="px-3 py-1 text-xs font-medium rounded-full bg-amber-200 text-amber-800">
              LIVE
            </span>
          )}
        </div>

        {/* Triggered Alerts */}
        <div className="space-y-2 mb-4">
          {alertList.length > 0 ? (
            alertList.map((alert, idx) => (
              <div key={idx} className="flex items-center gap-3 bg-white/70 p-3 rounded-lg border border-amber-200">
                <div className="text-2xl">
                  {alert.type === 'HEAVY_RAIN' ? '🌧️' : '💨'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-slate-800 text-sm">
                    {alert.message}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Current: {alert.value}{alert.unit} (threshold: {alert.threshold}{alert.unit})
                  </p>
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-slate-600">Alert received</p>
          )}
        </div>

        {/* Current Weather Snapshot */}
        {currentWeather && (
          <div className="grid grid-cols-3 gap-3 pt-3 border-t border-slate-100 text-center text-xs">
            <div>
              <div className="text-slate-500">Temp</div>
              <div className="font-semibold text-slate-700">{currentWeather.temperature ?? '—'}°C</div>
            </div>
            <div>
              <div className="text-slate-500">Rain</div>
              <div className="font-semibold text-slate-700">{currentWeather.precipitation ?? 0} mm</div>
            </div>
            <div>
              <div className="text-slate-500">Wind</div>
              <div className="font-semibold text-slate-700">{currentWeather.wind_speed ?? 0} km/h</div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // === RENDER: ONBOARDING SCREEN ===
  if (!isOnboarded) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-green-50 to-white flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white rounded-3xl shadow-xl p-8 border border-green-100">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-green-100 rounded-full mb-4">
              <span className="text-4xl">🌱</span>
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
              AgriNotify
            </h1>
            <p className="text-slate-600 mt-2 text-sm">
              Real-time weather alerts for your farm
            </p>
          </div>

          <form onSubmit={handleOnboard} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Your unique username
              </label>
              <input
                type="text"
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                placeholder="e.g. farmer_maria"
                className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent text-lg placeholder:text-slate-400"
                autoComplete="off"
              />
              <p className="text-xs text-slate-500 mt-1.5 px-1">
                This will be used for personalized alerts
              </p>
            </div>

            <button
              type="submit"
              className="w-full py-3.5 bg-green-700 hover:bg-green-800 active:bg-green-900 transition-colors text-white font-semibold rounded-2xl text-base shadow-sm"
            >
              Continue to Dashboard
            </button>
          </form>

          {errorMessage && (
            <p className="mt-4 text-center text-sm text-red-600 bg-red-50 p-3 rounded-xl">
              {errorMessage}
            </p>
          )}

          <div className="mt-8 pt-6 border-t border-slate-100 text-center">
            <p className="text-xs text-slate-400">
              Your username is stored only in your browser
            </p>
          </div>
        </div>
      </div>
    );
  }

  // === RENDER: DASHBOARD ===
  return (
    <div className="min-h-screen bg-slate-50">
      {/* Top Navigation */}
      <nav className="bg-white border-b border-slate-200 sticky top-0 z-50">
        <div className="max-w-3xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-2xl">🌾</span>
              <span className="font-semibold text-xl text-slate-900">AgriNotify</span>
            </div>
            <span className="text-xs px-2.5 py-1 rounded-full bg-green-100 text-green-700 font-medium tracking-wide">BETA</span>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center text-sm text-slate-600">
              <span className="font-medium">{username}</span>
            </div>
            <button
              onClick={handleLogout}
              className="text-sm px-4 py-1.5 rounded-full border border-slate-200 hover:bg-slate-100 active:bg-slate-200 text-slate-600 transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* Welcome Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-semibold text-slate-900 tracking-tighter">
            Welcome back, {username}
          </h1>
          <p className="text-slate-600 mt-1.5">Stay ahead of the weather on your farm</p>
        </div>

        {/* Status & Messages */}
        {(successMessage || errorMessage) && (
          <div className={`mb-6 p-4 rounded-2xl text-sm font-medium ${
            successMessage 
              ? 'bg-green-100 text-green-800 border border-green-200' 
              : 'bg-red-100 text-red-700 border border-red-200'
          }`}>
            {successMessage || errorMessage}
          </div>
        )}

        {/* Pusher Status (dev helper) */}
        <div className="mb-6 text-xs px-4 py-2.5 bg-slate-100 text-slate-700 border border-slate-200 rounded-2xl flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className={pusherStatus === 'connected' ? 'text-green-600 text-base animate-pulse' : 'text-amber-600 text-base animate-pulse'}>●</span>
            <span className="font-semibold text-slate-800">
              Pusher Real-time Alerts: <span className="capitalize">{pusherStatus}</span>
            </span>
          </div>
          <div className="font-mono text-[10px] text-slate-500">
            Client Key: {process.env.NEXT_PUBLIC_PUSHER_KEY || 'missing'} | Cluster: {process.env.NEXT_PUBLIC_PUSHER_CLUSTER || 'missing'}
          </div>
        </div>

        {/* 1. FARM LOCATION CARD */}
        <div className="bg-white rounded-3xl shadow-sm border border-slate-200 p-6 mb-8">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="font-semibold text-xl text-slate-900">Farm Location</h2>
              <p className="text-sm text-slate-500">Required for accurate weather alerts</p>
            </div>
          </div>

          {location ? (
            <div className="bg-green-50 border border-green-200 rounded-2xl p-4 mb-5">
              <div className="flex items-center gap-2 text-green-700">
                <span className="font-medium">📍 Location saved</span>
              </div>
              <div className="mt-2 font-mono text-sm text-slate-700">
                {location.latitude}° N, {location.longitude}° E
              </div>
            </div>
          ) : (
            <div className="text-sm text-slate-600 mb-5">
              Your farm coordinates haven’t been registered yet.
            </div>
          )}

          <button
            onClick={handleSetFarmLocation}
            disabled={isLoadingLocation || isRegistering}
            className="w-full flex items-center justify-center gap-3 py-3.5 bg-green-700 hover:bg-green-800 disabled:bg-green-300 transition-all text-white font-semibold rounded-2xl disabled:cursor-not-allowed active:scale-[0.985]"
          >
            {isLoadingLocation || isRegistering ? (
              <>
                <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                {isLoadingLocation ? 'Getting location...' : 'Registering...'}
              </>
            ) : (
              <>📍 Set Farm Location</>
            )}
          </button>

          <p className="text-center text-xs text-slate-500 mt-3">
            Uses your device’s precise GPS • Securely sent to backend
          </p>
        </div>

        {/* LIVE WEATHER CONDITIONS */}
        {location && (
          <div className="bg-white rounded-3xl shadow-sm border border-slate-200 p-6 mb-8">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold text-xl text-slate-900">Current Weather</h2>
                <p className="text-sm text-slate-500 flex flex-wrap items-center gap-x-2">
                  <span>Live conditions on your farm</span>
                  {lastUpdatedTime && (
                    <span className="text-xs text-slate-400 font-mono">
                      (Last updated: {lastUpdatedTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })})
                    </span>
                  )}
                </p>
              </div>
              {isLoadingWeather && (
                <div className="animate-spin h-4 w-4 border-2 border-green-700 border-t-transparent rounded-full" />
              )}
            </div>

            {currentWeather ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-2">
                <div className="bg-slate-50 p-4 rounded-2xl text-center border border-slate-100">
                  <span className="text-3xl block mb-2">{getWeatherIcon(currentWeather.weather_code)}</span>
                  <div className="text-xs font-medium text-slate-500">Condition</div>
                  <div className="font-semibold text-slate-800 text-base mt-0.5">
                    {currentWeather.weather_code === 0 ? 'Clear Sky' : 
                     [1,2,3].includes(currentWeather.weather_code) ? 'Cloudy' :
                     [45,48].includes(currentWeather.weather_code) ? 'Foggy' :
                     [51,53,55].includes(currentWeather.weather_code) ? 'Drizzle' :
                     [61,63,65].includes(currentWeather.weather_code) ? 'Rainy' :
                     [71,73,75].includes(currentWeather.weather_code) ? 'Snowy' :
                     [80,81,82].includes(currentWeather.weather_code) ? 'Showers' :
                     [95,96,99].includes(currentWeather.weather_code) ? 'Stormy' : 'Unknown'}
                  </div>
                </div>

                <div className="bg-slate-50 p-4 rounded-2xl text-center border border-slate-100">
                  <span className="text-3xl block mb-2">🌡️</span>
                  <div className="text-xs font-medium text-slate-500">Temperature</div>
                  <div className="font-semibold text-slate-800 text-lg mt-0.5">{currentWeather.temperature_2m ?? '—'}°C</div>
                </div>

                <div className="bg-slate-50 p-4 rounded-2xl text-center border border-slate-100">
                  <span className="text-3xl block mb-2">🌧️</span>
                  <div className="text-xs font-medium text-slate-500">Precipitation</div>
                  <div className="font-semibold text-slate-800 text-lg mt-0.5">{currentWeather.precipitation ?? 0} mm</div>
                </div>

                <div className="bg-slate-50 p-4 rounded-2xl text-center border border-slate-100">
                  <span className="text-3xl block mb-2">💨</span>
                  <div className="text-xs font-medium text-slate-500">Wind Speed</div>
                  <div className="font-semibold text-slate-800 text-lg mt-0.5">{currentWeather.wind_speed_10m ?? 0} km/h</div>
                </div>
              </div>
            ) : (
              <div className="text-center py-6 text-sm text-slate-500">
                Fetching weather data...
              </div>
            )}
          </div>
        )}

        {/* 2. REAL-TIME ALERTS — PROMINENT CARD */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4 px-1">
            <h2 className="font-semibold text-xl text-slate-900">Live Alerts</h2>
            {alerts.length > 0 && (
              <span className="text-xs font-medium text-slate-500">
                {alerts.length} alert{alerts.length > 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Prominent Notification Card */}
          {currentAlert ? (
            <div className="mb-4">
              {renderAlertCard(currentAlert, true)}
              <button 
                onClick={() => setCurrentAlert(null)}
                className="mt-2 text-xs text-amber-700 hover:text-amber-800 px-2 py-1"
              >
                Dismiss banner
              </button>
            </div>
          ) : (
            <div className="border border-dashed border-slate-300 rounded-3xl p-8 text-center bg-white">
              <div className="text-4xl mb-3 opacity-40">📡</div>
              <p className="text-slate-600 text-sm">No active alerts right now.</p>
              <p className="text-xs text-slate-400 mt-1">You’ll be notified instantly when thresholds are crossed.</p>
            </div>
          )}

          {/* Alerts History */}
          {alerts.length > 0 && (
            <div className="mt-8">
              <h3 className="text-sm font-medium text-slate-500 mb-3 px-1">Previous Alerts</h3>
              <div className="space-y-3">
                {alerts.slice(1).map((alert, index) => (
                  <div key={index}>
                    {renderAlertCard(alert, false)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer / Instructions */}
        <div className="mt-10 text-center">
          <div className="inline-block bg-white px-5 py-3 rounded-2xl border border-slate-200 text-xs text-slate-500">
            Backend must be running at <span className="font-mono">http://localhost:3000</span><br />
            Pusher channel: <span className="font-mono">channel-{username}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
