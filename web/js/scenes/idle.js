// Idle scene — terminal-prompt clock + weather + link/uptime + ambient log.
Desko.scenes.idle = (function () {
  var E = {};
  var ICONS = {
    clear: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    clouds: '<path d="M17 18a4 4 0 0 0 0-8 6 6 0 0 0-11.6-1.5A4.5 4.5 0 0 0 6 18z"/>',
    fog: '<path d="M3 8h13M3 12h17M3 16h11M7 4h13"/>',
    rain: '<path d="M16 13a4 4 0 0 0 0-8 6 6 0 0 0-11.6-1.5A4.5 4.5 0 0 0 5 13z"/><line x1="8" y1="18" x2="7" y2="21"/><line x1="13" y1="17" x2="12" y2="22"/><line x1="18" y1="16" x2="17" y2="20"/>',
    snow: '<path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19"/>',
    storm: '<path d="M17 12a4 4 0 0 0 0-8 6 6 0 0 0-11.6-1.5A4.5 4.5 0 0 0 6 12z"/><polyline points="13 12 9 17 12 17 10 21"/>'
  };

  function renderWeather(w) {
    if (!w) { if (E.weather) E.weather.style.display = "none"; return; }
    if (E.weather) E.weather.style.display = "";
    if (E.wTemp) E.wTemp.textContent = (w.tempC != null ? Math.round(w.tempC) + "°" : "—");
    if (E.wFeels) {
      var cond = w.label || "—";
      E.wFeels.textContent = (w.feelsC != null ? cond + " · Feels " + Math.round(w.feelsC) + "°" : cond);
    }
    if (E.wCity) E.wCity.textContent = w.city || "—";
    if (E.wHilo) E.wHilo.innerHTML = "H " + (w.hiC != null ? Math.round(w.hiC) + "°" : "—") + "<br>L " + (w.loC != null ? Math.round(w.loC) + "°" : "—");
    if (E.wIcon) {
      var key = w.icon || "clear";
      E.wIcon.innerHTML = ICONS[key] || ICONS.clear;
    }
  }

  // The big clock is pinned to IST regardless of the phone's own system
  // timezone (a spare/secondhand device may have the wrong TZ set, or none
  // at all) — London time is shown underneath as a small secondary readout.
  function tzTime(date, timeZone) {
    var parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
    var out = {};
    parts.forEach(function (p) { out[p.type] = p.value; });
    return out;
  }

  function tickClock(now) {
    var d = new Date(now);
    var ist = tzTime(d, "Asia/Kolkata");
    if (E.clockHm) E.clockHm.textContent = ist.hour + ":" + ist.minute;
    if (E.clockS) E.clockS.textContent = ist.second;
    var uk = tzTime(d, "Europe/London");
    if (E.clockUk) E.clockUk.textContent = uk.hour + ":" + uk.minute;
    // Date follows IST too, so it doesn't flip a day early/late against the
    // big clock right above it around midnight.
    if (E.date) {
      var dateStr = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata", weekday: "long", month: "long", day: "2-digit",
      }).format(d);
      E.date.textContent = dateStr.toUpperCase();
    }
  }

  return {
    onEnter: function (state) {
      E = {
        clockBtn: document.getElementById("idle-clock-btn"),
        clockHm: document.getElementById("i-clock-hm"),
        clockS: document.getElementById("i-clock-s"),
        clockUk: document.getElementById("i-clock-uk"),
        date: document.getElementById("i-date"),
        weather: document.querySelector("#scene-idle .weather"),
        wIcon: document.getElementById("i-w-icon"),
        wTemp: document.getElementById("i-w-temp"),
        wFeels: document.getElementById("i-w-feels"),
        wHilo: document.getElementById("i-w-hilo"),
        wCity: document.getElementById("i-w-city"),
      };
      // Double-tap on the clock block opens the launcher
      if (E.clockBtn) {
        E.clockBtn.addEventListener("dblclick", function (e) { e.preventDefault(); Desko.openLauncher(); });
      }
      renderWeather(state.weather);
      tickClock(Date.now());
    },
    onStateChange: function (state) { renderWeather(state.weather); },
    onTick: function (state, now) { tickClock(now); },
    onExit: function () {},
    onDoubleTap: function () { Desko.openLauncher(); },
  };
})();
