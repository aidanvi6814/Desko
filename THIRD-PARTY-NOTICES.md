# Third-party notices

Desko itself is licensed under the Desko Noncommercial License 1.0 (see
[LICENSE](LICENSE)). This file covers material in this repository that someone
else wrote, and software Desko installs but does not redistribute.

---

## Bundled in this repository

### Geist Mono

- **Files:** `web/fonts/geist-mono-400.woff2`, `web/fonts/geist-mono-700.woff2`
- **Copyright:** Copyright 2023 Vercel, Inc.
- **License:** SIL Open Font License, Version 1.1, <https://openfontlicense.org>
- **Upstream:** <https://github.com/vercel/geist-font>

The OFL permits bundling and redistribution, including in commercial work, and
requires that this notice travel with the font files. The font is **not** sold on
its own and is **not** used as part of the name of this project, both of which
the OFL prohibits.

Note that the OFL is more permissive than Desko's own license. Nothing in
Desko's noncommercial terms restricts your separate rights to the font itself
under the OFL.

---

## Installed at runtime, not redistributed

### LibreHardwareMonitor

- **License:** Mozilla Public License 2.0, <https://www.mozilla.org/MPL/2.0/>
- **Upstream:** <https://github.com/LibreHardwareMonitor/LibreHardwareMonitor>

`scripts/setup-lhm.ps1` downloads an official release directly from that
project's GitHub releases into `%LOCALAPPDATA%\Desko\lhm` on your machine. No LHM
code is copied into this repository or shipped with it, so the MPL's
source-distribution obligations do not attach to Desko. Desko reads its published
WMI sensor data, which is ordinary interprocess use.

### Python dependencies

`aiohttp`, `psutil`, `qrcode`, `zeroconf`, `winsdk`, `wmi`, `pywin32`, `pycaw`
and `comtypes` are installed by pip from PyPI under their own licenses,
predominantly MIT, Apache-2.0, BSD and PSF. None are vendored here.

---

## Written for this project

`web/js/nosleep.min.js` is **original code**, despite a filename that suggests a
vendored copy of the NoSleep.js library. It is a small keep-awake shim written
for Desko: it uses the Screen Wake Lock API where available and otherwise falls
back to a hidden `<video>` fed by `canvas.captureStream()`. It carries no
third-party copyright and is covered by Desko's own license along with the rest
of the repository.

Everything else under `web/`, including the icons, the favicon, the stylesheet
and all JavaScript, was written for this project.
