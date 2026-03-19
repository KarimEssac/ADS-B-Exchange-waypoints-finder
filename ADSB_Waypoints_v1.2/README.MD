# ADS-B Exchange Waypoints Finder

An ADS-B Exchange browser extension that overlays flight waypoints, fixes, VORs, and NDBs directly on the map.

## Features

- **Map Overlays**: Visual markers for aviation fixes, intersections, VORs, and NDBs.
- **Interactive Map**:
  - Hover over markers to see detailed information (Identifier, Name, Type, Coordinates).
  - Click any marker to automatically copy its identifier to your clipboard.
- **Search**: Quickly find and fly to specific waypoints by their identifier.
- **Customizable**: Toggle individual waypoint types on/off to reduce map clutter.
- **Performance**: High-performance canvas rendering that stays synced with the map during zoom and pan.
- **Data Source**: Uses FAA CIFP (Coded Instrument Flight Procedures) data.

## Installation

1. Download or clone this repository.
2. Open Chrome (or any Chromium-based browser) and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the extension folder.

## Usage

1. Navigate to [ADS-B Exchange Globe](https://globe.adsbexchange.com/).
2. Click the extension icon in your browser toolbar to open the settings popup.
3. Toggle the overlay and choose which waypoint types you want to see.
4. Use the search box to find specific waypoints.

## Development

This extension is built with:
- **Manifest V3** for modern browser compatibility.
- **Vanilla JavaScript** for injection and rendering.
- **fflate** for efficient client-side decompression of aviation data.
- **OpenLayers** integration for seamless map synchronization.

## License

MIT
