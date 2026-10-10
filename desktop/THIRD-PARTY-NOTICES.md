# Third-party software

Reel Studio application code is licensed under MIT. The following components have their own licenses. Their license files and npm package inventory accompany this application in the `licenses` directory.

- Electron: MIT. Electron distributions include Chromium and additional third-party notices (`LICENSE`, `LICENSES.chromium.html`). https://www.electronjs.org/
- Node.js: MIT and bundled third-party licenses; see `Node.js-LICENSE.txt`. https://nodejs.org/
- Remotion / @remotion packages: Remotion License, separate from MIT. Eligibility and company licensing: https://www.remotion.dev/license
- Remotion native compositor includes FFmpeg and its libraries under GPL. The renderer's upstream acknowledgements and source/build scripts are at https://www.remotion.dev/docs/acknowledgements . Corresponding-source requirements also apply to these binaries.
- Chrome Headless Shell: Chromium and included third-party licenses; its distribution files are preserved in `runtime/chrome`. https://developer.chrome.com/blog/chrome-headless-shell
- FFmpeg 9.0.2 full build by Gyan Doshi: GPL v3. See `FFmpeg-LICENSE` and `FFmpeg-README.txt` for license and full build configuration. Vendor: https://www.gyan.dev/ffmpeg/builds/ . FFmpeg source revision: https://github.com/FFmpeg/FFmpeg/commit/946fcce07b . This application invokes FFmpeg as an independent executable.
- Noto Serif JP: SIL Open Font License 1.1, see `Noto-Serif-JP-OFL.txt`.
- Other npm dependencies: see `app-packages.json`, `engine-packages.json`, and the corresponding package license files.

For public redistribution of the bundled GPL FFmpeg binaries, the distributor must provide the corresponding source and build materials for FFmpeg and its enabled third-party libraries in accordance with GPL v3. The vendor's source links and configuration are supplied for identification; they are not a replacement for a distributor's corresponding-source obligations. See the release instructions in `docs/desktop.md`.
