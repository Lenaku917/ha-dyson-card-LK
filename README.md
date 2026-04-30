# HA Dyson Card

`ha-dyson-card` is a lightweight Lovelace card for Dyson devices powered by the [`hass_dyson`](https://github.com/cmgrayb/hass-dyson) Home Assistant integration.

This project is intentionally dashboard-only. It does not replace the integration and depends on `hass_dyson` for device entities and data.

## Features

- Single-device Dyson control card with a simplified 360 direction dial
- Direction anchor, current aiming angle, and visible oscillation cone
- Quick cone-width presets for direct, 45°, 90°, 180°, and 350° sweep
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
device_id: your_hass_dyson_device_id
oscillation_angle_entity: number.my_dyson_oscillation_angle
title: Bedroom Dyson
temperature_entity: sensor.my_dyson_temperature
humidity_entity: sensor.my_dyson_humidity
air_quality_entity: sensor.my_dyson_air_quality_index
```

## Notes

- The 360 direction control uses `hass_dyson.set_oscillation_angles`, so `device_id` is required for aiming control.
- The integration service currently accepts `lower_angle` and `upper_angle` in the `0-350` range.
- `oscillation_angle_entity` is optional but recommended so the card can stay aligned with Dyson sweep-width presets.
- If no optional sensor entities are provided, the card will still render using the main Dyson entity.

## License

Apache-2.0
