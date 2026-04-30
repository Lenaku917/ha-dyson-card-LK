# HA Dyson Card

`ha-dyson-card` is a lightweight Lovelace card for Dyson devices powered by the [`hass_dyson`](https://github.com/cmgrayb/hass-dyson) Home Assistant integration.

This project is intentionally dashboard-only. It does not replace the integration and depends on `hass_dyson` for device entities and data.

## Features

- Simple single-device card for Dyson fans and purifiers
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
temperature_entity: sensor.my_dyson_temperature
humidity_entity: sensor.my_dyson_humidity
air_quality_entity: sensor.my_dyson_air_quality_index
```

## Notes

- The card is display-focused and keeps the first version intentionally small.
- If no optional sensor entities are provided, the card will still render using the main Dyson entity.

## License

Apache-2.0
