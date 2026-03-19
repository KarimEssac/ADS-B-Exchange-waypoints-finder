# Installation – macOS

1. Download and extract `ADSB_Waypoints_v1.1_MacOS.zip`
   - Double-click the zip to extract (Finder will handle this automatically)
   - If you see a `__MACOSX` folder alongside the extension folder, ignore it — it's a macOS metadata artifact
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked**
5. Select the extracted `ADSB_Waypoints_v1.1` folder (not `__MACOSX`)
6. Navigate to [ADS-B Exchange](https://globe.adsbexchange.com/) and click the extension icon

> **Note:** macOS may show a security warning for files downloaded from the internet.
> If Chrome won't load the extension, right-click the folder → Get Info → uncheck "Locked",
> or run: `xattr -rd com.apple.quarantine /path/to/ADSB_Waypoints_v1.1`
