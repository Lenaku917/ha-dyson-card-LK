class HaDysonCard extends HTMLElement {
  static _registryCache = null;

  static getStubConfig() {
    return {
      entity: "fan.my_dyson",
      default_oscillation_angle: 90,
    };
  }

  static getConfigForm() {
    return {
      schema: [
        {
          name: "entity",
          required: true,
          selector: {
            entity: {
              filter: [
                {
                  domain: "fan",
                },
              ],
            },
          },
        },
        {
          name: "title",
          selector: {
            text: {},
          },
        },
        {
          name: "default_oscillation_angle",
          selector: {
            number: {
              min: 0,
              max: 350,
              step: 5,
              unit_of_measurement: "°",
              mode: "box",
            },
          },
        },
        {
          name: "show_debug",
          selector: {
            boolean: {},
          },
        },
      ],
      computeLabel: (schema) => {
        switch (schema.name) {
          case "entity":
            return "Dyson entity";
          case "title":
            return "Title";
          case "default_oscillation_angle":
            return "Default oscillation width";
          case "show_debug":
            return "Show live debug";
          default:
            return undefined;
        }
      },
      computeHelper: (schema) => {
        switch (schema.name) {
          case "default_oscillation_angle":
            return "Used when current sweep width cannot be derived from the Dyson device.";
          case "show_debug":
            return "Shows live Dyson entity state and attributes for testing.";
          default:
            return undefined;
        }
      },
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._busy = false;
    this._draftDirection = null;
    this._draftWidth = null;
    this._draggingDial = false;
    this._derived = null;
    this._pendingDirection = null;
    this._pendingWidth = null;
    this._pendingSince = null;
    this._pendingLabel = "";
    this._pendingTimer = null;
    this._pendingSpeed = null;
    this._pendingSpeedSince = null;
    this._pendingSpeedTimer = null;
  }

  setConfig(config) {
    if (!config?.entity) {
      throw new Error("Entity is required");
    }
    this._config = {
      title: "",
      default_oscillation_angle: 90,
      show_debug: true,
      ...config,
    };
    this._derived = null;
    this._clearPending(false);
    this._clearPendingSpeed(false);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._ensureDerived();
    this._reconcilePendingState();
    this._render();
  }

  getCardSize() {
    return 5;
  }

  async _ensureRegistryCache() {
    if (!this._hass?.callWS) return null;
    if (!HaDysonCard._registryCache) {
      HaDysonCard._registryCache = Promise.all([
        this._hass.callWS({ type: "config/entity_registry/list" }),
        this._hass.callWS({ type: "config/device_registry/list" }),
      ]).then(([entities, devices]) => ({ entities, devices }));
    }
    return HaDysonCard._registryCache;
  }

  async _ensureDerived() {
    if (!this._hass || !this._config.entity || this._derived) return;
    try {
      const registry = await this._ensureRegistryCache();
      if (!registry) return;
      this._derived = this._deriveFromRegistry(registry);
      this._render();
    } catch (_error) {
      // Keep the card usable even if registry queries fail.
    }
  }

  _deriveFromRegistry(registry) {
    const entries = Array.isArray(registry?.entities) ? registry.entities : [];
    const deviceEntries = Array.isArray(registry?.devices) ? registry.devices : [];
    const fanEntry = entries.find((entry) => entry.entity_id === this._config.entity);
    const deviceId = fanEntry?.device_id || null;
    const sameDevice = deviceId ? entries.filter((entry) => entry.device_id === deviceId) : [];
    const device = deviceEntries.find((entry) => entry.id === deviceId) || null;

    return {
      deviceId,
      device,
      temperatureEntity: this._findEntityByHints(sameDevice, "sensor", ["temperature"]),
      humidityEntity: this._findEntityByHints(sameDevice, "sensor", ["humidity"]),
      airQualityEntity: this._findEntityByHints(sameDevice, "sensor", ["air_quality_category", "air_quality", "aqi", "pm25", "pm2_5", "pm10", "no2", "voc"]),
      vocEntity: this._findEntityByHints(sameDevice, "sensor", ["voc"]),
      hepaFilterEntity: this._findEntityByHints(sameDevice, "sensor", ["hepa_filter_life", "hepa filter life"]),
      carbonFilterEntity: this._findEntityByHints(sameDevice, "sensor", ["carbon_filter_life", "carbon filter life"]),
      nightModeEntity: this._findEntityByExactName(sameDevice, "switch", ["Night Mode"]),
      oscillationSelectEntity: this._findEntityByExactName(sameDevice, "select", ["Oscillation"]),
      oscillationLowEntity: this._findEntityByExactName(sameDevice, "number", ["Oscillation Low Angle"]),
      oscillationHighEntity: this._findEntityByExactName(sameDevice, "number", ["Oscillation High Angle"]),
      oscillationCenterEntity: this._findEntityByExactName(sameDevice, "number", ["Oscillation Center Angle"]),
      oscillationSpanEntity: this._findEntityByExactName(sameDevice, "number", ["Oscillation Angle"]),
      relatedEntities: sameDevice
        .map((entry) => entry.entity_id)
        .filter(Boolean)
        .sort(),
    };
  }

  _findEntityByExactName(entries, domain, names) {
    const normalizedNames = names.map((name) => name.toLowerCase());
    const matchingDomain = entries.filter((entry) => entry.entity_id?.startsWith(`${domain}.`));
    const byOriginalName = matchingDomain.find((entry) => normalizedNames.includes(String(entry.original_name || "").toLowerCase()));
    if (byOriginalName) return byOriginalName.entity_id;

    const byName = matchingDomain.find((entry) => normalizedNames.includes(String(entry.name || "").toLowerCase()));
    return byName?.entity_id || "";
  }

  _findEntityByHints(entries, domain, hints) {
    const normalizedHints = hints.map((hint) => hint.toLowerCase());
    const matchingDomain = entries.filter((entry) => entry.entity_id?.startsWith(`${domain}.`));
    const byEntityId = normalizedHints
      .map((hint) => matchingDomain.find((entry) => entry.entity_id.toLowerCase().includes(hint)))
      .find(Boolean);
    if (byEntityId) return byEntityId.entity_id;

    const byOriginalName = normalizedHints
      .map((hint) => {
        const readableHint = hint.replaceAll("_", " ");
        return matchingDomain.find((entry) => `${entry.original_name || ""} ${entry.name || ""}`.toLowerCase().includes(readableHint));
      })
      .find(Boolean);
    return byOriginalName?.entity_id || "";
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

  _deviceId() {
    return this._derived?.deviceId || "";
  }

  _temperatureEntity() {
    return this._derived?.temperatureEntity || "";
  }

  _humidityEntity() {
    return this._derived?.humidityEntity || "";
  }

  _airQualityEntity() {
    return this._derived?.airQualityEntity || "";
  }

  _oscillationAngleEntity() {
    return this._derived?.oscillationSpanEntity || "";
  }

  _oscillationSelectEntity() {
    return this._derived?.oscillationSelectEntity || "";
  }

  _oscillationCenterEntity() {
    return this._derived?.oscillationCenterEntity || "";
  }

  _nightModeEntity() {
    return this._derived?.nightModeEntity || "";
  }

  _vocEntity() {
    return this._derived?.vocEntity || this._airQualityEntity();
  }

  _filterEntities() {
    return [
      this._derived?.hepaFilterEntity || "",
      this._derived?.carbonFilterEntity || "",
    ].filter(Boolean);
  }

  _normalizeAngle(value) {
    if (!Number.isFinite(Number(value))) return 0;
    const normalized = ((Number(value) % 360) + 360) % 360;
    return Math.max(0, Math.min(350, Math.round(normalized / 5) * 5));
  }

  _normalizeDeviceAngle(value) {
    if (!Number.isFinite(Number(value))) return 0;
    return Math.max(0, Math.min(350, Math.round(Number(value))));
  }

  _normalizeVisualAngle(value) {
    if (!Number.isFinite(Number(value))) return 0;
    return ((Number(value) % 360) + 360) % 360;
  }

  _visualAngleFromDevice(value) {
    return this._normalizeVisualAngle(Number(value) + 5);
  }

  _deviceAngleFromVisual(value) {
    return this._normalizeAngle(Number(value) - 5);
  }

  _clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  _extractBounds(attributes) {
    const lowerCandidates = [
      attributes.lower_angle,
      attributes.lowerAngle,
      attributes.angle_low,
      attributes.oscillation_lower_angle,
      attributes.oscillationLowerAngle,
      attributes.oscillation_min_angle,
      attributes.oscillationMinAngle,
    ];
    const upperCandidates = [
      attributes.upper_angle,
      attributes.upperAngle,
      attributes.angle_high,
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
      lower: this._normalizeDeviceAngle(lower),
      upper: this._normalizeDeviceAngle(upper),
    };
  }

  _selectAttributes() {
    return this._stateObj(this._oscillationSelectEntity())?.attributes || {};
  }

  _currentBounds(attributes) {
    const fromFan = this._extractBounds(attributes);
    if (fromFan) return fromFan;

    const selectAttributes = this._selectAttributes();
    const lower = Number(selectAttributes.oscillation_angle_low);
    const upper = Number(selectAttributes.oscillation_angle_high);
    if (Number.isFinite(lower) && Number.isFinite(upper)) {
      return {
        lower: this._normalizeDeviceAngle(lower),
        upper: this._normalizeDeviceAngle(upper),
      };
    }

    const lowerEntity = this._derived?.oscillationLowEntity || "";
    const highEntity = this._derived?.oscillationHighEntity || "";
    const lowerState = this._numericState(lowerEntity);
    const highState = this._numericState(highEntity);
    if (lowerState !== null && highState !== null) {
      return {
        lower: this._normalizeDeviceAngle(lowerState),
        upper: this._normalizeDeviceAngle(highState),
      };
    }

    return null;
  }

  _oscillationEnabled(attributes) {
    if (typeof attributes.oscillation_enabled === "boolean") {
      return attributes.oscillation_enabled;
    }
    if (typeof attributes.oscillating === "boolean") {
      return attributes.oscillating;
    }
    const selectAttributes = this._selectAttributes();
    if (typeof selectAttributes.oscillation_enabled === "boolean") {
      return selectAttributes.oscillation_enabled;
    }
    return null;
  }

  _widthFromBounds(bounds) {
    if (!bounds) return null;
    return this._normalizeAngle(bounds.upper - bounds.lower);
  }

  _centerFromBounds(bounds) {
    if (!bounds) return null;
    const width = this._widthFromBounds(bounds) ?? 0;
    return this._normalizeAngle(bounds.lower + (width / 2));
  }

  _sourceWidth(attributes) {
    if (this._oscillationEnabled(attributes) === false) {
      return 0;
    }
    const bounds = this._currentBounds(attributes);
    const fromBounds = this._widthFromBounds(bounds);
    if (fromBounds !== null) {
      return fromBounds;
    }
    const fromEntity = this._numericState(this._oscillationAngleEntity());
    if (fromEntity !== null) {
      return this._normalizeAngle(fromEntity);
    }
    return this._normalizeAngle(this._config.default_oscillation_angle || 90);
  }

  _sourceDirection(attributes) {
    const bounds = this._currentBounds(attributes);
    const fromBounds = this._centerFromBounds(bounds);
    if (fromBounds !== null) {
      return fromBounds;
    }
    const centerFromEntity = this._numericState(this._oscillationCenterEntity());
    if (centerFromEntity !== null) {
      return this._normalizeAngle(centerFromEntity);
    }
    return 180;
  }

  _pendingActive() {
    return Number.isFinite(this._pendingSince) && Date.now() - this._pendingSince < 90000;
  }

  _pendingSpeedActive() {
    return Number.isFinite(this._pendingSpeedSince) && Date.now() - this._pendingSpeedSince < 90000;
  }

  _setPendingDirection(direction, width, label) {
    const bounds = this._boundsFromCenterWidth(direction, width);
    this._pendingDirection = bounds.center;
    this._pendingWidth = bounds.width;
    this._pendingSince = Date.now();
    this._pendingLabel = label;

    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
    }
    this._pendingTimer = setTimeout(() => {
      this._clearPending();
    }, 90000);
  }

  _clearPending(render = true) {
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
    this._pendingDirection = null;
    this._pendingWidth = null;
    this._pendingSince = null;
    this._pendingLabel = "";
    if (render) {
      this._render();
    }
  }

  _setPendingSpeed(percentage) {
    this._pendingSpeed = Math.max(0, Math.min(100, Math.round(Number(percentage))));
    this._pendingSpeedSince = Date.now();

    if (this._pendingSpeedTimer) {
      clearTimeout(this._pendingSpeedTimer);
    }
    this._pendingSpeedTimer = setTimeout(() => {
      this._clearPendingSpeed();
    }, 90000);
  }

  _clearPendingSpeed(render = true) {
    if (this._pendingSpeedTimer) {
      clearTimeout(this._pendingSpeedTimer);
      this._pendingSpeedTimer = null;
    }
    this._pendingSpeed = null;
    this._pendingSpeedSince = null;
    if (render) {
      this._render();
    }
  }

  _anglesMatch(sourceDirection, sourceWidth) {
    if (!this._pendingActive()) return false;
    return this._normalizeAngle(sourceDirection) === this._normalizeAngle(this._pendingDirection)
      && this._normalizeAngle(sourceWidth) === this._normalizeAngle(this._pendingWidth);
  }

  _reconcilePendingState() {
    const fan = this._config.entity ? this._hass?.states?.[this._config.entity] : null;
    const attributes = fan?.attributes || {};

    if (this._pendingSpeedActive() && this._sourceSpeed(attributes) === this._pendingSpeed) {
      this._clearPendingSpeed(false);
    } else if (!this._pendingSpeedActive() && this._pendingSpeedSince !== null) {
      this._clearPendingSpeed(false);
    }

    if (!this._pendingActive()) {
      if (this._pendingSince !== null) {
        this._clearPending(false);
      }
      return;
    }
    if (!fan) return;
    if (this._anglesMatch(this._sourceDirection(attributes), this._sourceWidth(attributes))) {
      this._clearPending(false);
    }
  }

  _sourceSpeed(attributes) {
    const value = Number(attributes.percentage);
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  _currentSpeed(attributes) {
    if (this._pendingSpeedActive() && Number.isFinite(this._pendingSpeed)) {
      return this._pendingSpeed;
    }
    return this._sourceSpeed(attributes);
  }

  _currentWidth(attributes) {
    if (this._draggingDial && Number.isFinite(this._draftWidth)) {
      return this._normalizeAngle(this._draftWidth);
    }
    if (this._pendingActive() && Number.isFinite(this._pendingWidth)) {
      return this._normalizeAngle(this._pendingWidth);
    }
    return this._sourceWidth(attributes);
  }

  _currentDirection(attributes) {
    if (this._draggingDial && Number.isFinite(this._draftDirection)) {
      return this._normalizeAngle(this._draftDirection);
    }
    if (this._pendingActive() && Number.isFinite(this._pendingDirection)) {
      return this._normalizeAngle(this._pendingDirection);
    }
    return this._sourceDirection(attributes);
  }

  _displayAngle(direction, width) {
    if (!width) {
      return `${direction}\u00b0 direct`;
    }
    return `${direction}\u00b0 center \u00b7 ${width}\u00b0 sweep`;
  }

  _boundsFromCenterWidth(direction, width) {
    const normalizedWidth = this._normalizeAngle(width);
    const halfWidth = normalizedWidth / 2;
    const requestedCenter = this._normalizeAngle(direction);
    const constrainedCenter = this._clamp(requestedCenter, halfWidth, 350 - halfWidth);
    const lower = this._normalizeDeviceAngle(constrainedCenter - halfWidth);
    const upper = this._normalizeDeviceAngle(constrainedCenter + halfWidth);
    const center = this._normalizeAngle(lower + ((upper - lower) / 2));
    return { lower, upper, center, width: normalizedWidth };
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

  _updateDialPreview(direction, width) {
    const wheel = this.shadowRoot;
    if (!wheel) return;
    const bounds = this._boundsFromCenterWidth(direction, width);
    const handle = this._pointForAngle(160, 160, 120, this._visualAngleFromDevice(bounds.center));
    const cone = wheel.querySelector(".wheel-cone");
    const direct = wheel.querySelector(".wheel-direct");
    const handleCircle = wheel.querySelector(".wheel-handle");
    const angleNode = wheel.querySelector(".direction-angle");
    const subtitleNode = wheel.querySelector(".subtitle");

    if (angleNode) {
      angleNode.textContent = `${bounds.center}\u00b0`;
    }
    if (subtitleNode) {
      subtitleNode.textContent = this._displayAngle(bounds.center, bounds.width);
    }
    if (handleCircle) {
      handleCircle.setAttribute("cx", String(handle.x));
      handleCircle.setAttribute("cy", String(handle.y));
    }

    if (bounds.width === 0) {
      if (cone) {
        cone.setAttribute("d", "");
        cone.style.display = "none";
      }
      if (direct) {
        const visualCenter = this._visualAngleFromDevice(bounds.center);
        direct.setAttribute("d", this._arcPath(160, 160, 116, visualCenter - 1, visualCenter + 1));
        direct.style.display = "";
      }
      return;
    }

    if (cone) {
      cone.setAttribute("d", this._sectorPath(160, 160, 128, this._visualAngleFromDevice(bounds.lower), this._visualAngleFromDevice(bounds.upper)));
      cone.style.display = "";
    }
    if (direct) {
      direct.style.display = "none";
    }
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

  _displayState(entityId, fallback = "—") {
    const stateObj = this._stateObj(entityId);
    if (!stateObj || ["unknown", "unavailable"].includes(stateObj.state)) return fallback;
    return stateObj.state;
  }

  _displayNumber(entityId) {
    const value = Number(this._displayState(entityId, NaN));
    return Number.isFinite(value) ? value : null;
  }

  _unit(entityId, fallback = "") {
    return this._stateObj(entityId)?.attributes?.unit_of_measurement || fallback;
  }

  _qualityLabel(airQualityValue) {
    const value = String(airQualityValue || "").trim();
    if (!value || value === "Unavailable") return "Unknown";
    if (/^\d+(\.\d+)?$/.test(value)) {
      const numeric = Number(value);
      if (numeric <= 50) return "Good";
      if (numeric <= 100) return "Fair";
      if (numeric <= 150) return "Poor";
      return "Bad";
    }
    return value;
  }

  _qualityTone(label) {
    const normalized = String(label || "").toLowerCase();
    if (["good", "low", "excellent"].some((term) => normalized.includes(term))) return "good";
    if (["fair", "medium", "moderate"].some((term) => normalized.includes(term))) return "fair";
    if (["poor", "bad", "high", "severe"].some((term) => normalized.includes(term))) return "poor";
    return "neutral";
  }

  _filterPercent() {
    const values = this._filterEntities()
      .map((entityId) => this._displayNumber(entityId))
      .filter((value) => Number.isFinite(value));
    if (!values.length) return null;
    return Math.min(...values);
  }

  _timerLabel(attributes) {
    const minutes = Number(attributes.sleep_timer || 0);
    if (!Number.isFinite(minutes) || minutes <= 0) return "Off";
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }

  _isAutoMode(mode, attributes) {
    return String(mode).toLowerCase() === "auto" || attributes.auto_mode === true;
  }

  _nightModeOn(attributes) {
    const switchState = this._displayState(this._nightModeEntity(), "");
    if (switchState) return switchState === "on";
    return attributes.night_mode === true;
  }

  _fanDirection(attributes) {
    return attributes.direction || attributes.current_direction || "forward";
  }

  _renderStatusStat(label, value, icon, tone = "neutral", unit = "") {
    return `
      <div class="status-stat ${tone}">
        <ha-icon icon="${icon}"></ha-icon>
        <div>
          <strong>${this._escapeHtml(value)}${this._escapeHtml(unit)}</strong>
          <span>${this._escapeHtml(label)}</span>
        </div>
      </div>
    `;
  }

  _renderToggleButton(className, label, icon, active, disabled = false) {
    return `
      <button class="control-pill ${active ? "active" : ""}" ${disabled ? "disabled" : ""} data-control="${className}">
        <ha-icon icon="${icon}"></ha-icon>
        <span>${label}</span>
      </button>
    `;
  }

  _renderTimerButton(minutes, label, activeMinutes) {
    const active = Number(activeMinutes) === minutes;
    return `
      <button class="timer-chip ${active ? "active" : ""}" data-timer="${minutes}">
        ${label}
      </button>
    `;
  }

  _escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  _formatDebugValue(value) {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  }

  _renderDebugRow(label, value) {
    return `
      <div class="debug-row">
        <div class="debug-label">${this._escapeHtml(label)}</div>
        <pre class="debug-value">${this._escapeHtml(this._formatDebugValue(value))}</pre>
      </div>
    `;
  }

  _renderEntityDebug(entityId) {
    const stateObj = this._stateObj(entityId);
    const attributes = stateObj?.attributes || {};
    return `
      <details class="debug-entity">
        <summary>
          <span>${this._escapeHtml(entityId)}</span>
          <strong>${this._escapeHtml(stateObj?.state ?? "missing")}</strong>
        </summary>
        <div class="debug-entity-body">
          ${this._renderDebugRow("friendly_name", attributes.friendly_name || "")}
          ${this._renderDebugRow("unit", attributes.unit_of_measurement || "")}
          ${this._renderDebugRow("device_class", attributes.device_class || "")}
          ${this._renderDebugRow("state_class", attributes.state_class || "")}
          ${this._renderDebugRow("attributes", attributes)}
        </div>
      </details>
    `;
  }

  _renderDebugPanel(entityId, attributes, bounds, direction, width, controlReady) {
    if (!this._config.show_debug) return "";
    const relatedEntities = this._derived?.relatedEntities || [];
    const debugEntities = Array.from(new Set([
      entityId,
      this._temperatureEntity(),
      this._humidityEntity(),
      this._airQualityEntity(),
      this._vocEntity(),
      this._nightModeEntity(),
      ...this._filterEntities(),
      this._oscillationSelectEntity(),
      this._derived?.oscillationLowEntity || "",
      this._derived?.oscillationHighEntity || "",
      this._oscillationCenterEntity(),
      this._oscillationAngleEntity(),
      ...relatedEntities,
    ].filter(Boolean))).sort();

    const derivedDebug = {
      control_ready: controlReady,
      device_id: this._deviceId(),
      device_name: this._derived?.device?.name_by_user || this._derived?.device?.name || "",
      temperature_entity: this._temperatureEntity(),
      humidity_entity: this._humidityEntity(),
      air_quality_entity: this._airQualityEntity(),
      voc_entity: this._vocEntity(),
      night_mode_entity: this._nightModeEntity(),
      filter_entities: this._filterEntities(),
      oscillation_select_entity: this._oscillationSelectEntity(),
      oscillation_low_entity: this._derived?.oscillationLowEntity || "",
      oscillation_high_entity: this._derived?.oscillationHighEntity || "",
      oscillation_center_entity: this._oscillationCenterEntity(),
      oscillation_span_entity: this._oscillationAngleEntity(),
      related_entity_count: relatedEntities.length,
    };

    const computedDebug = {
      source_direction: this._sourceDirection(attributes),
      source_width: this._sourceWidth(attributes),
      rendered_direction: direction,
      rendered_width: width,
      bounds,
      oscillation_enabled: this._oscillationEnabled(attributes),
      pending_active: this._pendingActive(),
      pending_direction: this._pendingDirection,
      pending_width: this._pendingWidth,
      pending_label: this._pendingLabel,
      pending_speed: this._pendingSpeed,
      pending_speed_active: this._pendingSpeedActive(),
      busy: this._busy,
      dragging: this._draggingDial,
    };

    return `
      <details class="debug-panel">
        <summary>
          <span>Live Dyson Debug</span>
          <strong>${debugEntities.length} entities</strong>
        </summary>
        <div class="debug-grid">
          ${this._renderDebugRow("config", this._config)}
          ${this._renderDebugRow("derived", derivedDebug)}
          ${this._renderDebugRow("computed", computedDebug)}
          ${this._renderDebugRow("fan_attributes", attributes)}
        </div>
        <div class="debug-entities">
          ${debugEntities.map((debugEntityId) => this._renderEntityDebug(debugEntityId)).join("")}
        </div>
      </details>
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

  async _setAutoMode(enabled) {
    if (!this._hass || !this._config.entity || this._busy) return;
    this._busy = true;
    this._render();
    try {
      await this._hass.callService("fan", "set_preset_mode", {
        entity_id: this._config.entity,
        preset_mode: enabled ? "Auto" : "Manual",
      });
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _setNightMode(enabled) {
    const entityId = this._nightModeEntity();
    if (!this._hass || !entityId || this._busy) return;
    this._busy = true;
    this._render();
    try {
      await this._hass.callService("switch", enabled ? "turn_on" : "turn_off", {
        entity_id: entityId,
      });
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _setFanSpeed(percentage) {
    if (!this._hass || !this._config.entity || this._busy) return;
    const normalizedPercentage = Math.max(0, Math.min(100, Math.round(Number(percentage))));
    this._busy = true;
    this._setPendingSpeed(normalizedPercentage);
    this._render();
    try {
      await this._hass.callService("fan", "set_percentage", {
        entity_id: this._config.entity,
        percentage: normalizedPercentage,
      });
    } catch (error) {
      this._clearPendingSpeed(false);
      throw error;
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _setAirflowDirection(direction) {
    if (!this._hass || !this._config.entity || this._busy) return;
    this._busy = true;
    this._render();
    try {
      await this._hass.callService("fan", "set_direction", {
        entity_id: this._config.entity,
        direction,
      });
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _setSleepTimer(minutes) {
    const deviceId = this._deviceId();
    if (!this._hass || !deviceId || this._busy) return;
    this._busy = true;
    this._render();
    try {
      await this._hass.callService("hass_dyson", "set_sleep_timer", {
        device_id: deviceId,
        minutes,
      });
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _commitDirection(direction, width) {
    const deviceId = this._deviceId();
    if (!this._hass || !deviceId || this._busy) return;
    const bounds = this._boundsFromCenterWidth(direction, width);
    const { lower, upper, center, width: normalizedWidth } = bounds;
    const directMode = normalizedWidth === 0;

    this._busy = true;
    this._setPendingDirection(center, normalizedWidth, directMode ? "Pointing fan" : "Applying angle");
    this._render();

    try {
      if (directMode) {
        await this._hass.callService("fan", "oscillate", {
          entity_id: this._config.entity,
          oscillating: false,
        });
        await this._hass.callService("hass_dyson", "set_oscillation_angles", {
          device_id: deviceId,
          lower_angle: center,
          upper_angle: center,
        });
      } else if (this._oscillationCenterEntity()) {
        await this._hass.callService("number", "set_value", {
          entity_id: this._oscillationCenterEntity(),
          value: center,
        });
        await this._hass.callService("fan", "oscillate", {
          entity_id: this._config.entity,
          oscillating: true,
        });
      } else {
        await this._hass.callService("hass_dyson", "set_oscillation_angles", {
          device_id: deviceId,
          lower_angle: lower,
          upper_angle: upper,
        });
        await this._hass.callService("fan", "oscillate", {
          entity_id: this._config.entity,
          oscillating: true,
        });
      }
    } catch (error) {
      this._clearPending(false);
      throw error;
    } finally {
      this._busy = false;
      this._draftDirection = null;
      this._draftWidth = null;
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
    return this._deviceAngleFromVisual(degrees);
  }

  _isPointerOnHandle(event, element, direction) {
    const rect = element.getBoundingClientRect();
    if (!rect.width) return false;
    const scale = rect.width / 320;
    const handle = this._pointForAngle(160, 160, 120, this._visualAngleFromDevice(direction));
    const x = (event.clientX - rect.left) / scale;
    const y = (event.clientY - rect.top) / scale;
    const distance = Math.hypot(x - handle.x, y - handle.y);
    return distance <= 28;
  }

  _bindWheel(attributes) {
    const wheel = this.shadowRoot?.querySelector(".wheel-button");
    if (!wheel || !this._deviceId()) return;

    const currentWidth = this._currentWidth(attributes);
    let draftDirection = this._currentDirection(attributes);

    const updateDraft = (event) => {
      draftDirection = this._angleFromPointer(event, wheel);
      this._draftDirection = draftDirection;
      this._draftWidth = currentWidth;
      this._updateDialPreview(draftDirection, currentWidth);
    };

    wheel.addEventListener("pointerdown", (event) => {
      if (!this._isPointerOnHandle(event, wheel, draftDirection)) return;
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
      this._draftDirection = null;
      this._draftWidth = null;
      this._render();
    });
  }

  _bindControls(attributes, powerState) {
    this._bindWheel(attributes);

    this.shadowRoot?.querySelector(".power-button")?.addEventListener("click", async () => {
      await this._setPower(powerState === "On" ? "off" : "on");
    });

    this.shadowRoot?.querySelector("[data-control='auto']")?.addEventListener("click", async () => {
      await this._setAutoMode(!this._isAutoMode(attributes.preset_mode || attributes.mode, attributes));
    });

    this.shadowRoot?.querySelector("[data-control='night']")?.addEventListener("click", async () => {
      await this._setNightMode(!this._nightModeOn(attributes));
    });

    this.shadowRoot?.querySelector(".speed-slider")?.addEventListener("change", async (event) => {
      await this._setFanSpeed(event.target.value);
    });

    this.shadowRoot?.querySelectorAll("[data-direction]")?.forEach((button) => {
      button.addEventListener("click", async () => {
        await this._setAirflowDirection(button.dataset.direction);
      });
    });

    this.shadowRoot?.querySelectorAll("[data-timer]")?.forEach((button) => {
      button.addEventListener("click", async () => {
        await this._setSleepTimer(Number(button.dataset.timer));
      });
    });

    this.shadowRoot?.querySelectorAll("[data-width]")?.forEach((button) => {
      button.addEventListener("click", async () => {
        const width = Number(button.dataset.width);
        await this._setSweepWidth(width, attributes);
      });
    });
  }

  async _setSweepWidth(width, attributes) {
    if (!this._hass || this._busy) return;
    const normalizedWidth = this._normalizeAngle(width);
    const direction = this._currentDirection(attributes);

    if (normalizedWidth === 0) {
      await this._commitDirection(direction, 0);
      return;
    }

    const selectEntity = this._oscillationSelectEntity();
    const option = `${normalizedWidth}\u00b0`;
    const options = this._stateObj(selectEntity)?.attributes?.options || [];
    if (selectEntity && options.includes(option)) {
      this._busy = true;
      this._setPendingDirection(direction, normalizedWidth, `Applying ${option} sweep`);
      this._render();
      try {
        await this._hass.callService("select", "select_option", {
          entity_id: selectEntity,
          option,
        });
        await this._hass.callService("fan", "oscillate", {
          entity_id: this._config.entity,
          oscillating: true,
        });
      } catch (error) {
        this._clearPending(false);
        throw error;
      } finally {
        this._busy = false;
        this._render();
      }
      return;
    }

    await this._commitDirection(direction, normalizedWidth);
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
    const temp = this._stateValue(this._temperatureEntity(), "");
    const humidity = this._stateValue(this._humidityEntity(), "");
    const voc = this._displayState(this._vocEntity(), "");
    const airQuality = this._stateValue(this._airQualityEntity(), attributes.air_quality_category || "");
    const qualityLabel = this._qualityLabel(airQuality || attributes.air_quality_category);
    const qualityTone = this._qualityTone(qualityLabel);
    const speedPercent = this._currentSpeed(attributes);
    const filterPercent = this._filterPercent();
    const timerLabel = this._timerLabel(attributes);
    const activeTimer = Number(attributes.sleep_timer || 0);
    const autoActive = this._isAutoMode(mode, attributes);
    const nightActive = this._nightModeOn(attributes);
    const airflowDirection = this._fanDirection(attributes);
    const direction = this._currentDirection(attributes);
    const width = this._currentWidth(attributes);
    const bounds = this._boundsFromCenterWidth(direction, width);
    const visualCenter = this._visualAngleFromDevice(bounds.center);
    const handle = this._pointForAngle(160, 160, 120, visualCenter);
    const presetWidths = [0, 45, 90, 180, 350];
    const controlReady = Boolean(this._deviceId());
    const operationActive = this._busy || this._pendingActive();
    const operationLabel = this._busy
      ? this._pendingLabel || "Applying"
      : this._pendingActive()
        ? this._pendingLabel || "Waiting for device"
        : "";
    const travelPath = this._sectorPath(160, 160, 128, 5, 355);
    const travelRingPath = this._arcPath(160, 160, 128, 5, 355);
    const lowerLimitInner = this._pointForAngle(160, 160, 54, 5);
    const lowerLimitOuter = this._pointForAngle(160, 160, 132, 5);
    const upperLimitInner = this._pointForAngle(160, 160, 54, 355);
    const upperLimitOuter = this._pointForAngle(160, 160, 132, 355);
    const conePath = bounds.width
      ? this._sectorPath(160, 160, 128, this._visualAngleFromDevice(bounds.lower), this._visualAngleFromDevice(bounds.upper))
      : "";
    const directPath = this._arcPath(160, 160, 116, visualCenter - 1, visualCenter + 1);

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        ha-card {
          padding: 16px;
          border-radius: 20px;
          overflow: hidden;
        }
        .card {
          display: grid;
          gap: 14px;
        }
        .hero {
          border-radius: 18px;
          padding: 16px;
          background: linear-gradient(135deg, color-mix(in srgb, var(--primary-color, #2a9d8f) 72%, #2fbf71), color-mix(in srgb, var(--primary-color, #2a9d8f) 42%, #111));
          color: #fff;
          display: grid;
          gap: 12px;
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
          font-size: 1rem;
          font-weight: 700;
          line-height: 1.2;
        }
        .subtitle {
          font-size: 0.78rem;
          color: rgba(255, 255, 255, 0.74);
        }
        .quality {
          display: grid;
          gap: 2px;
          text-align: center;
        }
        .quality span {
          font-size: 0.78rem;
          color: rgba(255, 255, 255, 0.72);
        }
        .quality strong {
          font-size: 2.35rem;
          line-height: 1;
          font-weight: 760;
        }
        .status-row {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 8px;
        }
        .status-stat {
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 7px;
          border-radius: 12px;
          padding: 8px;
          background: rgba(255, 255, 255, 0.14);
          color: #fff;
        }
        .status-stat ha-icon {
          --mdc-icon-size: 18px;
          flex: 0 0 auto;
          color: rgba(255, 255, 255, 0.86);
        }
        .status-stat div {
          min-width: 0;
          display: grid;
          gap: 1px;
        }
        .status-stat strong {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 1rem;
          line-height: 1.1;
        }
        .status-stat span {
          color: rgba(255, 255, 255, 0.72);
          font-size: 0.68rem;
          font-weight: 700;
        }
        .chip {
          border-radius: 999px;
          padding: 7px 11px;
          font-size: 0.78rem;
          font-weight: 700;
          background: rgba(255, 255, 255, 0.18);
          color: #fff;
        }
        .control-panel {
          display: grid;
          gap: 14px;
          border: 1px solid var(--divider-color);
          border-radius: 16px;
          padding: 12px;
          background: color-mix(in srgb, var(--card-background-color, #fff) 94%, #000 6%);
        }
        .control-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 7px;
        }
        .control-pill,
        .timer-chip,
        .direction-chip {
          min-width: 0;
          border: 1px solid var(--divider-color);
          border-radius: 12px;
          padding: 9px 8px;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color);
          font: inherit;
          font-size: 0.78rem;
          font-weight: 750;
        }
        .control-pill {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
        }
        .control-pill ha-icon {
          --mdc-icon-size: 16px;
        }
        .control-pill.active,
        .timer-chip.active,
        .direction-chip.active {
          border-color: transparent;
          background: color-mix(in srgb, var(--primary-color, #4f46e5) 18%, transparent);
          color: var(--primary-text-color);
        }
        .slider-row,
        .filter-row,
        .direction-row,
        .timer-row {
          display: grid;
          gap: 8px;
        }
        .row-label {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          color: var(--secondary-text-color);
          font-size: 0.74rem;
          font-weight: 750;
        }
        .speed-slider {
          width: 100%;
          accent-color: var(--primary-color, #4f46e5);
        }
        .direction-buttons,
        .timer-buttons {
          display: grid;
          gap: 8px;
        }
        .direction-buttons {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .timer-buttons {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .filter-track {
          height: 8px;
          border-radius: 999px;
          overflow: hidden;
          background: color-mix(in srgb, var(--secondary-text-color) 16%, transparent);
        }
        .filter-fill {
          height: 100%;
          width: ${filterPercent ?? 0}%;
          background: color-mix(in srgb, var(--primary-color, #4f46e5) 75%, #3ddc84);
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
          cursor: default;
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
        .wheel-limit {
          stroke: color-mix(in srgb, var(--primary-text-color, #111) 28%, transparent);
          stroke-width: 3;
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
          cursor: ${controlReady ? "grab" : "default"};
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
          font: 700 15px system-ui, sans-serif;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .wheel-core-status {
          fill: var(--secondary-text-color);
          font: 600 10px system-ui, sans-serif;
          letter-spacing: 0.02em;
        }
        .wheel-spinner {
          fill: none;
          stroke: var(--primary-color, #4f46e5);
          stroke-width: 3;
          stroke-linecap: round;
          stroke-dasharray: 18 34;
          transform-origin: 160px 160px;
          animation: dyson-spin 0.9s linear infinite;
        }
        @keyframes dyson-spin {
          to {
            transform: rotate(360deg);
          }
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
        .helper {
          font-size: 0.78rem;
          color: var(--secondary-text-color);
          text-align: center;
        }
        .debug-panel {
          border: 1px solid var(--divider-color);
          border-radius: 12px;
          padding: 10px 12px;
          background: color-mix(in srgb, var(--card-background-color, #fff) 92%, #000 8%);
        }
        .debug-panel > summary,
        .debug-entity > summary {
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          font-size: 0.78rem;
          font-weight: 700;
          color: var(--primary-text-color);
        }
        .debug-panel > summary strong,
        .debug-entity > summary strong {
          color: var(--secondary-text-color);
          font-size: 0.72rem;
          font-weight: 700;
          white-space: nowrap;
        }
        .debug-grid {
          display: grid;
          gap: 8px;
          margin-top: 10px;
        }
        .debug-row {
          display: grid;
          gap: 4px;
        }
        .debug-label {
          color: var(--secondary-text-color);
          font-size: 0.7rem;
          font-weight: 700;
          text-transform: uppercase;
        }
        .debug-value {
          margin: 0;
          max-height: 180px;
          overflow: auto;
          border-radius: 8px;
          padding: 8px;
          background: color-mix(in srgb, var(--card-background-color, #fff) 82%, #000 18%);
          color: var(--primary-text-color);
          font: 600 0.72rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .debug-entities {
          display: grid;
          gap: 8px;
          margin-top: 10px;
        }
        .debug-entity {
          border-top: 1px solid var(--divider-color);
          padding-top: 8px;
        }
        .debug-entity-body {
          display: grid;
          gap: 8px;
          margin-top: 8px;
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
          .status-row {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .preset-row {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
        }
      </style>
      <ha-card>
        <div class="card ${this._busy ? "busy" : ""}">
          <div class="hero ${qualityTone}">
            <div class="header">
              <div class="title-stack">
                <div class="title">${this._escapeHtml(title)}</div>
                <div class="subtitle">${this._displayAngle(bounds.center, bounds.width)} · ${speedPercent}% airflow</div>
              </div>
              <div class="chip">${powerState}</div>
            </div>

            <div class="quality">
              <span>Air quality</span>
              <strong>${this._escapeHtml(qualityLabel)}</strong>
            </div>

            <div class="status-row">
              ${this._renderStatusStat("Temp", temp || "—", "mdi:thermometer", "neutral", temp ? this._unit(this._temperatureEntity(), "\u00b0") : "")}
              ${this._renderStatusStat("Humidity", humidity || "—", "mdi:water-percent", "neutral", humidity ? this._unit(this._humidityEntity(), "%") : "")}
              ${this._renderStatusStat("VOC", voc || "—", "mdi:circle-medium", qualityTone, voc ? this._unit(this._vocEntity(), "") : "")}
              ${this._renderStatusStat("Filter", filterPercent === null ? "—" : filterPercent, "mdi:air-filter", filterPercent === null || filterPercent > 20 ? "good" : "poor", filterPercent === null ? "" : "%")}
            </div>
          </div>

          <div class="control-panel">
            <div class="control-grid">
              <button class="control-pill power-button ${powerState === "On" ? "active" : ""}">
                <ha-icon icon="mdi:power"></ha-icon>
                <span>${powerState === "On" ? "On" : "Off"}</span>
              </button>
              ${this._renderToggleButton("auto", "Auto", "mdi:auto-mode", autoActive)}
              ${this._renderToggleButton("night", "Night", "mdi:weather-night", nightActive, !this._nightModeEntity())}
            </div>

            <div class="slider-row">
              <div class="row-label">
                <span>Airflow speed</span>
                <strong>${speedPercent}%</strong>
              </div>
              <input class="speed-slider" type="range" min="0" max="100" step="10" value="${speedPercent}" />
            </div>

            <div class="direction-row">
              <div class="row-label">
                <span>Airflow direction</span>
                <strong>${this._escapeHtml(airflowDirection)}</strong>
              </div>
              <div class="direction-buttons">
                <button class="direction-chip ${airflowDirection === "forward" ? "active" : ""}" data-direction="forward">Forward</button>
                <button class="direction-chip ${airflowDirection === "reverse" ? "active" : ""}" data-direction="reverse">Reverse</button>
              </div>
            </div>

            <div class="timer-row">
              <div class="row-label">
                <span>Sleep timer</span>
                <strong>${timerLabel}</strong>
              </div>
              <div class="timer-buttons">
                ${this._renderTimerButton(60, "1H", activeTimer)}
                ${this._renderTimerButton(180, "3H", activeTimer)}
                ${this._renderTimerButton(300, "5H", activeTimer)}
              </div>
            </div>

            <div class="filter-row">
              <div class="row-label">
                <span>Filter life</span>
                <strong>${filterPercent === null ? "Unknown" : `${filterPercent}%`}</strong>
              </div>
              <div class="filter-track"><div class="filter-fill"></div></div>
            </div>
          </div>

          <div class="control-shell">
            <button class="wheel-button" aria-label="Set Dyson direction">
              <svg class="wheel" viewBox="0 0 320 320" role="img" aria-hidden="true">
                <path class="wheel-bg" d="${travelPath}"></path>
                <path class="wheel-ring" d="${travelRingPath}"></path>
                <line class="wheel-limit" x1="${lowerLimitInner.x}" y1="${lowerLimitInner.y}" x2="${lowerLimitOuter.x}" y2="${lowerLimitOuter.y}"></line>
                <line class="wheel-limit" x1="${upperLimitInner.x}" y1="${upperLimitInner.y}" x2="${upperLimitOuter.x}" y2="${upperLimitOuter.y}"></line>
                <path class="wheel-cone" d="${conePath}" style="${bounds.width ? "" : "display:none;"}"></path>
                <path class="wheel-direct" d="${directPath}" style="${bounds.width ? "display:none;" : ""}"></path>
                <circle class="wheel-core" cx="160" cy="160" r="48"></circle>
                <circle class="wheel-core-inner" cx="160" cy="160" r="36"></circle>
                ${operationActive ? `<circle class="wheel-spinner" cx="160" cy="160" r="42"></circle>` : ""}
                <text class="wheel-core-label" x="160" y="${operationActive ? "158" : "166"}" text-anchor="middle">Dyson</text>
                ${operationActive ? `<text class="wheel-core-status" x="160" y="177" text-anchor="middle">${operationLabel}</text>` : ""}
                <circle class="wheel-handle" cx="${handle.x}" cy="${handle.y}" r="13"></circle>
              </svg>
            </button>

            <div class="direction-readout">
              <div class="direction-angle">${bounds.center}\u00b0</div>
              <div class="direction-copy">
                ${controlReady ? "Drag the dial to aim the fan. Use presets to widen or collapse the cone." : "This card is still resolving the related Dyson device and companion entities from the selected fan entity."}
              </div>
            </div>

            <div class="preset-row">
              ${presetWidths.map((preset) => `
                <button class="preset ${bounds.width === preset ? "selected" : ""}" data-width="${preset}">
                  ${preset === 0 ? "Direct" : `${preset}\u00b0`}
                </button>
              `).join("")}
            </div>
          </div>

          ${this._renderDebugPanel(entityId, attributes, bounds, direction, width, controlReady)}

          ${controlReady ? "" : `<div class="helper">This card is still resolving the related Dyson device and companion entities from the selected fan entity.</div>`}
        </div>
      </ha-card>
    `;

    this._bindControls(attributes, powerState);
  }
}

customElements.define("ha-dyson-card", HaDysonCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ha-dyson-card",
  name: "HA Dyson Card",
  description: "A Dyson Lovelace card with direct oscillation aiming and cone-width control.",
});
