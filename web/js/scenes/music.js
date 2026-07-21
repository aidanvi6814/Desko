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
      E.art.onload = function () { applyArtAccent(E.art); };
      Promise.resolve().then(function () {
        if (!E.art) return;
        E.art.src = art;
        E.art.hidden = false;
        E.artBox.classList.add("has-art");
        if (E.brand) E.brand.style.display = "none";
        if (E.bg) {
          E.bg.style.backgroundImage = 'url("' + art + '")';
          E.bg.classList.add("visible");
        }
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

  // Distance-based dimming + active toggle (computed only on active change).
  function setActive(idx) {
    if (idx === activeIdx) return;
    activeIdx = idx;
    for (var j = 0; j < lines.length; j++) {
      var d = Math.abs(j - idx);
      lines[j].el.classList.toggle("active", d === 0);
      // Focus window: 1.0 at center, ~0.5 at ±1, ~0.28 at ±2, ~0.18 far.
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
      // A long/wrapped line (or the first line of a freshly-loaded track)
      // can land far from where we're currently scrolled — gliding a big
      // distance at the same per-frame percentage takes visibly longer and
      // reads as "lag", so snap those instantly instead of easing into them.
      // Normal one-line-to-the-next moves are small and still glide.
      if (Math.abs(targetTop - scrollCurrent) > 160) {
        scrollCurrent = targetTop;
        programmatic = true;
        stack.scrollTop = targetTop;
      }
    }
  }

  // The rAF loop: glides scrollCurrent toward scrollTarget whenever the user
  // isn't in manual-scroll mode. Cheap — one transform-equivalent assignment
  // per frame. Cancelled on onExit to save battery on a desk display.
  function glideStep() {
    if (!E.lyrics) { rafHandle = null; return; }
    var now = Date.now();
    if (now < manualScrollUntil) {
      // user is reading; freeze on their position
      scrollCurrent = E.lyrics.scrollTop;
      scrollTarget = scrollCurrent;
    } else {
      var diff = scrollTarget - scrollCurrent;
      if (Math.abs(diff) > 0.5) {
        // Critically-damped ease: each frame moves ~22% of the remaining distance.
        scrollCurrent += diff * 0.3;
        // Every glide-driven scrollTop write must be flagged programmatic —
        // without this, the 'scroll' event it fires gets treated as a user
        // drag by onUserScroll(), which immediately arms the 5s manual-freeze
        // and pins scrollTarget back to the barely-moved current position.
        // That self-triggering loop is what made the auto-centering stall
        // almost as soon as it started (reported as "lyrics don't scroll
        // down by themselves" / "smooth but laggy").
        programmatic = true;
        E.lyrics.scrollTop = scrollCurrent;
      } else {
        programmatic = true;
        E.lyrics.scrollTop = scrollTarget;
        scrollCurrent = scrollTarget;
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
    manualScrollUntil = Date.now() + 5000; // 5s auto-resume
    scrollCurrent = E.lyrics.scrollTop;
    // We don't move scrollTarget while the user is reading — it stays on the
    // last active line's target, so when the 5s expires the glide re-centers
    // on the (now possibly newer) active line.
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
  function wireTransport() {
    if (E.prev) E.prev.addEventListener("click", function () { sendCommand("prev"); });
    if (E.play) E.play.addEventListener("click", function () { sendCommand("play_pause"); });
    if (E.next) E.next.addEventListener("click", function () { sendCommand("next"); });
    if (E.lyrics) E.lyrics.addEventListener("scroll", onUserScroll, { passive: true });
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
      };
      renderedTrack = null;
      renderedLyricsKey = null;
      lastArtUrl = "";
      activeIdx = -1;
      scrollTarget = 0;
      scrollCurrent = 0;
      manualScrollUntil = 0;
      firstHighlight = true;
      wireTransport();
      this.onStateChange(state);
      this.onTick(state, Date.now());
      startGlide();
    },
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
      // #m-bg lives at the page level (so it can show through the system bar
      // too) — hide it on the way out so it doesn't keep bleeding through
      // that translucent bar while looking at a different scene.
      if (E.bg) E.bg.classList.remove("visible");
    },
  };
})();
