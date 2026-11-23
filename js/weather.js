/* ═══════════════════════════════════════════════════════════════
   XRP TERMINAL v3 — CHIANG MAI WEATHER & AIR QUALITY MODULE
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const XRP = (root.XRP = root.XRP || {});
  const { CFG, cache, state, bus, api } = XRP;

  const WMO_ICONS = {
    0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
    45: '🌫️', 48: '🌫️',
    51: '🌦️', 53: '🌦️', 55: '🌧️',
    61: '🌧️', 63: '🌧️', 65: '🌧️',
    80: '🌦️', 81: '🌧️', 82: '⛈️',
    95: '⛈️', 96: '⛈️', 99: '⛈️',
  };

  const WMO_DESC = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy showers',
    95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Severe storm',
  };

  function aqiStyle(aqi) {
    if (aqi <= 50)  return { bg: 'rgba(16, 217, 132, 0.14)', border: 'rgba(16, 217, 132, 0.3)', dot: '#10d984', label: 'Good' };
    if (aqi <= 100) return { bg: 'rgba(240, 184, 48, 0.15)', border: 'rgba(240, 184, 48, 0.34)', dot: '#f0b830', label: 'Moderate' };
    if (aqi <= 150) return { bg: 'rgba(255, 132, 42, 0.16)', border: 'rgba(255, 132, 42, 0.35)', dot: '#ff842a', label: 'Sensitive' };
    if (aqi <= 200) return { bg: 'rgba(244, 67, 93, 0.17)',  border: 'rgba(244, 67, 93, 0.38)',  dot: '#f4435d', label: 'Unhealthy' };
    if (aqi <= 300) return { bg: 'rgba(214, 72, 128, 0.2)',  border: 'rgba(214, 72, 128, 0.42)', dot: '#e85d92', label: 'Very Unhealthy' };
    return { bg: 'rgba(160, 28, 52, 0.3)', border: 'rgba(244, 67, 93, 0.5)', dot: '#ff5270', label: 'Hazardous' };
  }

  function buildHourly(h) {
    const container = document.getElementById('hourly');
    if (!container || !Array.isArray(h?.time)) return;

    const parts = {};
    new Intl.DateTimeFormat('en-CA', {
      timeZone: CFG.TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .forEach((p) => (parts[p.type] = p.value));

    const curKey = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
    const idx = h.time.indexOf(curKey);
    const start = idx >= 0 ? idx + 1 : (parseInt(parts.hour, 10) % 24) + 1;

    let html = '';
    for (let i = start; i < start + 8 && i < h.time.length; i++) {
      const hh = h.time[i].split('T')[1].slice(0, 5);
      const code = h.weather_code[i];
      const icon = WMO_ICONS[code] || '🌡️';
      const temp = Math.round(h.temperature_2m[i]);
      const pop = h.precipitation_probability?.[i] ?? 0;
      const desc = WMO_DESC[code] || '';
      html +=
        `<div class="hr-cell" title="${hh} · ${desc} · ${pop}% precip">` +
        `<span class="hr-time">${hh}</span>` +
        `<span class="hr-mid"><span class="hr-ico">${icon}</span><span class="hr-temp">${temp}°</span></span>` +
        `<span class="hr-pop${pop >= 40 ? ' wet' : ''}">${pop}%</span>` +
        `</div>`;
    }
    container.innerHTML = html;
  }

  function applyWeather(d, live) {
    if (!d?.current) return;
    const temp = Math.round(d.current.temperature_2m);
    const code = d.current.weather_code;
    const iconEl = document.getElementById('wxIcon');
    const tempEl = document.getElementById('wxTemp');
    const hiLoEl = document.getElementById('wxHiLo');
    const humEl = document.getElementById('wxHum');

    if (iconEl) {
      iconEl.textContent = WMO_ICONS[code] || '🌡️';
      iconEl.title = WMO_DESC[code] || '';
    }
    if (tempEl) tempEl.textContent = temp + '°C';
    if (humEl && d.current.relative_humidity_2m != null) {
      humEl.textContent = Math.round(d.current.relative_humidity_2m) + '%';
    }
    if (hiLoEl && d.daily?.temperature_2m_max?.[0] != null) {
      hiLoEl.textContent =
        'H ' + Math.round(d.daily.temperature_2m_max[0]) + '° · L ' + Math.round(d.daily.temperature_2m_min[0]) + '°';
    }
    if (d.hourly?.time) buildHourly(d.hourly);
    if (live) {
      state.lastUpdate.weather = Date.now();
      state.sources.weather = 'Open-Meteo';
      bus.emit('weather:update');
    }
  }

  async function fetchWeather() {
    if (!state.lastUpdate.weather) {
      const cached = cache.read('weather', 3_600_000);
      if (cached) {
        applyWeather(cached.value, false);
        state.lastUpdate.weather = cached.at;
      }
    }

    let d = null;
    if (await api.hasBackend()) {
      d = await api.safeJson(`/api/weather?lat=${CFG.LAT}&lon=${CFG.LON}`, 8000);
    }
    if (!d) {
      d = await api.safeJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${CFG.LAT}&longitude=${CFG.LON}` +
          '&current=temperature_2m,weather_code,relative_humidity_2m' +
          '&daily=temperature_2m_max,temperature_2m_min,weather_code' +
          '&hourly=temperature_2m,precipitation_probability,weather_code' +
          '&timezone=Asia%2FBangkok&forecast_days=2',
        8500
      );
    }
    if (d?.current) {
      cache.write('weather', d);
      applyWeather(d, true);
    }
  }

  function applyAqi(aqi, sourceLabel, live) {
    if (!Number.isFinite(aqi) || aqi < 0) return;
    const style = aqiStyle(aqi);
    const badge = document.getElementById('aqiBadge');
    const dot = document.getElementById('aqiDot');
    const val = document.getElementById('aqiVal');
    const lvl = document.getElementById('aqiLevel');
    if (val) val.textContent = String(Math.round(aqi));
    if (dot) dot.style.background = style.dot;
    if (badge) {
      badge.style.background = style.bg;
      badge.style.borderColor = style.border;
      badge.style.color = style.dot;
      badge.title = `${sourceLabel || 'US AQI'} · ${Math.round(aqi)} (${style.label})`;
    }
    if (lvl) lvl.textContent = style.label;
    if (sourceLabel) state.sources.aqi = sourceLabel;
    if (live) {
      state.lastUpdate.aqi = Date.now();
      bus.emit('weather:update');
    }
  }

  async function fetchAqi() {
    if (!state.lastUpdate.aqi) {
      const cached = cache.read('aqi', 3_600_000);
      if (cached?.value) {
        applyAqi(cached.value.aqi, cached.value.src, false);
        state.lastUpdate.aqi = cached.at;
      }
    }

    if (await api.hasBackend()) {
      const b = await api.safeJson(`/api/aqi?lat=${CFG.LAT}&lon=${CFG.LON}`, 8000);
      if (Number.isFinite(b?.aqi)) {
        cache.write('aqi', { aqi: b.aqi, src: b.src || 'US AQI' });
        applyAqi(b.aqi, b.src || 'US AQI', true);
        return;
      }
    }

    if (CFG.IQAIR_KEY) {
      const iq = await api.safeJson(
        `https://api.airvisual.com/v2/nearest_city?lat=${CFG.LAT}&lon=${CFG.LON}&key=${encodeURIComponent(CFG.IQAIR_KEY)}`,
        9000
      );
      if (iq?.status === 'success' && Number.isFinite(iq.data?.current?.pollution?.aqius)) {
        const aqi = iq.data.current.pollution.aqius;
        cache.write('aqi', { aqi, src: 'IQAir Chiang Mai' });
        applyAqi(aqi, 'IQAir Chiang Mai', true);
        return;
      }
    }

    const om = await api.safeJson(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${CFG.LAT}&longitude=${CFG.LON}&current=us_aqi`,
      8000
    );
    if (Number.isFinite(om?.current?.us_aqi)) {
      const aqi = om.current.us_aqi;
      cache.write('aqi', { aqi, src: 'Open-Meteo US AQI' });
      applyAqi(aqi, 'Open-Meteo US AQI', true);
    }
  }

  XRP.weather = {
    fetchWeather,
    fetchAqi,
  };
})(window);
