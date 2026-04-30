class HaDysonCard extends HTMLElement {
  static getStubConfig() {
    return {
      entity: "fan.my_dyson",
    };
  }

  static getConfigElement() {
    return document.createElement("ha-dyson-card-editor");
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
  }

  setConfig(config) {
    if (!config?.entity) {
      throw new Error("Entity is required");
    }
    this._config = {
      title: "",
      temperature_entity: "",
      humidity_entity: "",
      air_quality_entity: "",
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 3;
  }

  _stateValue(entityId, fallback = "Unavailable") {
    if (!entityId || !this._hass) return fallback;
    const stateObj = this._hass.states?.[entityId];
    if (!stateObj) return fallback;
    return stateObj.state ?? fallback;
  }

  _friendlyName(entityId, fallback = "") {
    const stateObj = entityId ? this._hass?.states?.[entityId] : null;
    return stateObj?.attributes?.friendly_name || fallback || entityId || "";
  }

  _renderMetric(label, value, unit = "") {
    if (value === "Unavailable") return "";
    return `
      <div class="metric">
        <div class="metric-label">${label}</div>
        <div class="metric-value">${value}${unit}</div>
      </div>
    `;
  }

  _render() {
    if (!this.shadowRoot) return;
    const entityId = this._config.entity;
    const fan = entityId ? this._hass?.states?.[entityId] : null;

    if (!entityId) {
      this.shadowRoot.innerHTML = `<ha-card><div class="error">Set a Dyson entity.</div></ha-card>`;
      return;
    }

    const title = this._config.title || this._friendlyName(entityId, "Dyson");
    const isAvailable = Boolean(fan);
    const powerState = isAvailable ? (fan.state === "on" ? "On" : "Off") : "Unavailable";
    const attributes = fan?.attributes || {};
    const mode = attributes.preset_mode || attributes.mode || "Unknown";
    const speed = attributes.percentage ?? attributes.speed ?? "Unknown";
    const temp = this._stateValue(this._config.temperature_entity, "");
    const humidity = this._stateValue(this._config.humidity_entity, "");
    const airQuality = this._stateValue(this._config.air_quality_entity, "");

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        ha-card {
          padding: 16px;
          border-radius: 20px;
        }
        .card {
          display: grid;
          gap: 14px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .title {
          font-size: 1rem;
          font-weight: 700;
          line-height: 1.2;
        }
        .chip {
          border-radius: 999px;
          padding: 6px 10px;
          font-size: 0.78rem;
          font-weight: 700;
          background: ${powerState === "On" ? "rgba(42, 157, 143, 0.14)" : "rgba(127,127,127,0.14)"};
          color: ${powerState === "On" ? "#2a9d8f" : "var(--secondary-text-color)"};
        }
        .summary {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
        .metric {
          border: 1px solid var(--divider-color);
          border-radius: 16px;
          padding: 12px;
          background: color-mix(in srgb, var(--card-background-color, #fff) 90%, transparent);
        }
        .metric-label {
          font-size: 0.76rem;
          color: var(--secondary-text-color);
          margin-bottom: 4px;
        }
        .metric-value {
          font-size: 1rem;
          font-weight: 700;
        }
        .error {
          padding: 16px;
          color: #d9485f;
        }
        @media (max-width: 520px) {
          .summary {
            grid-template-columns: 1fr;
          }
        }
      </style>
      <ha-card>
        ${isAvailable ? `
          <div class="card">
            <div class="header">
              <div class="title">${title}</div>
              <div class="chip">${powerState}</div>
            </div>
            <div class="summary">
              ${this._renderMetric("Mode", mode)}
              ${this._renderMetric("Fan speed", speed, typeof speed === "number" ? "%" : "")}
              ${this._renderMetric("Temperature", temp, temp ? "°" : "")}
              ${this._renderMetric("Humidity", humidity, humidity ? "%" : "")}
              ${this._renderMetric("Air quality", airQuality)}
            </div>
          </div>
        ` : `<div class="error">Entity ${entityId} was not found. Make sure hass_dyson is installed and the entity exists.</div>`}
      </ha-card>
    `;
  }
}

class HaDysonCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
  }

  setConfig(config) {
    this._config = {
      title: "",
      temperature_entity: "",
      humidity_entity: "",
      air_quality_entity: "",
      ...config,
    };
    this._render();
  }

  _emitConfig(patch) {
    this._config = { ...this._config, ...patch };
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: this._config },
      bubbles: true,
      composed: true,
    }));
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; padding: 8px 0; }
        .stack { display: grid; gap: 12px; }
        label { display: grid; gap: 6px; font-size: 0.9rem; }
        input {
          border: 1px solid var(--divider-color);
          border-radius: 12px;
          padding: 10px 12px;
          font: inherit;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color);
        }
        .help {
          color: var(--secondary-text-color);
          font-size: 0.82rem;
        }
      </style>
      <div class="stack">
        <label>
          Dyson entity
          <input id="entity" value="${this._config.entity || ""}" placeholder="fan.my_dyson" />
        </label>
        <label>
          Title
          <input id="title" value="${this._config.title || ""}" placeholder="Optional card title" />
        </label>
        <label>
          Temperature entity
          <input id="temperature_entity" value="${this._config.temperature_entity || ""}" placeholder="sensor.my_dyson_temperature" />
        </label>
        <label>
          Humidity entity
          <input id="humidity_entity" value="${this._config.humidity_entity || ""}" placeholder="sensor.my_dyson_humidity" />
        </label>
        <label>
          Air quality entity
          <input id="air_quality_entity" value="${this._config.air_quality_entity || ""}" placeholder="sensor.my_dyson_air_quality_index" />
        </label>
        <div class="help">Install and configure <code>hass_dyson</code> first. This card only renders entities exposed by that integration.</div>
      </div>
    `;

    ["entity", "title", "temperature_entity", "humidity_entity", "air_quality_entity"].forEach((key) => {
      this.shadowRoot.getElementById(key)?.addEventListener("change", (event) => {
        this._emitConfig({ [key]: event.target.value.trim() });
      });
    });
  }
}

customElements.define("ha-dyson-card", HaDysonCard);
customElements.define("ha-dyson-card-editor", HaDysonCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ha-dyson-card",
  name: "HA Dyson Card",
  description: "A simple Lovelace card for Dyson devices powered by hass_dyson.",
});
