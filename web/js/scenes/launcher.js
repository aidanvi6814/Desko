// Launcher (home) — BACK, status, desk scene, widget grid.
// All visuals are static SVG/CSS in index.html; this module just hooks behaviour.
Desko.scenes.launcher = (function () {
  return {
    onEnter: function (state) { /* nothing to render — all static */ },
    onExit: function () {},
    onTick: function (now) {
      // The terminal "cursor" in the monitor screen is a CSS animation, no JS needed.
    },
    onStateChange: function (state) {},
  };
})();
