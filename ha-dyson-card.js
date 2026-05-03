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
    this._timerMenuOpen = false;
    this._customTimerOpen = false;
    this._presetEditorOpen = false;
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
    this._timerMenuOpen = false;
    this._customTimerOpen = false;
    this._presetEditorOpen = false;
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
      climateEntity: this._findFirstEntity(sameDevice, "climate"),
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

  _findFirstEntity(entries, domain) {
    return entries.find((entry) => entry.entity_id?.startsWith(`${domain}.`))?.entity_id || "";
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

  _climateEntity() {
    return this._derived?.climateEntity || "";
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
    const handleHit = wheel.querySelector(".wheel-handle-hit");
    const angleNode = wheel.querySelector(".center-angle");
    const sweepNode = wheel.querySelector(".center-sweep");

    if (angleNode) {
      angleNode.textContent = `${bounds.center}\u00b0`;
    }
    if (sweepNode) {
      sweepNode.textContent = `${bounds.width}\u00b0 sweep`;
    }
    if (handleCircle) {
      handleCircle.setAttribute("cx", String(handle.x));
      handleCircle.setAttribute("cy", String(handle.y));
    }
    if (handleHit) {
      handleHit.style.left = `calc(50% - 146px + ${(handle.x / 320) * 292}px)`;
      handleHit.style.top = `${(handle.y / 320) * 292}px`;
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

  _fanFeature(attributes, featureBit) {
    const features = Number(attributes.supported_features);
    return Number.isFinite(features) && (features & featureBit) === featureBit;
  }

  _supportsFanSpeed(attributes) {
    return this._fanFeature(attributes, 1) || attributes.percentage !== undefined;
  }

  _supportsFanDirection(attributes) {
    return this._fanFeature(attributes, 4) || attributes.direction !== undefined || attributes.current_direction !== undefined;
  }

  _supportsAutoMode(attributes) {
    const presetModes = attributes.preset_modes || attributes.presetModes || [];
    return (Array.isArray(presetModes) && presetModes.some((preset) => String(preset).toLowerCase() === "auto"))
      || attributes.auto_mode !== undefined
      || String(attributes.mode || attributes.preset_mode || "").toLowerCase() === "auto";
  }

  _fanModes(attributes) {
    const modes = attributes.preset_modes || attributes.presetModes || [];
    return Array.isArray(modes) && modes.length ? modes : ["Manual", "Auto"];
  }

  _climateAttributes() {
    return this._stateObj(this._climateEntity())?.attributes || {};
  }

  _heatModes(attributes) {
    const modes = attributes.hvac_modes || [];
    return Array.isArray(modes) ? modes : [];
  }

  _targetTemperature(attributes) {
    const value = Number(attributes.temperature ?? attributes.target_temperature);
    return Number.isFinite(value) ? value : null;
  }

  _hasHeatMode(modes, mode) {
    return Array.isArray(modes) && modes.includes(mode);
  }

  _renderSelectOption(value, currentValue, label = value) {
    return `<option value="${this._escapeHtml(value)}" ${String(currentValue) === String(value) ? "selected" : ""}>${this._escapeHtml(label)}</option>`;
  }

  _presetStorageKey() {
    return `ha-dyson-card:direction-presets:${this._config.entity || "default"}`;
  }

  _directionPresets() {
    try {
      const raw = window.localStorage?.getItem(this._presetStorageKey());
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((preset) => {
          const direction = Number(preset.direction);
          const width = Number(preset.width);
          return {
            id: String(preset.id || ""),
            name: String(preset.name || "").trim(),
            icon: String(preset.icon || "mdi:crosshairs-gps").trim(),
            direction: Number.isFinite(direction) ? this._normalizeAngle(direction) : NaN,
            width: Number.isFinite(width) ? this._normalizeAngle(width) : NaN,
          };
        })
        .filter((preset) => preset.id && preset.name && Number.isFinite(preset.direction) && Number.isFinite(preset.width));
    } catch (_error) {
      return [];
    }
  }

  _saveDirectionPresets(presets) {
    try {
      window.localStorage?.setItem(this._presetStorageKey(), JSON.stringify(presets));
    } catch (_error) {
      // Local storage can be unavailable in restricted browser contexts.
    }
  }

  _addDirectionPreset(name, icon, direction, width) {
    const trimmedName = String(name || "").trim();
    if (!trimmedName) return;
    const normalizedIcon = String(icon || "mdi:crosshairs-gps").trim() || "mdi:crosshairs-gps";
    const presets = this._directionPresets();
    presets.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: trimmedName,
      icon: normalizedIcon.startsWith("mdi:") ? normalizedIcon : `mdi:${normalizedIcon}`,
      direction: this._normalizeAngle(direction),
      width: this._normalizeAngle(width),
    });
    this._saveDirectionPresets(presets);
  }

  _removeDirectionPreset(id) {
    this._saveDirectionPresets(this._directionPresets().filter((preset) => preset.id !== id));
  }

  _renderDirectionPresets(direction, width, controlReady) {
    const presets = this._directionPresets();
    const disabled = controlReady ? "" : "disabled";
    const editor = this._presetEditorOpen ? `
      <div class="preset-editor">
        <input class="preset-name-input" type="text" placeholder="Name" aria-label="Preset name" />
        <input class="preset-icon-input" type="text" placeholder="mdi:bed" aria-label="Preset icon" />
        <button class="preset-action" data-preset-save>Save</button>
        <button class="preset-action" data-preset-cancel>Cancel</button>
      </div>
    ` : "";

    return `
      <div class="direction-presets">
        <div class="direction-presets-row">
          ${presets.map((preset) => `
            <div class="direction-preset-item">
              <button class="direction-preset-button" data-preset-apply="${this._escapeHtml(preset.id)}" title="${this._escapeHtml(this._displayAngle(preset.direction, preset.width))}" ${disabled}>
                <ha-icon icon="${this._escapeHtml(preset.icon)}"></ha-icon>
                <span>${this._escapeHtml(preset.name)}</span>
              </button>
              <button class="direction-preset-remove" data-preset-remove="${this._escapeHtml(preset.id)}" aria-label="Remove ${this._escapeHtml(preset.name)}">×</button>
            </div>
          `).join("")}
          <button class="direction-preset-add" data-preset-add aria-label="Save current Dyson direction" ${disabled}>
            <ha-icon icon="mdi:plus"></ha-icon>
          </button>
        </div>
        ${editor}
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

  _renderWidthOption(preset, currentWidth) {
    const label = preset === 0 ? "Direct" : `${preset}\u00b0`;
    return `<option value="${preset}" ${currentWidth === preset ? "selected" : ""}>${label}</option>`;
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
      climate_entity: this._climateEntity(),
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
    const attributes = this._stateObj(this._config.entity)?.attributes || {};
    if (!this._hass || !this._config.entity || this._busy || !this._supportsAutoMode(attributes)) return;
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

  async _setFanMode(mode) {
    if (!this._hass || !this._config.entity || this._busy || !mode) return;
    this._busy = true;
    this._render();
    try {
      await this._hass.callService("fan", "set_preset_mode", {
        entity_id: this._config.entity,
        preset_mode: mode,
      });
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _setHeatMode(mode) {
    const entityId = this._climateEntity();
    if (!this._hass || !entityId || this._busy || !mode) return;
    this._busy = true;
    this._render();
    try {
      await this._hass.callService("climate", "set_hvac_mode", {
        entity_id: entityId,
        hvac_mode: mode,
      });
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _setTargetTemperature(temperature) {
    const entityId = this._climateEntity();
    const value = Number(temperature);
    if (!this._hass || !entityId || this._busy || !Number.isFinite(value)) return;
    this._busy = true;
    this._render();
    try {
      await this._hass.callService("climate", "set_temperature", {
        entity_id: entityId,
        temperature: value,
      });
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _adjustTargetTemperature(delta) {
    const climateAttributes = this._climateAttributes();
    const current = this._targetTemperature(climateAttributes);
    if (current === null) return;
    const step = Number(climateAttributes.target_temp_step ?? 1);
    const min = Number(climateAttributes.min_temp ?? 1);
    const max = Number(climateAttributes.max_temp ?? 37);
    const next = current + delta * (Number.isFinite(step) && step > 0 ? step : 1);
    const clamped = Math.min(Number.isFinite(max) ? max : next, Math.max(Number.isFinite(min) ? min : next, next));
    await this._setTargetTemperature(Number(clamped.toFixed(1)));
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
    const attributes = this._stateObj(this._config.entity)?.attributes || {};
    if (!this._hass || !this._config.entity || this._busy || !this._supportsFanSpeed(attributes)) return;
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
    const attributes = this._stateObj(this._config.entity)?.attributes || {};
    if (!this._hass || !this._config.entity || this._busy || !this._supportsFanDirection(attributes)) return;
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
    const handleTarget = this.shadowRoot?.querySelector(".wheel-handle-hit");
    if (!wheel || !handleTarget || !this._deviceId()) return;

    const currentWidth = this._currentWidth(attributes);
    let draftDirection = this._currentDirection(attributes);

    const updateDraft = (event) => {
      draftDirection = this._angleFromPointer(event, wheel);
      this._draftDirection = draftDirection;
      this._draftWidth = currentWidth;
      this._updateDialPreview(draftDirection, currentWidth);
    };

    handleTarget.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this._draggingDial = true;
      handleTarget.setPointerCapture?.(event.pointerId);
      updateDraft(event);
    });

    handleTarget.addEventListener("pointermove", (event) => {
      if (!this._draggingDial) return;
      event.preventDefault();
      updateDraft(event);
    });

    const finish = async (event) => {
      if (!this._draggingDial) return;
      event.preventDefault();
      this._draggingDial = false;
      handleTarget.releasePointerCapture?.(event.pointerId);
      updateDraft(event);
      await this._commitDirection(draftDirection, currentWidth);
    };

    handleTarget.addEventListener("pointerup", finish);
    handleTarget.addEventListener("pointercancel", () => {
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

    this.shadowRoot?.querySelectorAll("[data-hvac-mode]")?.forEach((button) => {
      button.addEventListener("click", async () => {
        await this._setHeatMode(button.dataset.hvacMode);
      });
    });

    this.shadowRoot?.querySelectorAll("[data-temp-step]")?.forEach((button) => {
      button.addEventListener("click", async () => {
        await this._adjustTargetTemperature(Number(button.dataset.tempStep));
      });
    });

    this.shadowRoot?.querySelector(".target-temp-input")?.addEventListener("change", async (event) => {
      await this._setTargetTemperature(event.target.value);
    });

    this.shadowRoot?.querySelector("[data-control='night']")?.addEventListener("click", async () => {
      await this._setNightMode(!this._nightModeOn(attributes));
    });

    const speedSlider = this.shadowRoot?.querySelector(".speed-slider");
    speedSlider?.addEventListener("input", (event) => {
      const nextSpeed = Math.max(0, Math.min(100, Math.round(Number(event.target.value))));
      this._setPendingSpeed(nextSpeed);
      this.shadowRoot?.querySelectorAll(".speed-value").forEach((node) => {
        node.textContent = `${nextSpeed}%`;
      });
    });
    speedSlider?.addEventListener("change", async (event) => {
      await this._setFanSpeed(event.target.value);
    });

    this.shadowRoot?.querySelectorAll("[data-direction]")?.forEach((button) => {
      button.addEventListener("click", async () => {
        await this._setAirflowDirection(button.dataset.direction);
      });
    });

    this.shadowRoot?.querySelectorAll("[data-timer]")?.forEach((button) => {
      button.addEventListener("click", async () => {
        this._timerMenuOpen = false;
        this._customTimerOpen = false;
        await this._setSleepTimer(Number(button.dataset.timer));
      });
    });

    this.shadowRoot?.querySelector("[data-timer-toggle]")?.addEventListener("click", () => {
      this._timerMenuOpen = !this._timerMenuOpen;
      if (!this._timerMenuOpen) {
        this._customTimerOpen = false;
      }
      this._render();
    });

    this.shadowRoot?.querySelector("[data-timer-custom]")?.addEventListener("click", () => {
      this._timerMenuOpen = true;
      this._customTimerOpen = true;
      this._render();
    });

    this.shadowRoot?.querySelector("[data-timer-cancel]")?.addEventListener("click", () => {
      this._customTimerOpen = false;
      this._render();
    });

    this.shadowRoot?.querySelector("[data-timer-set]")?.addEventListener("click", async () => {
      const input = this.shadowRoot?.querySelector(".timer-custom-input");
      const requestedHours = Number(input?.value);
      if (!Number.isFinite(requestedHours) || requestedHours <= 0) return;
      const hours = Math.max(1, Math.min(9, Math.round(requestedHours)));
      this._timerMenuOpen = false;
      this._customTimerOpen = false;
      await this._setSleepTimer(hours * 60);
    });

    this.shadowRoot?.querySelector(".preset-select")?.addEventListener("change", async (event) => {
      await this._setSweepWidth(Number(event.target.value), attributes);
    });

    this.shadowRoot?.querySelector("[data-preset-add]")?.addEventListener("click", () => {
      this._presetEditorOpen = true;
      this._render();
    });

    this.shadowRoot?.querySelector("[data-preset-cancel]")?.addEventListener("click", () => {
      this._presetEditorOpen = false;
      this._render();
    });

    this.shadowRoot?.querySelector("[data-preset-save]")?.addEventListener("click", () => {
      const name = this.shadowRoot?.querySelector(".preset-name-input")?.value;
      const icon = this.shadowRoot?.querySelector(".preset-icon-input")?.value;
      this._addDirectionPreset(name, icon, this._currentDirection(attributes), this._currentWidth(attributes));
      this._presetEditorOpen = false;
      this._render();
    });

    this.shadowRoot?.querySelectorAll("[data-preset-apply]")?.forEach((button) => {
      button.addEventListener("click", async () => {
        const preset = this._directionPresets().find((candidate) => candidate.id === button.dataset.presetApply);
        if (!preset) return;
        await this._commitDirection(preset.direction, preset.width);
      });
    });

    this.shadowRoot?.querySelectorAll("[data-preset-remove]")?.forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        this._removeDirectionPreset(button.dataset.presetRemove);
        this._render();
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

    const title = String(this._config.title || "").trim();
    const attributes = fan.attributes || {};
    const powerState = fan.state === "on" ? "On" : "Off";
    const mode = attributes.preset_mode || attributes.mode || "Unknown";
    const climateAttributes = this._climateAttributes();
    const heatMode = this._stateValue(this._climateEntity(), "");
    const heatModes = this._heatModes(climateAttributes);
    const targetTemperature = this._targetTemperature(climateAttributes);
    const minTemp = Number(climateAttributes.min_temp ?? 1);
    const maxTemp = Number(climateAttributes.max_temp ?? 37);
    const targetTempStep = Number(climateAttributes.target_temp_step ?? 1);
    const tempUnit = climateAttributes.temperature_unit || this._unit(this._temperatureEntity(), "\u00b0");
    const temp = this._stateValue(this._temperatureEntity(), "");
    const humidity = this._stateValue(this._humidityEntity(), "");
    const voc = this._displayState(this._vocEntity(), "");
    const vocTone = voc ? this._qualityTone(this._qualityLabel(voc)) : "neutral";
    const speedPercent = this._currentSpeed(attributes);
    const filterPercent = this._filterPercent();
    const timerLabel = this._timerLabel(attributes);
    const activeTimer = Number(attributes.sleep_timer || 0);
    const autoActive = this._isAutoMode(mode, attributes);
    const autoAvailable = this._supportsAutoMode(attributes);
    const nightActive = this._nightModeOn(attributes);
    const airflowDirection = this._fanDirection(attributes);
    const airflowDirectionAvailable = this._supportsFanDirection(attributes);
    const speedAvailable = this._supportsFanSpeed(attributes);
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
          --dyson-panel-bg: color-mix(in srgb, var(--card-background-color, #fff) 94%, #000 6%);
          --dyson-field-bg: color-mix(in srgb, var(--card-background-color, #fff) 84%, transparent);
          --dyson-raised-bg: var(--card-background-color, #fff);
          --dyson-control-bg: color-mix(in srgb, var(--card-background-color, #fff) 92%, #000 8%);
          --dyson-inset-bg: color-mix(in srgb, var(--card-background-color, #fff) 84%, #000 16%);
          --dyson-border: var(--divider-color);
          --dyson-soft-border: color-mix(in srgb, var(--divider-color) 72%, transparent);
          --dyson-shadow: 0 4px 12px color-mix(in srgb, #000 16%, transparent);
          --dyson-inner-highlight: inset 0 1px 0 color-mix(in srgb, var(--primary-text-color) 5%, transparent);
          padding: 12px;
          border-radius: 18px;
          overflow: hidden;
        }
        @media (prefers-color-scheme: dark) {
          ha-card {
            --dyson-panel-bg: color-mix(in srgb, var(--card-background-color, #111) 82%, var(--primary-text-color) 6%, #000 12%);
            --dyson-field-bg: color-mix(in srgb, var(--card-background-color, #111) 78%, var(--primary-text-color) 8%, #000 14%);
            --dyson-raised-bg: color-mix(in srgb, var(--card-background-color, #111) 76%, var(--primary-text-color) 7%, #000 17%);
            --dyson-control-bg: color-mix(in srgb, var(--card-background-color, #111) 74%, var(--primary-text-color) 7%, #000 19%);
            --dyson-inset-bg: color-mix(in srgb, var(--card-background-color, #111) 68%, #000 24%, var(--primary-text-color) 8%);
            --dyson-border: color-mix(in srgb, var(--divider-color) 78%, var(--primary-text-color) 12%);
            --dyson-soft-border: color-mix(in srgb, var(--divider-color) 70%, var(--primary-text-color) 10%, transparent);
            --dyson-shadow: 0 8px 18px color-mix(in srgb, #000 32%, transparent);
            --dyson-inner-highlight: inset 0 1px 0 color-mix(in srgb, var(--primary-text-color) 8%, transparent);
          }
        }
        .card {
          display: grid;
          gap: 10px;
        }
        .header {
          display: block;
        }
        .title {
          font-size: 0.96rem;
          font-weight: 700;
          line-height: 1.2;
        }
        .control-panel {
          display: grid;
          gap: 10px;
          border: 1px solid var(--dyson-border);
          border-radius: 14px;
          padding: 10px;
          background: var(--dyson-panel-bg);
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
          border: 1px solid var(--dyson-border);
          border-radius: 999px;
          padding: 9px 8px;
          background: var(--dyson-raised-bg);
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
          --mdc-icon-size: 17px;
          width: 24px;
          height: 24px;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: color-mix(in srgb, var(--primary-text-color) 6%, transparent);
        }
        .control-pill.active,
        .timer-chip.active,
        .direction-chip.active {
          border-color: transparent;
          background: color-mix(in srgb, var(--primary-color, #4f46e5) 18%, transparent);
          color: var(--primary-text-color);
        }
        .airflow-row {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          align-items: start;
        }
        .direction-row,
        .preset-row {
          display: grid;
          grid-template-rows: auto 38px;
          gap: 6px;
          min-width: 0;
          border: 1px solid var(--dyson-soft-border);
          border-radius: 16px;
          padding: 8px;
          background: var(--dyson-field-bg);
        }
        .row-label {
          display: flex;
          align-items: center;
          justify-content: flex-start;
          gap: 6px;
          color: var(--secondary-text-color);
          font-size: 0.68rem;
          font-weight: 750;
          min-height: 20px;
        }
        .row-label span,
        .row-label strong {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .direction-buttons,
        .timer-buttons,
        .timer-custom {
          display: grid;
          gap: 8px;
        }
        .direction-buttons {
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 5px;
        }
        .timer-buttons {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .timer-custom {
          grid-template-columns: minmax(0, 1fr) auto auto;
          align-items: center;
        }
        .timer-custom-input,
        .preset-select,
        .target-temp-input {
          min-width: 0;
          border: 1px solid var(--dyson-border);
          border-radius: 12px;
          background: var(--dyson-raised-bg);
          color: var(--primary-text-color);
          font: inherit;
          font-size: 0.78rem;
          font-weight: 750;
        }
        .timer-custom-input {
          padding: 8px 10px;
        }
        .timer-action {
          border: 1px solid var(--dyson-border);
          border-radius: 12px;
          padding: 8px 10px;
          background: var(--dyson-raised-bg);
          color: var(--primary-text-color);
          font: inherit;
          font-size: 0.75rem;
          font-weight: 750;
        }
        .control-shell {
          display: grid;
          gap: 7px;
          justify-items: center;
        }
        .wheel-wrap {
          position: relative;
          width: 100%;
          height: 292px;
        }
        .wheel-button {
          appearance: none;
          border: 0;
          padding: 0;
          background: none;
          cursor: default;
          width: min(100%, 292px);
          margin: 0 auto;
          touch-action: pan-y;
          display: block;
        }
        .wheel {
          width: 100%;
          height: auto;
          display: block;
        }
        .wheel-bg {
          fill: color-mix(in srgb, var(--card-background-color, #ffffff) 78%, #000 22%);
          pointer-events: none;
        }
        .wheel-ring {
          fill: none;
          stroke: color-mix(in srgb, var(--primary-text-color, #111) 14%, transparent);
          stroke-width: 2;
          pointer-events: none;
        }
        .wheel-limit {
          stroke: color-mix(in srgb, var(--primary-text-color, #111) 28%, transparent);
          stroke-width: 3;
          stroke-linecap: round;
          pointer-events: none;
        }
        .wheel-cone {
          fill: color-mix(in srgb, var(--primary-color, #4f46e5) 22%, transparent);
          pointer-events: none;
        }
        .wheel-direct {
          fill: none;
          stroke: color-mix(in srgb, var(--primary-color, #4f46e5) 72%, white 8%);
          stroke-width: 8;
          stroke-linecap: round;
          pointer-events: none;
        }
        .wheel-handle {
          fill: var(--card-background-color, #fff);
          stroke: var(--primary-text-color, #111);
          stroke-width: 5;
          cursor: ${controlReady ? "grab" : "default"};
          pointer-events: none;
        }
        .wheel-handle-hit {
          position: absolute;
          left: calc(50% - 146px + ${(handle.x / 320) * 292}px);
          top: ${(handle.y / 320) * 292}px;
          width: 52px;
          height: 52px;
          transform: translate(-50%, -50%);
          border: 0;
          border-radius: 999px;
          padding: 0;
          background: transparent;
          cursor: ${controlReady ? "grab" : "default"};
          touch-action: none;
        }
        .wheel-handle-hit:active {
          cursor: grabbing;
        }
        .wheel-speed {
          position: absolute;
          right: 28px;
          top: 54px;
          bottom: 54px;
          display: grid;
          grid-template-rows: auto minmax(0, 1fr) auto;
          justify-items: center;
          gap: 7px;
          color: var(--secondary-text-color);
          font-size: 0.66rem;
          font-weight: 800;
          pointer-events: auto;
          z-index: 2;
        }
        .wheel-speed ha-icon {
          --mdc-icon-size: 15px;
          color: var(--primary-color, #4f46e5);
        }
        .speed-slider {
          width: 36px;
          height: 116px;
          accent-color: var(--primary-color, #4f46e5);
          writing-mode: vertical-lr;
          direction: rtl;
          touch-action: none;
        }
        .timer-flyout {
          position: absolute;
          right: 0;
          top: 10px;
          z-index: 3;
          display: grid;
          gap: 8px;
          width: min(210px, 72%);
          padding: 10px;
          border: 1px solid var(--dyson-border);
          border-radius: 14px;
          background: var(--dyson-raised-bg);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
        }
        .timer-icon-button {
          position: absolute;
          right: 14px;
          top: 16px;
          z-index: 4;
          width: 38px;
          height: 38px;
          border: 1px solid var(--dyson-border);
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          background: var(--dyson-raised-bg);
          color: var(--primary-text-color);
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
        }
        .timer-icon-button.active {
          border-color: transparent;
          background: color-mix(in srgb, var(--primary-color, #4f46e5) 18%, var(--card-background-color, #fff));
        }
        .timer-icon-button ha-icon {
          --mdc-icon-size: 20px;
        }
        .wheel-core {
          fill: color-mix(in srgb, var(--card-background-color, #ffffff) 88%, #000 12%);
          stroke: color-mix(in srgb, var(--primary-text-color, #111) 12%, transparent);
          stroke-width: 2;
          pointer-events: none;
        }
        .wheel-core-inner {
          fill: color-mix(in srgb, var(--card-background-color, #ffffff) 92%, #000 8%);
          pointer-events: none;
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
        .wheel-sensor-strip {
          position: absolute;
          left: 2px;
          top: 16px;
          display: grid;
          grid-template-columns: repeat(2, auto);
          align-items: center;
          justify-items: start;
          column-gap: 7px;
          row-gap: 5px;
          padding: 7px 8px;
          border-radius: 14px;
          background: var(--dyson-raised-bg);
          border: 1px solid var(--dyson-soft-border);
          pointer-events: none;
          color: var(--secondary-text-color);
          font-size: 0.6rem;
          font-weight: 760;
          line-height: 1;
          z-index: 1;
        }
        .wheel-sensor-strip ha-icon {
          --mdc-icon-size: 12px;
        }
        .sensor-temp,
        .sensor-humidity,
        .sensor-voc,
        .sensor-filter {
          display: inline-grid;
          grid-template-columns: 12px auto;
          align-items: center;
          justify-content: start;
          gap: 3px;
          min-width: 0;
        }
        .sensor-temp ha-icon {
          color: var(--primary-color, #4f46e5);
        }
        .sensor-temp ha-icon,
        .sensor-humidity ha-icon,
        .sensor-filter ha-icon,
        .voc-dot {
          justify-self: center;
        }
        .voc-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--secondary-text-color) 42%, transparent);
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--card-background-color, #fff) 78%, transparent);
        }
        .sensor-voc.good .voc-dot {
          background: #22c55e;
        }
        .sensor-voc.fair .voc-dot {
          background: #f59e0b;
        }
        .sensor-voc.poor .voc-dot {
          background: #ef4444;
        }
        .wheel-center-info {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          display: grid;
          gap: 4px;
          justify-items: center;
          width: 72px;
          pointer-events: none;
          color: var(--primary-text-color);
        }
        .center-angle {
          font-size: 1.1rem;
          font-weight: 850;
          line-height: 1;
        }
        .center-sweep {
          color: var(--secondary-text-color);
          font-size: 0.62rem;
          font-weight: 760;
          line-height: 1;
        }
        .center-operation {
          color: var(--secondary-text-color);
          font-size: 0.56rem;
          font-weight: 700;
          max-width: 72px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .preset-row {
          min-width: 0;
        }
        .preset-select {
          width: 100%;
          min-height: 38px;
          padding: 6px 8px;
        }
        .mode-row {
          box-sizing: border-box;
          display: flex;
          align-items: center;
          gap: 10px;
          justify-content: center;
          width: min(100%, 302px);
          height: 56px;
          padding: 7px 10px;
          border: 1px solid var(--dyson-border);
          border-radius: 999px;
          background: var(--dyson-control-bg);
          box-shadow:
            var(--dyson-inner-highlight),
            var(--dyson-shadow);
        }
        .mode-icon-button {
          box-sizing: border-box;
          width: 44px;
          height: 42px;
          border: 0;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          background: transparent;
          color: var(--secondary-text-color);
          font: inherit;
          font-size: 0.9rem;
          font-weight: 850;
        }
        .mode-icon-button ha-icon {
          --mdc-icon-size: 23px;
        }
        .mode-icon-button.active {
          background: color-mix(in srgb, var(--primary-color, #4f46e5) 18%, transparent);
          color: var(--primary-text-color);
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-color, #4f46e5) 18%, transparent);
        }
        .mode-icon-button:disabled,
        .temp-step-button:disabled,
        .target-temp-input:disabled,
        .speed-slider:disabled,
        .direction-preset-button:disabled,
        .direction-preset-add:disabled {
          opacity: 0.44;
        }
        .target-temp-wrap {
          display: grid;
          grid-template-columns: 38px minmax(0, 74px) 38px;
          gap: 0;
          align-items: center;
          min-width: 0;
          width: 150px;
          height: 42px;
          max-width: 100%;
          margin-left: auto;
          border-radius: 999px;
          background: var(--dyson-inset-bg);
          border: 1px solid var(--dyson-border);
          box-shadow:
            var(--dyson-inner-highlight);
        }
        .temp-step-button {
          box-sizing: border-box;
          width: 38px;
          height: 42px;
          border: 0;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          background: transparent;
          color: var(--primary-text-color);
          font: inherit;
          font-size: 1.12rem;
          font-weight: 820;
        }
        .target-temp-input {
          box-sizing: border-box;
          width: 100%;
          min-width: 0;
          height: 42px;
          min-height: 42px;
          border: 0;
          padding: 6px 5px;
          background: transparent;
          text-align: center;
          border-radius: 0;
          color: var(--primary-text-color);
          font-size: 0.84rem;
          font-weight: 850;
          appearance: textfield;
        }
        .target-temp-input::-webkit-outer-spin-button,
        .target-temp-input::-webkit-inner-spin-button {
          margin: 0;
          appearance: none;
        }
        .temp-value-wrap {
          position: relative;
          min-width: 0;
        }
        .target-temp-unit {
          position: absolute;
          right: 0;
          top: 50%;
          transform: translateY(-50%);
          color: var(--secondary-text-color);
          font-size: 0.62rem;
          font-weight: 800;
          pointer-events: none;
        }
        .helper {
          font-size: 0.78rem;
          color: var(--secondary-text-color);
          text-align: center;
        }
        .debug-panel {
          border: 1px solid var(--dyson-border);
          border-radius: 12px;
          padding: 10px 12px;
          background: var(--dyson-control-bg);
        }
        .direction-presets {
          display: grid;
          gap: 8px;
          width: 100%;
          border: 1px solid var(--dyson-border);
          border-radius: 16px;
          padding: 8px;
          background: var(--dyson-control-bg);
          box-shadow: var(--dyson-inner-highlight);
        }
        .direction-presets-row {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 38px;
          overflow-x: auto;
          scrollbar-width: none;
        }
        .direction-presets-row::-webkit-scrollbar {
          display: none;
        }
        .direction-preset-item {
          display: inline-flex;
          align-items: center;
          flex: 0 0 auto;
          border: 1px solid var(--dyson-border);
          border-radius: 999px;
          background: var(--dyson-raised-bg);
          overflow: hidden;
        }
        .direction-preset-button,
        .direction-preset-remove,
        .direction-preset-add,
        .preset-action {
          border: 0;
          background: transparent;
          color: var(--primary-text-color);
          font: inherit;
          font-weight: 800;
        }
        .direction-preset-button {
          min-width: 0;
          height: 38px;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 0 10px;
        }
        .direction-preset-button ha-icon,
        .direction-preset-add ha-icon {
          --mdc-icon-size: 18px;
          color: var(--secondary-text-color);
        }
        .direction-preset-button span {
          max-width: 92px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .direction-preset-remove {
          width: 30px;
          height: 38px;
          color: var(--secondary-text-color);
          border-left: 1px solid var(--dyson-border);
          font-size: 1rem;
        }
        .direction-preset-add {
          flex: 0 0 auto;
          width: 38px;
          height: 38px;
          border: 1px solid var(--dyson-border);
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: var(--dyson-raised-bg);
        }
        .preset-editor {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto auto;
          gap: 6px;
          align-items: center;
        }
        .preset-name-input,
        .preset-icon-input {
          min-width: 0;
          height: 34px;
          border: 1px solid var(--dyson-border);
          border-radius: 999px;
          padding: 0 10px;
          background: var(--dyson-inset-bg);
          color: var(--primary-text-color);
          font: inherit;
          font-size: 0.74rem;
          font-weight: 750;
        }
        .preset-action {
          height: 34px;
          border: 1px solid var(--dyson-border);
          border-radius: 999px;
          padding: 0 10px;
          background: var(--dyson-raised-bg);
          font-size: 0.72rem;
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
          background: var(--dyson-inset-bg);
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
          border-top: 1px solid var(--dyson-border);
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
          .airflow-row {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 6px;
          }
          .direction-chip {
            padding-inline: 6px;
            font-size: 0.7rem;
          }
          .timer-custom {
            grid-template-columns: 1fr 1fr;
          }
          .timer-custom-input {
            grid-column: 1 / -1;
          }
          .preset-editor {
            grid-template-columns: 1fr 1fr;
          }
          .preset-name-input,
          .preset-icon-input {
            grid-column: 1 / -1;
          }
        }
      </style>
      <ha-card>
        <div class="card ${this._busy ? "busy" : ""}">
          ${title ? `
            <div class="header">
              <div class="title">${this._escapeHtml(title)}</div>
            </div>
          ` : ""}

          <div class="control-panel">
            <div class="control-grid">
              <button class="control-pill power-button ${powerState === "On" ? "active" : ""}">
                <ha-icon icon="mdi:power"></ha-icon>
                <span>${powerState === "On" ? "On" : "Off"}</span>
              </button>
              ${this._renderToggleButton("auto", "Auto", "mdi:auto-mode", autoActive, !autoAvailable)}
              ${this._renderToggleButton("night", "Night", "mdi:weather-night", nightActive, !this._nightModeEntity())}
            </div>

            <div class="airflow-row">
              <div class="preset-row">
                <div class="row-label">
                  <span>Sweep</span>
                </div>
                <select class="preset-select" aria-label="Set sweep preset">
                  ${presetWidths.map((preset) => this._renderWidthOption(preset, bounds.width)).join("")}
                </select>
              </div>

              <div class="direction-row">
                <div class="row-label">
                  <span>Direction</span>
                </div>
                <div class="direction-buttons">
                  <button class="direction-chip ${airflowDirection === "forward" ? "active" : ""}" data-direction="forward" ${airflowDirectionAvailable ? "" : "disabled"}>Forward</button>
                  <button class="direction-chip ${airflowDirection === "reverse" ? "active" : ""}" data-direction="reverse" ${airflowDirectionAvailable ? "" : "disabled"}>Reverse</button>
                </div>
              </div>
            </div>
          </div>

          <div class="control-shell">
            <div class="wheel-wrap">
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
                  <circle class="wheel-handle" cx="${handle.x}" cy="${handle.y}" r="13"></circle>
                </svg>
              </button>
              <button class="wheel-handle-hit" aria-label="Drag to set Dyson direction"></button>
              <div class="wheel-speed">
                <ha-icon icon="mdi:fan"></ha-icon>
                <input class="speed-slider" type="range" min="0" max="100" step="10" value="${speedPercent}" aria-label="Set airflow speed" ${speedAvailable ? "" : "disabled"} />
                <span class="speed-value">${speedPercent}%</span>
              </div>
              <button class="timer-icon-button ${this._timerMenuOpen ? "active" : ""}" data-timer-toggle aria-label="Sleep timer ${this._escapeHtml(timerLabel)}">
                <ha-icon icon="mdi:timer-outline"></ha-icon>
              </button>
              <div class="wheel-sensor-strip">
                <span class="sensor-temp"><ha-icon icon="mdi:thermometer"></ha-icon>${this._escapeHtml(temp || "—")}${temp ? this._escapeHtml(this._unit(this._temperatureEntity(), "\u00b0")) : ""}</span>
                <span class="sensor-humidity"><ha-icon icon="mdi:water-percent"></ha-icon>${this._escapeHtml(humidity || "—")}${humidity ? this._escapeHtml(this._unit(this._humidityEntity(), "%")) : ""}</span>
                <span class="sensor-voc ${vocTone}"><span class="voc-dot" aria-hidden="true"></span>VOC</span>
                <span class="sensor-filter"><ha-icon icon="mdi:air-filter"></ha-icon>${filterPercent === null ? "—" : `${filterPercent}%`}</span>
              </div>
              <div class="timer-flyout" style="${this._timerMenuOpen ? "" : "display:none;"}">
                <div class="row-label">
                  <span>Sleep timer</span>
                  <strong>${timerLabel}</strong>
                </div>
                <div class="timer-buttons">
                  ${this._renderTimerButton(60, "1H", activeTimer)}
                  ${this._renderTimerButton(180, "3H", activeTimer)}
                  <button class="timer-chip ${this._customTimerOpen ? "active" : ""}" data-timer-custom>Custom</button>
                </div>
                <div class="timer-custom" style="${this._customTimerOpen ? "" : "display:none;"}">
                  <input class="timer-custom-input" type="number" min="1" max="9" step="1" inputmode="numeric" placeholder="Hours" />
                  <button class="timer-action" data-timer-set>Set</button>
                  <button class="timer-action" data-timer-cancel>Cancel</button>
                </div>
              </div>
              <div class="wheel-center-info">
                <div class="center-angle">${bounds.center}\u00b0</div>
                <div class="center-sweep">${bounds.width}\u00b0 sweep</div>
                ${operationActive ? `<div class="center-operation">${this._escapeHtml(operationLabel)}</div>` : ""}
              </div>
            </div>

            <div class="mode-row">
              <button class="mode-icon-button ${heatMode === "heat" ? "active" : ""}" data-hvac-mode="heat" aria-label="Heat mode" ${this._climateEntity() && this._hasHeatMode(heatModes, "heat") ? "" : "disabled"}>
                <ha-icon icon="mdi:fire"></ha-icon>
              </button>
              <button class="mode-icon-button ${heatMode === "fan_only" ? "active" : ""}" data-hvac-mode="fan_only" aria-label="Fan only mode" ${this._climateEntity() && this._hasHeatMode(heatModes, "fan_only") ? "" : "disabled"}>
                <ha-icon icon="mdi:fan"></ha-icon>
              </button>
              <div class="target-temp-wrap">
                <button class="temp-step-button" data-temp-step="-1" aria-label="Decrease target temperature" ${this._climateEntity() && targetTemperature !== null ? "" : "disabled"}>-</button>
                <div class="temp-value-wrap">
                  <input class="target-temp-input" type="number" min="${Number.isFinite(minTemp) ? minTemp : 1}" max="${Number.isFinite(maxTemp) ? maxTemp : 37}" step="${Number.isFinite(targetTempStep) ? targetTempStep : 1}" value="${targetTemperature ?? ""}" aria-label="Set target temperature" ${this._climateEntity() && targetTemperature !== null ? "" : "disabled"} />
                  <span class="target-temp-unit">${this._escapeHtml(tempUnit)}</span>
                </div>
                <button class="temp-step-button" data-temp-step="1" aria-label="Increase target temperature" ${this._climateEntity() && targetTemperature !== null ? "" : "disabled"}>+</button>
              </div>
            </div>

          </div>

          ${this._renderDirectionPresets(direction, width, controlReady)}

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
