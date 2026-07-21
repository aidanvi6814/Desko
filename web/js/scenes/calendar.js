// Calendar (Agenda) scene — upcoming events from configured .ics feeds
// (see desko/collectors/calendar_ics.py). Highlights the next event with a
// live countdown, then lists what's coming up.
Desko.scenes.calendar = (function () {
  var E = {};
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var nextEv = null;

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function hhmm(d) { return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
  function dayLabel(d) { return DOW[d.getDay()] + " " + d.getDate() + " " + MON[d.getMonth()]; }

  function isToday(d) {
    var n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }
  function isTomorrow(d) {
    var n = new Date(); n.setDate(n.getDate() + 1);
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }
  function dayPrefix(d) { return isToday(d) ? "Today" : isTomorrow(d) ? "Tomorrow" : dayLabel(d); }

  function fmtWhen(ev) {
    var s = new Date(ev.start * 1000);
    if (ev.allDay) return dayPrefix(s) + " · All day";
    var e = new Date(ev.end * 1000);
    return dayPrefix(s) + " · " + hhmm(s) + "–" + hhmm(e);
  }

  // Countdown to (or through) an event, in words.
  function countdown(ev, nowMs) {
    var startMs = ev.start * 1000, endMs = ev.end * 1000;
    if (nowMs >= startMs && nowMs < endMs) return ev.allDay ? "TODAY" : "IN PROGRESS";
    var diff = Math.round((startMs - nowMs) / 1000);
    if (diff < 0) return "";
    if (diff < 60) return "in " + diff + "s";
    var m = Math.floor(diff / 60);
    if (m < 60) return "in " + m + " min";
    var h = Math.floor(m / 60);
    if (h < 24) return "in " + h + "h " + (m % 60) + "m";
    var d = Math.floor(h / 24);
    return "in " + d + (d === 1 ? " day" : " days");
  }

  function render(state) {
    var cal = state.calendar;
    var events = (cal && cal.events) || [];
    nextEv = events.length ? events[0] : null;

    if (E.count) E.count.textContent = events.length ? events.length + " UPCOMING" : "—";

    if (!cal) {
      // section is null -> collector not configured/never reported
      if (E.nextTitle) E.nextTitle.textContent = "No calendar configured";
      if (E.nextWhen) E.nextWhen.textContent = "Add an .ics link on the /config page";
      if (E.nextLoc) E.nextLoc.textContent = "";
      if (E.nextIn) E.nextIn.textContent = "—";
      if (E.list) E.list.innerHTML = '<li class="agenda-empty">— no calendar configured —</li>';
      return;
    }
    if (!nextEv) {
      if (E.nextTitle) E.nextTitle.textContent = "Nothing scheduled";
      if (E.nextWhen) E.nextWhen.textContent = "Next 14 days are clear";
      if (E.nextLoc) E.nextLoc.textContent = "";
      if (E.nextIn) E.nextIn.textContent = "—";
      if (E.list) E.list.innerHTML = '<li class="agenda-empty">— nothing in the next 14 days —</li>';
      return;
    }

    if (E.nextTitle) E.nextTitle.textContent = nextEv.title || "(untitled)";
    if (E.nextWhen) E.nextWhen.textContent = fmtWhen(nextEv);
    if (E.nextLoc) E.nextLoc.textContent = nextEv.location || "";
    if (E.nextIn) E.nextIn.textContent = countdown(nextEv, Date.now());

    if (E.list) {
      var html = "";
      for (var i = 1; i < events.length; i++) {
        var ev = events[i];
        var s = new Date(ev.start * 1000);
        var time = ev.allDay ? "All day" : hhmm(s);
        var name = String(ev.title || "").replace(/[<>&]/g, "");
        html += '<li><span class="ag-day">' + dayPrefix(s) + '</span><span class="ag-time">' + time +
                '</span><span class="ag-title">' + name + "</span></li>";
      }
      if (!html) html = '<li class="agenda-empty">— nothing else coming up —</li>';
      E.list.innerHTML = html;
    }
  }

  return {
    onEnter: function (state) {
      E = {
        count: document.getElementById("c-count"),
        nextIn: document.getElementById("c-next-in"),
        nextTitle: document.getElementById("c-next-title"),
        nextWhen: document.getElementById("c-next-when"),
        nextLoc: document.getElementById("c-next-loc"),
        list: document.getElementById("c-list"),
      };
      render(state);
    },
    onStateChange: function (state) { render(state); },
    onTick: function (state, now) {
      // Just refresh the live countdown line; the list only changes on new data.
      if (nextEv && E.nextIn) E.nextIn.textContent = countdown(nextEv, now);
    },
    onExit: function () {},
  };
})();
