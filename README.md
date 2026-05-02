# HA Dyson Card

`ha-dyson-card` is a lightweight Lovelace card for Dyson devices powered by the [`hass_dyson`](https://github.com/cmgrayb/hass-dyson) Home Assistant integration.

This project is intentionally dashboard-only. It does not replace the integration and depends on `hass_dyson` for device entities and data.

## Features

- Single-device Dyson control card with a simplified 360 direction dial
- Direction anchor, current aiming angle, and visible oscillation cone
- Quick cone-width presets for direct, 45°, 90°, 180°, and 350° sweep
- Derives the related Dyson device and companion entities from the selected fan entity
- Clear live status for power, mode, fan speed, temperature, and humidity
- Works as a standalone custom card in Lovelace
- HACS-ready as a Dashboard / Plugin repo

## Requirements

- Home Assistant
- [`hass_dyson`](https://github.com/cmgrayb/hass-dyson) installed and configured
- A Dyson entity from that integration, typically a `fan.` entity

## Installation

### HACS

1. Open HACS
2. Add this repository as a custom repository
3. Category: `Dashboard`
4. Install `HA Dyson Card`
5. Refresh Home Assistant

## Usage

Add the card to a dashboard:

```yaml
type: custom:ha-dyson-card
entity: fan.my_dyson
```

Optional fields:

```yaml
type: custom:ha-dyson-card
entity: fan.my_dyson
title: Bedroom Dyson
default_oscillation_angle: 90
```

## Notes

- The card derives the Dyson `device_id` and related entities from the selected fan entity using Home Assistant registries.
- The integration service currently accepts `lower_angle` and `upper_angle` in the `0-350` range.
- `default_oscillation_angle` is used as a fallback when the live sweep width cannot be derived from Home Assistant.

## License

Apache-2.0
