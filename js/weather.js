/* ═══════════════════════════════════════════════════════════════
   XRP TERMINAL v4 — CHIANG MAI WEATHER & US AQI (VECTOR SVG)
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const XRP = (root.XRP = root.XRP || {});
  const { CFG, cache, state, bus, api } = XRP;

  /* Crisp geometric SVG weather icons — consistent across Smart TVs, Linux, macOS, Windows & iOS */
  const SVG = {
    sun: '<svg class="svg-ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.4"/><path d="M12 2.5v2.3M12 19.2v2.3M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2.5 12h2.3M19.2 12h2.3M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/></svg>',
    partly:
      '<svg class="svg-ico" viewBox="0 0 24 24"><path d="M10 4.2v1.6M4.8 6.4l1.1 1.1M3.2 11.5h1.6M15.2 6.4l-1.1 1.1"/><path d="M7.2 13.4a3.6 3.6 0 0 1 6.1-3.1"/><path d="M7.5 19.2h9.8a3.7 3.7 0 0 0 .5-7.4 4.8 4.8 0 0 0-9.3 1.2 3.2 3.2 0 0 0-1 6.2Z"/></svg>',
    cloud:
      '<svg class="svg-ico" viewBox="0 0 24 24"><path d="M6.8 18.8h10.7a4 4 0 0 0 .6-7.9 5.4 5.4 0 0 0-10.5 1.3 3.6 3.6 0 0 0-.8 6.6Z"/></svg>',
    fog: '<svg class="svg-ico" viewBox="0 0 24 24"><path d="M6.8 14.5h10.6a3.6 3.6 0 0 0 .5-7.2 4.9 4.9 0 0 0-9.5 1.2 3.2 3.2 0 0 0-1.6 6Z"/><path d="M4.5 18h15M6.5 21h11"/></svg>',
    rain: '<svg class="svg-ico" viewBox="0 0 24 24"><path d="M6.8 15.2h10.5a3.7 3.7 0 0 0 .5-7.3 5 5 0 0 0-9.7 1.2 3.3 3.3 0 0 0-1.3 6.1Z"/><path d="M8.5 18.2l-1 2.8M12.5 18.2l-1 2.8M16.5 18.2l-1 2.8"/></svg>',
    storm:
      '<svg class="svg-ico" viewBox="0 0 24 24"><path d="M6.8 14.8h10.5a3.7 3.7 0 0 0 .5-7.3 5 5 0 0 0-9.7 1.2 3.3 3.3 0 0 0-1.3 6.1Z"/><path d="M13 15.2l-2.4 3.6h2.8l-1.6 3.4"/></svg>',
  };

  function wmoVisual(code) {
    if (code === 0) return { svg: SVG.sun, wet: false, desc: 'Clear sky' };
    if (code === 1 || code === 2) return { svg: SVG.partly, wet: false, desc: code === 1 ? 'Mainly clear' : 'Partly cloudy' };
    if (code === 3) return { svg: SVG.cloud, wet: false, desc: 'Overcast' };
    if (code === 45 || code === 48) return { svg: SVG.fog, wet: false, desc: 'Fog / Mist' };
    if (code >= 51 && code <= 82) {
      const desc = code <= 55 ? 'Drizzle' : code === 65 || code === 82 ? 'Heavy rain' : 'Rain showers';
      return { svg: SVG.rain, wet: true, desc };
    }
    if (code >= 95) return { svg: SVG.storm, wet: true, desc: 'Thunderstorm' };
    return { svg: SVG.partly, wet: false, desc: 'Fair' };
  }

  function aqiStyle(aqi) {
    if (aqi <= 50)  return { bg: 'rgba(16, 217, 132, 0.14)', border: 'rgba(16, 217, 132, 0.32)', dot: '#10d984', label: 'Good' };
    if (aqi <= 100) return { bg: 'rgba(242, 173, 51, 0.15)', border: 'rgba(242, 173, 51, 0.35)', dot: '#f2ad33', label: 'Moderate' };
    if (aqi <= 150) return { bg: 'rgba(255, 132, 42, 0.16)', border: 'rgba(255, 132, 42, 0.36)', dot: '#ff842a', label: 'Sensitive' };
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
      const vis = wmoVisual(h.weather_code[i]);
      const temp = Math.round(h.temperature_2m[i]);
      const pop = h.precipitation_probability?.[i] ?? 0;
      const wetCls = vis.wet || pop >= 40 ? ' wet' : '';
      html +=
        `<div class="hr-cell" title="${hh} · ${vis.desc} · ${pop}% precip">` +
        `<span class="hr-time">${hh}</span>` +
        `<span class="hr-mid"><span class="hr-ico${wetCls}">${vis.svg}</span><span class="hr-temp">${temp}°</span></span>` +
        `<span class="hr-pop${pop >= 35 ? ' wet' : ''}">${pop}%</span>` +
        `</div>`;
    }
    container.innerHTML = html;
  }

  function applyWeather(d, live) {
    if (!d?.current) return false;
    const temp = Math.round(d.current.temperature_2m);
    const feels = d.current.apparent_temperature != null ? Math.round(d.current.apparent_temperature) : null;
    const vis = wmoVisual(d.current.weather_code);
    const iconEl = document.getElementById('wxIcon');
    const tempEl = document.getElementById('wxTemp');
    const hiLoEl = document.getElementById('wxHiLo');
    const humEl = document.getElementById('wxHum');
    const humSubEl = document.getElementById('wxHumSub');

    if (iconEl) {
      iconEl.innerHTML = vis.svg;
      iconEl.classList.toggle('cool', vis.wet);
      iconEl.title = vis.desc + (feels != null ? ` · Feels like ${feels}°C` : '');
    }
    if (tempEl) tempEl.textContent = temp + '°C';
    if (humEl && d.current.relative_humidity_2m != null) {
      humEl.textContent = Math.round(d.current.relative_humidity_2m) + '%';
    }
    if (humSubEl) {
      const wind = d.current.wind_speed_10m;
      humSubEl.textContent = wind != null && Number.isFinite(+wind) ? `Hum · ${Math.round(+wind)}km/h` : 'Humidity';
    }
    if (hiLoEl && d.daily?.temperature_2m_max?.[0] != null) {
      hiLoEl.textContent =
        'H ' + Math.round(d.daily.temperature_2m_max[0]) + '° · L ' + Math.round(d.daily.temperature_2m_min[0]) + '°';
    }
    if (d.hourly?.time) buildHourly(d.hourly);
    if (live) {
      state.lastUpdate.weather = Date.now();
      state.sources.weather = 'Open-Meteo';
      cache.write('weather', d);
      bus.emit('weather:update');
    }
    return true;
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
          '&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m' +
          '&daily=temperature_2m_max,temperature_2m_min,weather_code' +
          '&hourly=temperature_2m,precipitation_probability,weather_code' +
          '&timezone=Asia%2FBangkok&forecast_days=2',
        8500
      );
    }
    if (d?.current) applyWeather(d, true);
  }

  function applyAqi(aqi, sourceLabel, live, pm25 = null) {
    if (!Number.isFinite(aqi) || aqi < 0) return false;
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
      const pmTxt = pm25 != null && Number.isFinite(+pm25) ? ` · PM2.5 ${(+pm25).toFixed(1)} µg/m³` : '';
      badge.title = `${sourceLabel || 'US AQI'} · ${Math.round(aqi)} (${style.label})${pmTxt}`;
    }
    if (lvl) lvl.textContent = style.label;
    if (sourceLabel) state.sources.aqi = sourceLabel;
    if (live) {
      state.lastUpdate.aqi = Date.now();
      cache.write('aqi', { aqi, pm25, src: sourceLabel || 'US AQI' });
      bus.emit('weather:update');
    }
    return true;
  }

  async function fetchAqi() {
    if (!state.lastUpdate.aqi) {
      const cached = cache.read('aqi', 3_600_000);
      if (cached?.value) {
        applyAqi(cached.value.aqi, cached.value.src, false, cached.value.pm25);
        state.lastUpdate.aqi = cached.at;
      }
    }

    if (await api.hasBackend()) {
      const b = await api.safeJson(`/api/aqi?lat=${CFG.LAT}&lon=${CFG.LON}`, 8000);
      if (Number.isFinite(b?.aqi)) {
        applyAqi(b.aqi, b.src || 'US AQI', true, b.pm25);
        return;
      }
    }

    if (CFG.IQAIR_KEY) {
      const iq = await api.safeJson(
        `https://api.airvisual.com/v2/nearest_city?lat=${CFG.LAT}&lon=${CFG.LON}&key=${encodeURIComponent(CFG.IQAIR_KEY)}`,
        9000
      );
      if (iq?.status === 'success' && Number.isFinite(iq.data?.current?.pollution?.aqius)) {
        applyAqi(iq.data.current.pollution.aqius, 'IQAir Chiang Mai', true);
        return;
      }
    }

    const om = await api.safeJson(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${CFG.LAT}&longitude=${CFG.LON}&current=us_aqi,pm2_5`,
      8000
    );
    if (Number.isFinite(om?.current?.us_aqi)) {
      applyAqi(om.current.us_aqi, 'Open-Meteo US AQI', true, om.current.pm2_5);
    }
  }

  XRP.weather = {
    applyWeather,
    applyAqi,
    fetchWeather,
    fetchAqi,
  };
})(window);
