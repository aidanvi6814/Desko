// Music scene — small album art + compact track (with marquee title) + large
// readable lyrics (scrollable, scale-based active emphasis, distance dimming,
// rAF glide centering with 5s auto-resume after manual scroll).
Desko.scenes.music = (function () {
  var E = {};
  var lines = [];            // [{t, el}] for karaoke
  var renderedTrack = null;
  var renderedLyricsKey = null;
  var lastArtUrl = "";        // last artDataUrl we set on <img>
  var playing = false;
  var busy = false;           // transport debounce
  var activeIdx = -1;         // current highlighted line index
  var scrollTarget = 0;        // target scrollTop for karaoke centering
  var scrollCurrent = 0;       // current scrollTop (lerped)
  var manualScrollUntil = 0;   // Date.now() while user is in manual-scroll mode
  var rafHandle = null;        // rAF handle for the scroll glide
  var firstHighlight = true;   // guard for the rAF on first tick

  function fmt(sec) {
    if (!sec || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ":" + String(s).padStart(2, "0");
  }
  function effPos(state, now) {
    var m = state.media;
    if (!m) return 0;
    var p = m.positionSec || 0;
    if (m.playing && m.updatedAt) {
      // `now` is the client's Date.now(); `m.updatedAt` is a server epoch
      // timestamp. These only match when client and server share a clock
      // (e.g. testing in a PC browser) — on the phone they don't, which
      // biases every position/highlight calculation by the clock skew.
      // Corrected using the ws ping/pong offset app.js maintains.
      var offsetMs = (window.Desko && Desko.getClockOffsetMs) ? Desko.getClockOffsetMs() : 0;
      p += (now + offsetMs) / 1000 - m.updatedAt;
    }
    if (m.durationSec && p > m.durationSec) p = m.durationSec;
    if (p < 0) p = 0;
    return p;
  }

  function setArt(art) {
    if (!E.art || !E.artBox) return;
    if (art) {
      if (lastArtUrl && lastArtUrl === art) return; // same url, no-op
      E.art.removeAttribute("src");
      // Ambient album-art background is intentionally page-wide and shown on
      // EVERY scene, not just music. setArt runs on every media update (app.js
      // dispatches media/lyrics to music.onStateChange regardless of the active
      // scene), so the backdrop stays current and visible throughout Desko.
      // It's hidden again only when a track has no art / nothing is playing
      // (the else branch below). We build the ambient bg from a tiny downscaled
      // copy of the cover (setBgFromArt) rather than the full-res image, so the
      // CSS blur only has to smooth 64px instead of the whole cover.
      E.art.onload = function () { applyArtAccent(E.art); setBgFromArt(E.art, art); };
      Promise.resolve().then(function () {
        if (!E.art) return;
        E.art.src = art;
        E.art.hidden = false;
        E.artBox.classList.add("has-art");
        if (E.brand) E.brand.style.display = "none";
        lastArtUrl = art;
      });
    } else {
      E.art.removeAttribute("src");
      E.art.hidden = true;
      E.artBox.classList.remove("has-art");
      if (E.brand) E.brand.style.display = "";
      if (E.bg) { E.bg.classList.remove("visible"); }
      if (E.scene) E.scene.classList.remove("has-accent");
      lastArtUrl = "";
    }
  }

  // Ambient blurred backdrop, built from a 64px downscaled copy of the cover.
  // background-size:cover upscales this tiny canvas back to full screen, which
  // is itself a strong blur for free, so the CSS filter (see .music-bg) only
  // needs a small radius instead of a full-res blur(40px) — by far the biggest
  // GPU saving on the Realme 3. The cover is a same-origin data: URL so the
  // canvas isn't tainted; on any failure we fall back to the full-res image.
  function setBgFromArt(img, fallback) {
    if (!E.bg) return;
    var url = fallback;
    try {
      var c = document.createElement("canvas");
      c.width = 64; c.height = 64;
      c.getContext("2d").drawImage(img, 0, 0, 64, 64);
      url = c.toDataURL("image/jpeg", 0.6);
    } catch (e) { /* keep fallback */ }
    E.bg.style.backgroundImage = 'url("' + url + '")';
    E.bg.classList.add("visible");
  }

  // --- per-track accent from the album art -----------------------------------
  // Sample the cover down to a tiny canvas, average it, then punch up the
  // saturation and pin the lightness into a readable band so the derived
  // accent pops on the dark UI. The art is a same-origin data: URL, so the
  // canvas isn't tainted. Drives --music-accent (progress bar, active lyric,
  // labels) for a per-song "alive" feel, like YT Music's dynamic theming.
  function _rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), h = 0, s = 0, l = (mx + mn) / 2;
    if (mx !== mn) {
      var d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function _hslToRgb(h, s, l) {
    function hue(p, q, t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }
  function applyArtAccent(img) {
    if (!E.scene || !img) return;
    try {
      var c = document.createElement("canvas");
      c.width = 16; c.height = 16;
      var ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, 16, 16);
      var d = ctx.getImageData(0, 0, 16, 16).data;
      var r = 0, g = 0, b = 0, n = 0;
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 128) continue;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
      if (!n) { E.scene.classList.remove("has-accent"); return; }
      var hsl = _rgbToHsl(r / n, g / n, b / n);
      hsl[1] = Math.min(1, Math.max(0.55, hsl[1] * 1.5)); // punch saturation
      hsl[2] = Math.min(0.72, Math.max(0.55, hsl[2]));    // readable lightness
      var rgb = _hslToRgb(hsl[0], hsl[1], hsl[2]);
      E.scene.style.setProperty("--music-accent", "rgb(" + rgb[0] + " " + rgb[1] + " " + rgb[2] + ")");
      E.scene.classList.add("has-accent");
    } catch (e) {
      E.scene.classList.remove("has-accent");
    }
  }

  // --- title & eyebrow marquee -------------------------------------------------
  // Wrap the text in two identical spans inside a flex track; animate the track
  // by translateX(0 -> -50%) when it overflows. Duration is set per-element
  // so the scroll speed stays constant (~40px/s) regardless of title length.
  function setMarqueeText(hostEl, text) {
    if (!hostEl) return;
    var track = hostEl.querySelector(".marquee-content");
    if (!track) return;
    var spans = track.querySelectorAll(".track");
    if (!spans.length) return;
    // Skip when the text is unchanged. onStateChange re-runs on EVERY media
    // update — including the ~0.3s position patches — so without this guard we
    // strip and re-add .animating several times a second, restarting the scroll
    // from the start each time and leaving it visibly "stuck" near the front.
    if (spans[0].textContent === text) return;
    spans[0].textContent = text;
    spans[1].textContent = text; // duplicate for seamless loop
    // Remove the animating class so we re-measure cleanly.
    track.classList.remove("animating");
    track.style.removeProperty("--dur");
    // Measure after layout. Use rAF so widths are real.
    requestAnimationFrame(function () {
      // The marquee container's clientWidth is the visible clip area.
      var marqueeBox = hostEl.querySelector(".marquee");
      if (!marqueeBox) return;
      var visibleWidth = marqueeBox.clientWidth;
      // One track's natural width (we want to scroll it past the visible area).
      var trackWidth = spans[0].getBoundingClientRect().width;
      // Overflow condition: one track's text alone doesn't fit.
      if (trackWidth <= visibleWidth + 1) {
        return; // no overflow → no animation
      }
      // Speed ~ 40px/s; one full cycle scrolls 2 * trackWidth (two copies)
      // because the keyframe goes 0 -> -50% of the content (which is 2 tracks).
      // Total distance per cycle = trackWidth + gapPadding. We approximate
      // the per-track scroll distance as trackWidth.
      var pxPerSec = 40;
      var durSec = Math.max(6, (2 * trackWidth) / pxPerSec);
      track.style.setProperty("--dur", durSec.toFixed(2) + "s");
      track.classList.add("animating");
    });
  }

  function renderTrack(m) {
    if (!m) {
      if (E.title) setMarqueeText(E.title, "—");
      if (E.eyebrow) setMarqueeText(E.eyebrow, "— · —");
      if (E.state) E.state.textContent = "IDLE";
      setArt("");
      if (E.pos) E.pos.textContent = "0:00";
      if (E.dur) E.dur.textContent = "-0:00";
      if (E.fill) E.fill.style.width = "0%";
      playing = false;
      updatePlayIcon();
      return;
    }
    if (E.eyebrow) {
      var parts = [];
      if (m.artist) parts.push(m.artist);
      if (m.album) parts.push(m.album);
      setMarqueeText(E.eyebrow, (parts.join(" · ") || "—").toUpperCase());
    }
    if (E.title) setMarqueeText(E.title, m.title || "—");
    if (E.state) E.state.textContent = m.playing ? "PLAYING" : "PAUSED";
    setArt(m.artDataUrl || "");
    if (E.dur) E.dur.textContent = m.durationSec ? "-" + fmt(m.durationSec - (m.positionSec || 0)) : "-0:00";
    playing = !!m.playing;
    updatePlayIcon();
    updateSource(m.sourceApp);
  }

  function updateSource(app) {
    if (!E.source) return;
    var s = (app || "").toLowerCase();
    var label = "DESKO MEDIA · 320 KBPS";
    if (s.indexOf("brave") >= 0 || s.indexOf("chrome") >= 0 || s.indexOf("edge") >= 0 || s.indexOf("msedge") >= 0) label = "YOUTUBE MUSIC · 320 KBPS";
    else if (s.indexOf("spotify") >= 0) label = "SPOTIFY · 320 KBPS";
    else if (s) label = s.toUpperCase() + " · 320 KBPS";
    E.source.textContent = label;
  }

  function updatePlayIcon() {
    if (!E.playIcon) return;
    E.playIcon.innerHTML = playing
      ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
      : '<path d="M8 5v14l11-7z"/>';
  }

  function renderPlain(text) {
    if (E.lyrics) E.lyrics.innerHTML = "";
    lines = [];
    var blocks = String(text).split(/\n\s*\n/);
    blocks.forEach(function (block, bi) {
      var p = document.createElement("p");
      p.className = "plain";
      p.textContent = block.trim();
      E.lyrics.appendChild(p);
      if (bi < blocks.length - 1) {
        var sp = document.createElement("p");
        sp.className = "spacer";
        sp.innerHTML = "&nbsp;";
        E.lyrics.appendChild(sp);
      }
    });
  }

  function renderNotice(text) {
    if (E.lyrics) E.lyrics.innerHTML = "";
    lines = [];
    activeIdx = -1;
    if (E.lyrics) E.lyrics.scrollTop = 0;
    scrollTarget = 0;
    scrollCurrent = 0;
    var d = document.createElement("p");
    d.className = "none";
    d.textContent = text;
    if (E.lyrics) E.lyrics.appendChild(d);
    if (E.lyricsLine) E.lyricsLine.textContent = "—";
  }

  function renderLyrics(l) {
    if (E.lyrics) E.lyrics.innerHTML = "";
    lines = [];
    activeIdx = -1;
    if (E.lyrics) E.lyrics.scrollTop = 0;
    scrollTarget = 0;
    scrollCurrent = 0;
    if (!l || l.found === false) {
      var d = document.createElement("p");
      d.className = "none";
      d.textContent = "— no lyrics available for this track —";
      E.lyrics.appendChild(d);
      if (E.lyricsLine) E.lyricsLine.textContent = "—";
      return;
    }
    if (l.synced && l.synced.length) {
      l.synced.forEach(function (row) {
        var p = document.createElement("p");
        p.textContent = row[1] || "";
        p.className = "seekable";
        p.style.opacity = "0.18";
        (function (t) {
          p.addEventListener("click", function () { seekTo(t); });
        })(row[0]);
        E.lyrics.appendChild(p);
        lines.push({ t: row[0], el: p });
      });
      if (E.lyricsLine) E.lyricsLine.textContent = "1/" + lines.length;
    } else if (l.plain) {
      renderPlain(l.plain);
      if (E.lyricsLine) E.lyricsLine.textContent = "PLAIN";
    } else {
      var d = document.createElement("p");
      d.className = "none";
      d.textContent = "— no lyrics —";
      E.lyrics.appendChild(d);
    }
  }

  // Distance-based dimming + active toggle — only touches lines in the
  // visible cone around the old and new active index so per-tick DOM writes
  // stay cheap on lower-end phones (Realme 3).  Base opacity 0.18 is set
  // during renderLyrics for lines ≥3 away from active.
  function setActive(idx) {
    if (idx === activeIdx) return;
    var prev = activeIdx;
    activeIdx = idx;
    var lo = Math.min(prev < 0 ? idx : prev, idx) - 2;
    var hi = Math.max(prev < 0 ? idx : prev, idx) + 2;
    for (var j = 0; j < lines.length; j++) {
      if (j < lo || j > hi) continue;
      var d = Math.abs(j - idx);
      lines[j].el.classList.toggle("active", d === 0);
      lines[j].el.style.opacity = d === 0 ? 1 : Math.max(0.18, 0.6 - d * 0.16);
    }
    if (E.lyricsLine) E.lyricsLine.textContent = lines.length ? (idx + 1) + "/" + lines.length : "—";
    if (idx >= 0 && lines[idx]) {
      var stack = E.lyrics;
      var active = lines[idx].el;
      var targetTop = active.offsetTop - stack.clientHeight / 2 + active.clientHeight / 2;
      if (targetTop < 0) targetTop = 0;
      var maxScroll = stack.scrollHeight - stack.clientHeight;
      if (targetTop > maxScroll) targetTop = maxScroll;
      scrollTarget = targetTop;
      if (Math.abs(targetTop - scrollCurrent) > 160) {
        scrollCurrent = targetTop;
        programmatic = true;
        stack.scrollTop = targetTop;
      } else if (rafHandle == null && Math.abs(targetTop - scrollCurrent) > 0.5) {
        startGlide();
      }
    }
  }

  // The rAF loop: glides scrollCurrent toward scrollTarget whenever the user
  // isn't in manual-scroll mode.  Stops itself when idle (at target, no manual
  // freeze) to save CPU/battery on lower-end phones — setActive wakes it back
  // up when the highlight line changes.
  function glideStep() {
    if (!E.lyrics) { rafHandle = null; return; }
    var now = Date.now();
    if (now < manualScrollUntil) {
      scrollCurrent = E.lyrics.scrollTop;
      scrollTarget = scrollCurrent;
    } else {
      var diff = scrollTarget - scrollCurrent;
      if (Math.abs(diff) > 0.5) {
        scrollCurrent += diff * 0.3;
        programmatic = true;
        E.lyrics.scrollTop = scrollCurrent;
      } else {
        rafHandle = null;
        return;
      }
    }
    rafHandle = requestAnimationFrame(glideStep);
  }
  function startGlide() {
    if (rafHandle == null) rafHandle = requestAnimationFrame(glideStep);
  }
  function stopGlide() {
    if (rafHandle != null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  }

  // Distinguish a real user drag from our own scrollTop assignment. When we
  // set scrollTop programmatically, we set `programmatic = true` and the scroll
  // event handler ignores it.
  var programmatic = false;
  function onUserScroll() {
    if (programmatic) { programmatic = false; return; }
    manualScrollUntil = Date.now() + 3000; // 3s auto-resume
    scrollCurrent = E.lyrics.scrollTop;
    // We don't move scrollTarget while the user is reading — it stays on the
    // last active line's target, so when the 3s expires the glide re-centers
    // on the (now possibly newer) active line.
  }

  // Arm the manual-scroll freeze directly from the input event, NOT from the
  // 'scroll' event. Browsers coalesce scroll events to one per frame, so a
  // user drag that lands in the same frame as a glide's programmatic scrollTop
  // write collapses into a single 'scroll' event still flagged programmatic —
  // onUserScroll then swallows the user's drag and the next frame snaps back to
  // the active line, making the lyrics feel un-scrollable while a song plays.
  // touchstart/pointerdown/wheel are only ever real user input (the glide never
  // fires them), so arming here is unambiguous. Once armed, glideStep stops
  // writing scrollTop for 3s, so no programmatic events fire and subsequent
  // 'scroll' events during the drag re-arm the freeze correctly.
  function armManualScroll() {
    manualScrollUntil = Date.now() + 3000;
    if (E.lyrics) scrollCurrent = E.lyrics.scrollTop;
  }

  // Highlight slightly ahead of the raw computed position. LRC timestamps
  // mark when a line *starts*, but between the display processing the
  // update, the transition animation ramping up, and human reaction time,
  // a highlight that fires exactly on time reads as late. Only affects which
  // line is picked as active — the numeric position/progress bar in onTick
  // still uses the real, unadjusted position.
  var LYRIC_LEAD_SEC = 0.35;
  function highlight(pos) {
    if (!lines.length || !E.lyrics) return;
    var adjPos = pos + LYRIC_LEAD_SEC;
    var idx = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].t <= adjPos) idx = i;
      else break;
    }
    setActive(idx);
  }

  // Defer the first highlight to the next frame so clientHeight is real.
  function highlightSoon() { requestAnimationFrame(function () { highlight(lastPos); }); }
  var lastPos = 0;

  function sendCommand(action) {
    if (busy) return;
    busy = true;
    setTimeout(function () { busy = false; }, 180);
    fetch("/api/media/" + action, { method: "POST" })
      .then(function (r) { if (!r.ok) console.warn("media " + action + " -> " + r.status); })
      .catch(function () {});
  }

  // Tap a synced lyric line -> jump the track to that line's timestamp.
  function seekTo(sec) {
    if (typeof sec !== "number" || sec < 0) return;
    // Deliberate jump: drop the manual-scroll freeze so the glide recenters on
    // the new active line immediately, and highlight optimistically so the tap
    // feels instant (the server position patch confirms within ~0.3s).
    manualScrollUntil = 0;
    highlight(sec);
    fetch("/api/media/seek?pos=" + encodeURIComponent(sec.toFixed(3)), { method: "POST" })
      .then(function (r) { if (!r.ok) console.warn("seek -> " + r.status); })
      .catch(function () {});
  }

  // --- volume ----------------------------------------------------------------
  var volDragging = false;      // user has the slider grabbed; ignore server echoes
  var volSendTimer = null;      // throttle POSTs while dragging
  var pendingVol = null;
  function sendVolume(level) {
    pendingVol = level;
    if (volSendTimer) return;
    volSendTimer = setTimeout(function () {
      volSendTimer = null;
      if (pendingVol == null) return;
      var lv = pendingVol; pendingVol = null;
      fetch("/api/volume?level=" + lv, { method: "POST" }).catch(function () {});
    }, 90);
  }
  function volIconMarkup(level, muted) {
    var spk = '<path d="M3 10v4h4l5 5V5L7 10H3z"/>';
    if (muted || level === 0) {
      return spk + '<path d="M16 9l5 5M21 9l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
    }
    if (level < 50) {
      return spk + '<path d="M16 8a5 5 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
    }
    return spk + '<path d="M16 8a5 5 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M18.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
  }
  function updateMuteIcon(level, muted) {
    var m = volIconMarkup(level, muted);
    // Reflect state on BOTH the popover's mute toggle and the always-visible
    // transport speaker button, so you can see mute at a glance without opening.
    if (E.muteIcon) E.muteIcon.innerHTML = m;
    if (E.volBtnIcon) E.volBtnIcon.innerHTML = m;
  }

  // --- volume popover (open on demand, auto-hide) ----------------------------
  var volHideTimer = null;
  function armVolHide() {
    if (volHideTimer) clearTimeout(volHideTimer);
    volHideTimer = setTimeout(closeVolPop, 3500);  // vanish after inactivity
  }
  function onDocForVol(e) {
    if (!E.volRow) return;
    if (E.volRow.contains(e.target) || (E.volBtn && E.volBtn.contains(e.target))) return;
    closeVolPop();  // tap anywhere else dismisses it
  }
  function openVolPop() {
    if (!E.volRow) return;
    E.volRow.hidden = false;
    if (E.volBtn) E.volBtn.setAttribute("aria-expanded", "true");
    armVolHide();
    // Defer so the same tap that opened it doesn't immediately close it.
    setTimeout(function () { document.addEventListener("pointerdown", onDocForVol, true); }, 0);
  }
  function closeVolPop() {
    if (volHideTimer) { clearTimeout(volHideTimer); volHideTimer = null; }
    if (E.volRow) E.volRow.hidden = true;
    if (E.volBtn) E.volBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocForVol, true);
  }

  function renderVolume(state) {
    var v = state.volume;
    var has = !!v;
    // No pycaw / no audio endpoint -> hide the whole control (button + popover).
    if (E.volBtn) E.volBtn.hidden = !has;
    if (!has) { closeVolPop(); return; }
    var level = typeof v.level === "number" ? v.level : 0;
    var muted = !!v.muted;
    if (!volDragging && E.vol) E.vol.value = level;
    if (E.volPct) E.volPct.textContent = muted ? "MUTE" : (level + "%");
    updateMuteIcon(level, muted);
  }
  function wireVolume() {
    if (E.volBtn) E.volBtn.addEventListener("click", function () {
      if (E.volRow && E.volRow.hidden) openVolPop(); else closeVolPop();
    });
    if (E.vol) {
      E.vol.addEventListener("input", function () {
        volDragging = true;
        armVolHide();  // keep the popover up while adjusting
        var v = parseInt(E.vol.value, 10) || 0;
        if (E.volPct) E.volPct.textContent = v + "%";
        updateMuteIcon(v, false);
        sendVolume(v);
      });
      var release = function () { volDragging = false; armVolHide(); };
      E.vol.addEventListener("change", release);
      E.vol.addEventListener("pointerup", release);
      E.vol.addEventListener("touchend", release, { passive: true });
    }
    if (E.mute) E.mute.addEventListener("click", function () {
      armVolHide();
      fetch("/api/volume?mute=1", { method: "POST" }).catch(function () {});
    });
  }
  function wireTransport() {
    if (E.prev) E.prev.addEventListener("click", function () { sendCommand("prev"); });
    if (E.play) E.play.addEventListener("click", function () { sendCommand("play_pause"); });
    if (E.next) E.next.addEventListener("click", function () { sendCommand("next"); });
    if (E.lyrics) {
      E.lyrics.addEventListener("scroll", onUserScroll, { passive: true });
      // Freeze auto-centering the instant the user touches the list (see
      // armManualScroll) so the drag isn't fought by the glide loop.
      E.lyrics.addEventListener("touchstart", armManualScroll, { passive: true });
      E.lyrics.addEventListener("pointerdown", armManualScroll, { passive: true });
      E.lyrics.addEventListener("wheel", armManualScroll, { passive: true });
    }
  }

  return {
    onEnter: function (state) {
      E = {
        scene: document.querySelector('[data-scene="music"]'),
        bg: document.getElementById("m-bg"),
        artBox: document.getElementById("m-art-box"),
        art: document.getElementById("m-art"),
        brand: document.getElementById("m-brand"),
        title: document.getElementById("m-title"),
        eyebrow: document.getElementById("m-eyebrow"),
        state: document.getElementById("m-state"),
        source: document.getElementById("m-source"),
        pos: document.getElementById("m-pos"),
        dur: document.getElementById("m-dur"),
        fill: document.getElementById("m-fill"),
        lyrics: document.getElementById("m-lyrics"),
        lyricsLine: document.getElementById("m-lyrics-line"),
        prev: document.getElementById("t-prev"),
        play: document.getElementById("t-play"),
        playIcon: document.getElementById("t-play-icon"),
        next: document.getElementById("t-next"),
        volBtn: document.getElementById("t-vol-btn"),
        volBtnIcon: document.getElementById("t-vol-btn-icon"),
        volRow: document.getElementById("m-volume"),
        mute: document.getElementById("t-mute"),
        muteIcon: document.getElementById("t-mute-icon"),
        vol: document.getElementById("t-vol"),
        volPct: document.getElementById("m-vol-pct"),
      };
      renderedTrack = null;
      renderedLyricsKey = null;
      lastArtUrl = "";
      activeIdx = -1;
      scrollTarget = 0;
      scrollCurrent = 0;
      manualScrollUntil = 0;
      firstHighlight = true;
      volDragging = false;
      wireTransport();
      wireVolume();
      this.onStateChange(state);
      this.onVolume(state);
      this.onTick(state, Date.now());
      startGlide();
    },
    onVolume: function (state) { renderVolume(state); },
    onStateChange: function (state) {
      var m = state.media;
      var tk = m ? (m.artist + "||" + m.title) : null;
      if (tk !== renderedTrack) {
        renderedTrack = tk;
        renderTrack(m);
      } else if (m) {
        if (E.eyebrow) {
          var parts = [];
          if (m.artist) parts.push(m.artist);
          if (m.album) parts.push(m.album);
          setMarqueeText(E.eyebrow, (parts.join(" · ") || "—").toUpperCase());
        }
        if (E.title) setMarqueeText(E.title, m.title || "—");
        if (E.state) E.state.textContent = m.playing ? "PLAYING" : "PAUSED";
        playing = !!m.playing;
        updatePlayIcon();
        if ((m.artDataUrl || "") !== lastArtUrl) setArt(m.artDataUrl || "");
      }
      // Only ever show lyrics that belong to the *current* track. Until the
      // matching fetch lands, show a "loading" notice rather than the previous
      // song's lyrics (which would also get karaoke-highlighted against the
      // new song's position). This is the client half of the stale-lyrics fix.
      var l = state.lyrics;
      var matches = !!(l && tk && l.trackKey === tk);
      var lyricsKey = tk == null ? "__none__" : (matches ? l.trackKey : "__loading__" + tk);
      if (lyricsKey !== renderedLyricsKey) {
        renderedLyricsKey = lyricsKey;
        if (tk == null) renderNotice("— nothing playing —");
        else if (matches) renderLyrics(l);
        else renderNotice("— loading lyrics… —");
      }
    },
    onTick: function (state, now) {
      if (!state.media) { if (E.fill) E.fill.style.width = "0%"; return; }
      var pos = effPos(state, now);
      lastPos = pos;
      var dur = state.media.durationSec || 0;
      if (E.fill) E.fill.style.width = dur ? Math.min(100, (pos / dur) * 100) + "%" : "0%";
      if (E.pos) E.pos.textContent = fmt(pos);
      if (E.dur) E.dur.textContent = dur ? "-" + fmt(dur - pos) : "-0:00";
      if (E.state && state.media.playing != null) E.state.textContent = state.media.playing ? "PLAYING" : "PAUSED";
      if (firstHighlight) { firstHighlight = false; highlightSoon(); }
      else { highlight(pos); }
    },
    onExit: function () {
      stopGlide();
      closeVolPop();
      // Intentionally do NOT hide #m-bg here: the ambient album-art background
      // is meant to persist across every scene (see setArt), so it stays up
      // when we leave the music scene. setArt hides it on its own when a track
      // has no art / playback stops.
    },
  };
})();
