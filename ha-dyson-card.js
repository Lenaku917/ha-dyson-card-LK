class HaDysonCard extends HTMLElement {
  static getStubConfig() {
    return {
      entity: "fan.my_dyson",
      device_id: "",
      oscillation_angle_entity: "",
      default_oscillation_angle: 90,
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
    this._busy = false;
    this._localDirection = null;
    this._localWidth = null;
    this._draggingDial = false;
  }

  setConfig(config) {
    if (!config?.entity) {
      throw new Error("Entity is required");
    }
    this._config = {
      title: "",
      device_id: "",
      temperature_entity: "",
      humidity_entity: "",
      air_quality_entity: "",
      oscillation_angle_entity: "",
      default_oscillation_angle: 90,
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 5;
  }

  _stateObj(entityId) {
    if (!entityId || !this._hass) return null;
    return this._hass.states?.[entityId] || null;
  }

  _stateValue(entityId, fallback = "Unavailable") {
    const stateObj = this._stateObj(entityId);
    return stateObj?.state ?? fallback;
  }

  _friendlyName(entityId, fallback = "") {
    return this._stateObj(entityId)?.attributes?.friendly_name || fallback || entityId || "";
  }

  _numericState(entityId) {
    const value = Number(this._stateValue(entityId, NaN));
    return Number.isFinite(value) ? value : null;
  }

  _normalizeAngle(value) {
    if (!Number.isFinite(Number(value))) return 0;
    const normalized = ((Number(value) % 360) + 360) % 360;
    return Math.max(0, Math.min(350, Math.round(normalized / 5) * 5));
  }

  _extractBounds(attributes) {
    const lowerCandidates = [
      attributes.lower_angle,
      attributes.lowerAngle,
      attributes.oscillation_lower_angle,
      attributes.oscillationLowerAngle,
      attributes.oscillation_min_angle,
      attributes.oscillationMinAngle,
    ];
    const upperCandidates = [
      attributes.upper_angle,
      attributes.upperAngle,
      attributes.oscillation_upper_angle,
      attributes.oscillationUpperAngle,
      attributes.oscillation_max_angle,
      attributes.oscillationMaxAngle,
    ];
    const lower = lowerCandidates.find((value) => Number.isFinite(Number(value)));
    const upper = upperCandidates.find((value) => Number.isFinite(Number(value)));
    if (!Number.isFinite(Number(lower)) || !Number.isFinite(Number(upper))) {
      return null;
    }
    return {
      lower: this._normalizeAngle(lower),
      upper: this._normalizeAngle(upper),
    };
  }

  _widthFromBounds(bounds) {
    if (!bounds) return null;
    const delta = ((bounds.upper - bounds.lower) + 360) % 360;
    return this._normalizeAngle(delta);
  }

  _centerFromBounds(bounds) {
    if (!bounds) return null;
    const width = this._widthFromBounds(bounds) ?? 0;
    return this._normalizeAngle(bounds.lower + (width / 2));
  }

  _currentWidth(attributes) {
    if (Number.isFinite(this._localWidth)) {
      return this._normalizeAngle(this._localWidth);
    }
    const fromEntity = this._numericState(this._config.oscillation_angle_entity);
    if (fromEntity !== null) {
      return this._normalizeAngle(fromEntity);
    }
    const bounds = this._extractBounds(attributes);
    const fromBounds = this._widthFromBounds(bounds);
    if (fromBounds !== null) {
      return fromBounds;
    }
    return this._normalizeAngle(this._config.default_oscillation_angle || 90);
  }

  _currentDirection(attributes) {
    if (Number.isFinite(this._localDirection)) {
      return this._normalizeAngle(this._localDirection);
    }
    const bounds = this._extractBounds(attributes);
    const fromBounds = this._centerFromBounds(bounds);
    if (fromBounds !== null) {
      return fromBounds;
    }
    return 180;
  }

  _displayAngle(direction, width) {
    if (!width) {
      return `${direction}\u00b0 direct`;
    }
    return `${direction}\u00b0 center \u00b7 ${width}\u00b0 sweep`;
  }

  _pointForAngle(cx, cy, radius, angle) {
    const radians = (angle * Math.PI) / 180;
    return {
      x: cx + Math.sin(radians) * radius,
      y: cy - Math.cos(radians) * radius,
    };
  }

  _arcPath(cx, cy, radius, startAngle, endAngle) {
    const start = this._pointForAngle(cx, cy, radius, startAngle);
    const end = this._pointForAngle(cx, cy, radius, endAngle);
    const sweep = ((endAngle - startAngle) + 360) % 360;
    const largeArc = sweep > 180 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
  }

  _sectorPath(cx, cy, outerRadius, startAngle, endAngle) {
    const start = this._pointForAngle(cx, cy, outerRadius, startAngle);
    const end = this._pointForAngle(cx, cy, outerRadius, endAngle);
    const sweep = ((endAngle - startAngle) + 360) % 360;
    const largeArc = sweep > 180 ? 1 : 0;
    return `M ${cx} ${cy} L ${start.x} ${start.y} A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
  }

  _renderMetric(label, value, unit = "") {
    if (!value || value === "Unavailable") return "";
    return `
      <div class="metric">
        <div class="metric-label">${label}</div>
        <div class="metric-value">${value}${unit}</div>
      </div>
    `;
  }

  async _setPower(nextState) {
    if (!this._hass || !this._config.entity || this._busy) return;
    this._busy = true;
    this._render();
    try {
      await this._hass.callService("fan", nextState === "on" ? "turn_on" : "turn_off", {
        entity_id: this._config.entity,
      });
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _commitDirection(direction, width) {
    if (!this._hass || !this._config.device_id || this._busy) return;
    const normalizedDirection = this._normalizeAngle(direction);
    const normalizedWidth = this._normalizeAngle(width);
    const lower = this._normalizeAngle(normalizedDirection - (normalizedWidth / 2));
    const upper = this._normalizeAngle(normalizedDirection + (normalizedWidth / 2));

    this._busy = true;
    this._localDirection = normalizedDirection;
    this._localWidth = normalizedWidth;
    this._render();

    try {
      await this._hass.callService("hass_dyson", "set_oscillation_angles", {
        device_id: this._config.device_id,
        lower_angle: lower,
        upper_angle: upper,
      });

      if (this._config.oscillation_angle_entity) {
        await this._hass.callService("number", "set_value", {
          entity_id: this._config.oscillation_angle_entity,
          value: normalizedWidth,
        });
      }
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _angleFromPointer(event, element) {
    const rect = element.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = x - cx;
    const dy = cy - y;
    const radians = Math.atan2(dx, dy);
    const degrees = (radians * 180) / Math.PI;
    return this._normalizeAngle(degrees);
  }

  _bindWheel(attributes) {
    const wheel = this.shadowRoot?.querySelector(".wheel-button");
    if (!wheel || !this._config.device_id) return;

    const currentWidth = this._currentWidth(attributes);
    let draftDirection = this._currentDirection(attributes);

    const updateDraft = (event) => {
      draftDirection = this._angleFromPointer(event, wheel);
      this._localDirection = draftDirection;
      this._render();
    };

    wheel.addEventListener("pointerdown", (event) => {
      this._draggingDial = true;
      wheel.setPointerCapture?.(event.pointerId);
      updateDraft(event);
    });

    wheel.addEventListener("pointermove", (event) => {
      if (!this._draggingDial) return;
      updateDraft(event);
    });

    const finish = async (event) => {
      if (!this._draggingDial) return;
      this._draggingDial = false;
      updateDraft(event);
      await this._commitDirection(draftDirection, currentWidth);
    };

    wheel.addEventListener("pointerup", finish);
    wheel.addEventListener("pointercancel", () => {
      this._draggingDial = false;
      this._localDirection = null;
      this._render();
    });
  }

  _bindControls(attributes, powerState) {
    this._bindWheel(attributes);

    this.shadowRoot?.querySelector(".power-button")?.addEventListener("click", async () => {
      await this._setPower(powerState === "On" ? "off" : "on");
    });

    this.shadowRoot?.querySelectorAll("[data-width]")?.forEach((button) => {
      button.addEventListener("click", async () => {
        const direction = this._currentDirection(attributes);
        const width = Number(button.dataset.width);
        await this._commitDirection(direction, width);
      });
    });
  }

  _render() {
    if (!this.shadowRoot) return;

    const entityId = this._config.entity;
    const fan = entityId ? this._hass?.states?.[entityId] : null;

    if (!entityId) {
      this.shadowRoot.innerHTML = `<ha-card><div class="error">Set a Dyson entity.</div></ha-card>`;
      return;
    }

    if (!fan) {
      this.shadowRoot.innerHTML = `
        <ha-card>
          <div class="error">
            Entity ${entityId} was not found. Make sure hass_dyson is installed and the entity exists.
          </div>
        </ha-card>
      `;
      return;
    }

    const title = this._config.title || this._friendlyName(entityId, "Dyson");
    const attributes = fan.attributes || {};
    const powerState = fan.state === "on" ? "On" : "Off";
    const mode = attributes.preset_mode || attributes.mode || "Unknown";
    const speed = attributes.percentage ?? attributes.speed ?? "Unknown";
    const temp = this._stateValue(this._config.temperature_entity, "");
    const humidity = this._stateValue(this._config.humidity_entity, "");
    const airQuality = this._stateValue(this._config.air_quality_entity, "");
    const direction = this._currentDirection(attributes);
    const width = this._currentWidth(attributes);
    const sweep = width || 0;
    const startAngle = this._normalizeAngle(direction - (sweep / 2));
    const endAngle = this._normalizeAngle(direction + (sweep / 2));
    const handle = this._pointForAngle(160, 160, 120, direction);
    const presetWidths = [0, 45, 90, 180, 350];
    const controlReady = Boolean(this._config.device_id);
    const conePath = sweep
      ? this._sectorPath(160, 160, 128, startAngle, endAngle)
      : "";
    const directPath = this._arcPath(160, 160, 116, direction - 1, direction + 1);

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        ha-card {
          padding: 18px;
          border-radius: 24px;
          overflow: hidden;
        }
        .card {
          display: grid;
          gap: 18px;
        }
        .header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 14px;
        }
        .title-stack {
          display: grid;
          gap: 6px;
        }
        .title {
          font-size: 1.08rem;
          font-weight: 700;
          line-height: 1.2;
        }
        .subtitle {
          font-size: 0.82rem;
          color: var(--secondary-text-color);
        }
        .chip {
          border-radius: 999px;
          padding: 7px 11px;
          font-size: 0.78rem;
          font-weight: 700;
          background: ${powerState === "On" ? "rgba(42, 157, 143, 0.14)" : "rgba(127, 127, 127, 0.16)"};
          color: ${powerState === "On" ? "#2a9d8f" : "var(--secondary-text-color)"};
        }
        .control-shell {
          display: grid;
          gap: 14px;
          justify-items: center;
        }
        .wheel-button {
          appearance: none;
          border: 0;
          padding: 0;
          background: none;
          cursor: ${controlReady ? "pointer" : "default"};
          width: min(100%, 320px);
          touch-action: none;
        }
        .wheel {
          width: 100%;
          height: auto;
          display: block;
        }
        .wheel-bg {
          fill: color-mix(in srgb, var(--card-background-color, #ffffff) 78%, #000 22%);
        }
        .wheel-ring {
          fill: none;
          stroke: color-mix(in srgb, var(--primary-text-color, #111) 14%, transparent);
          stroke-width: 2;
        }
        .wheel-anchor {
          stroke: color-mix(in srgb, var(--primary-text-color, #111) 28%, transparent);
          stroke-width: 4;
          stroke-linecap: round;
        }
        .wheel-cone {
          fill: color-mix(in srgb, var(--primary-color, #4f46e5) 22%, transparent);
        }
        .wheel-direct {
          fill: none;
          stroke: color-mix(in srgb, var(--primary-color, #4f46e5) 72%, white 8%);
          stroke-width: 8;
          stroke-linecap: round;
        }
        .wheel-handle {
          fill: var(--card-background-color, #fff);
          stroke: var(--primary-text-color, #111);
          stroke-width: 5;
        }
        .wheel-core {
          fill: color-mix(in srgb, var(--card-background-color, #ffffff) 88%, #000 12%);
          stroke: color-mix(in srgb, var(--primary-text-color, #111) 12%, transparent);
          stroke-width: 2;
        }
        .wheel-core-inner {
          fill: color-mix(in srgb, var(--card-background-color, #ffffff) 92%, #000 8%);
        }
        .wheel-core-label {
          fill: var(--primary-text-color);
          font: 700 16px system-ui, sans-serif;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .direction-readout {
          display: grid;
          gap: 4px;
          justify-items: center;
        }
        .direction-angle {
          font-size: 1.8rem;
          font-weight: 750;
          line-height: 1;
        }
        .direction-copy {
          font-size: 0.82rem;
          color: var(--secondary-text-color);
          text-align: center;
        }
        .preset-row {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 8px;
          width: 100%;
        }
        .preset {
          border: 1px solid var(--divider-color);
          border-radius: 999px;
          padding: 9px 10px;
          font: inherit;
          font-size: 0.78rem;
          font-weight: 700;
          background: color-mix(in srgb, var(--card-background-color, #fff) 94%, transparent);
          color: var(--secondary-text-color);
        }
        .preset.selected {
          border-color: transparent;
          background: color-mix(in srgb, var(--primary-color, #4f46e5) 16%, transparent);
          color: var(--primary-text-color);
        }
        .actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .action {
          border: 0;
          border-radius: 14px;
          padding: 11px 14px;
          font: inherit;
          font-size: 0.86rem;
          font-weight: 700;
          background: color-mix(in srgb, var(--primary-color, #4f46e5) 12%, transparent);
          color: var(--primary-text-color);
        }
        .action.secondary {
          background: color-mix(in srgb, var(--card-background-color, #fff) 90%, #000 10%);
          color: var(--secondary-text-color);
        }
        .summary {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
        }
        .metric {
          border: 1px solid var(--divider-color);
          border-radius: 18px;
          padding: 12px;
          background: color-mix(in srgb, var(--card-background-color, #fff) 92%, transparent);
        }
        .metric-label {
          font-size: 0.74rem;
          color: var(--secondary-text-color);
          margin-bottom: 5px;
        }
        .metric-value {
          font-size: 0.98rem;
          font-weight: 700;
        }
        .helper {
          font-size: 0.78rem;
          color: var(--secondary-text-color);
          text-align: center;
        }
        .error {
          padding: 16px;
          color: #d9485f;
        }
        .busy {
          opacity: 0.68;
          pointer-events: none;
        }
        @media (max-width: 520px) {
          .summary {
            grid-template-columns: 1fr 1fr;
          }
          .preset-row {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
        }
      </style>
      <ha-card>
        <div class="card ${this._busy ? "busy" : ""}">
          <div class="header">
            <div class="title-stack">
              <div class="title">${title}</div>
              <div class="subtitle">${this._displayAngle(direction, width)}</div>
            </div>
            <div class="chip">${powerState}</div>
          </div>

          <div class="control-shell">
            <button class="wheel-button" aria-label="Set Dyson direction">
              <svg class="wheel" viewBox="0 0 320 320" role="img" aria-hidden="true">
                <circle class="wheel-bg" cx="160" cy="160" r="128"></circle>
                <circle class="wheel-ring" cx="160" cy="160" r="128"></circle>
                <line class="wheel-anchor" x1="160" y1="18" x2="160" y2="40"></line>
                ${sweep ? `<path class="wheel-cone" d="${conePath}"></path>` : `<path class="wheel-direct" d="${directPath}"></path>`}
                <circle class="wheel-core" cx="160" cy="160" r="48"></circle>
                <circle class="wheel-core-inner" cx="160" cy="160" r="36"></circle>
                <text class="wheel-core-label" x="160" y="166" text-anchor="middle">Dyson</text>
                <circle class="wheel-handle" cx="${handle.x}" cy="${handle.y}" r="13"></circle>
              </svg>
            </button>

            <div class="direction-readout">
              <div class="direction-angle">${direction}\u00b0</div>
              <div class="direction-copy">
                ${controlReady ? "Drag the dial to aim the fan. Use presets to widen or collapse the cone." : "Add a hass_dyson device_id in the card editor to enable direction control."}
              </div>
            </div>

            <div class="preset-row">
              ${presetWidths.map((preset) => `
                <button class="preset ${width === preset ? "selected" : ""}" data-width="${preset}">
                  ${preset === 0 ? "Direct" : `${preset}\u00b0`}
                </button>
              `).join("")}
            </div>
          </div>

          <div class="actions">
            <button class="action power-button">${powerState === "On" ? "Turn off" : "Turn on"}</button>
            <button class="action secondary" disabled>${mode}</button>
            <button class="action secondary" disabled>${typeof speed === "number" ? `${speed}% fan` : `${speed} fan`}</button>
          </div>

          <div class="summary">
            ${this._renderMetric("Temperature", temp, temp ? "\u00b0" : "")}
            ${this._renderMetric("Humidity", humidity, humidity ? "%" : "")}
            ${this._renderMetric("Air quality", airQuality)}
          </div>

          ${controlReady ? "" : `<div class="helper">This control uses the <code>hass_dyson.set_oscillation_angles</code> service, which requires the Dyson <code>device_id</code>.</div>`}
        </div>
      </ha-card>
    `;

    this._bindControls(attributes, powerState);
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
      device_id: "",
      temperature_entity: "",
      humidity_entity: "",
      air_quality_entity: "",
      oscillation_angle_entity: "",
      default_oscillation_angle: 90,
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
          Dyson device id
          <input id="device_id" value="${this._config.device_id || ""}" placeholder="Required for oscillation control" />
        </label>
        <label>
          Title
          <input id="title" value="${this._config.title || ""}" placeholder="Optional card title" />
        </label>
        <label>
          Oscillation angle entity
          <input id="oscillation_angle_entity" value="${this._config.oscillation_angle_entity || ""}" placeholder="number.my_dyson_oscillation_angle" />
        </label>
        <label>
          Default oscillation width
          <input id="default_oscillation_angle" value="${this._config.default_oscillation_angle || 90}" placeholder="90" />
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
        <div class="help">Install and configure <code>hass_dyson</code> first. To control the 360 dial, set the integration <code>device_id</code> and, ideally, the Dyson oscillation angle <code>number</code> entity.</div>
      </div>
    `;

    const textFields = [
      "entity",
      "device_id",
      "title",
      "oscillation_angle_entity",
      "temperature_entity",
      "humidity_entity",
      "air_quality_entity",
    ];

    textFields.forEach((key) => {
      this.shadowRoot.getElementById(key)?.addEventListener("change", (event) => {
        this._emitConfig({ [key]: event.target.value.trim() });
      });
    });

    this.shadowRoot.getElementById("default_oscillation_angle")?.addEventListener("change", (event) => {
      const value = Number(event.target.value);
      this._emitConfig({ default_oscillation_angle: Number.isFinite(value) ? value : 90 });
    });
  }
}

customElements.define("ha-dyson-card", HaDysonCard);
customElements.define("ha-dyson-card-editor", HaDysonCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ha-dyson-card",
  name: "HA Dyson Card",
  description: "A Dyson Lovelace card with direct oscillation aiming and cone-width control.",
});
