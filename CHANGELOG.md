# Changelog

## 0.5.0

- Automatic map zoom: the card shows only the drawn area of the map (walls,
  floor and rooms) with a small margin, instead of the whole image with empty
  space around it. Options `map_zoom` (default `true`) and `map_padding`
  (default `0.05`)

## 0.4.0

First release.

- Vacuum Hub card: several robot vacuums in one card, with state, battery,
  start / pause / stop / dock / locate, suction mode, device actions (mopping),
  live map and room selection
- The integration serves the card and loads it on every dashboard, so no
  Lovelace resource has to be added and updates need no cache busting
- `vacuum_hub.clean_rooms` action: room cleaning over the local network for
  Viomi and Roborock vacuums, using the host and token from Xiaomi Cloud Map
  Extractor
- The map image refreshes on its own when the map changes
