/*! Evolute Card — universal Lovelace card for the Evolute (evassist) integration.
 *  Auto-discovers the Evolute device and matches entities by translation_key,
 *  so it works regardless of car model, language or auto-generated entity_ids.
 *  No build step, no dependencies. MIT License.
 */
const EVOLUTE_CARD_VERSION = "1.2.20b0";

// translation_key -> role. These keys come from the integration's entity
// descriptions and are stable across installs and locales.
const KEYS = {
  // sensors
  odometer: "odometer",
  battery_pct: "battery_pct",
  battery_temp: "battery_temp",
  remains_mileage: "remains_mileage",
  fuel_pct: "fuel_pct",
  remains_mileage_fuel: "remains_mileage_fuel",
  coolant_temp: "coolant_temp",
  voltage_12v: "voltage_12v",
  outside_temp: "outside_temp",
  inboard_temp: "inboard_temp",
  climate_target: "climate_target_temp",
  data_time: "sensor_time",
  signal_percent: "signal_percent",
  vin: "vin",
  command_status: "command_status",
  firmware_mismatch: "firmware_mismatch",
  settings_mismatch: "settings_mismatch",
  trip_preparation: "trip_preparation",
  // binary sensors
  online: "online",
  charging_gun: "charging_gun",
  trunk: "trunk",
  heating: "heating",
  cooling: "cooling",
  // controls
  lock: "central_lock",
  trunk_open: "trunk_open",
  trunk_close: "trunk_close",
  blink: "blink",
  heating_on: "heating_on",
  heating_off: "heating_off",
  cooling_on: "cooling_on",
  cooling_off: "cooling_off",
  trip_prepare_on: "trip_prepare_on",
  trip_prepare_off: "trip_prepare_off",
  // tracker
  tracker: "tracker",
};

const UNAVAILABLE = new Set(["unavailable", "unknown", "none", "", undefined, null]);
const COMMAND_BUSY = new Set(["sending", "pending", "delivered"]);
const COMMAND_NAMES = {
  centralLockingOn: "Закрытие замка", centralLockingOff: "Открытие замка",
  trunkOpen: "Открытие багажника", trunkClose: "Закрытие багажника",
  heatingOn: "Включение прогрева", heatingOff: "Выключение прогрева",
  coolingOn: "Включение охлаждения", coolingOff: "Выключение охлаждения",
  search: "Поиск автомобиля", tripPreparationOn: "Подготовка к поездке",
  tripPreparationOff: "Остановка подготовки",
};

const MODE_CONTROLS = {
  heating: { state: "heating", on: "heating_on", off: "heating_off" },
  cooling: { state: "cooling", on: "cooling_on", off: "cooling_off" },
  trip: { state: "trip_preparation", on: "trip_prepare_on", off: "trip_prepare_off" },
};

class EvoluteCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._deviceId = null;
    this._map = {};      // role -> entity_id
    this._sig = "";      // render signature to skip redundant repaints
    this._built = false;
    this._mapEl = null;
    this._requestPending = false;
    this._actionError = "";
  }

  setConfig(config) {
    this._config = config || {};
    this._deviceId = null;
    this._sig = "";
  }

  getCardSize() {
    return this._config.show_map ? 8 : 5;
  }

  connectedCallback() {
    if (!this._clock) {
      this._clock = setInterval(() => this._refreshDataTime(), 30000);
    }
  }

  disconnectedCallback() {
    if (this._clock) { clearInterval(this._clock); this._clock = null; }
  }

  static getStubConfig() {
    return { show_map: true };
  }

  set hass(hass) {
    this._hass = hass;
    if (!hass) return;
    this._resolve();
    this._render();
  }

  // ---- discovery -----------------------------------------------------------

  _evoluteEntities() {
    const ents = this._hass.entities || {};
    return Object.values(ents).filter((e) => e && e.platform === "evolute");
  }

  _resolve() {
    const all = this._evoluteEntities();
    if (!all.length) {
      this._deviceId = null;
      this._map = {};
      return;
    }
    // choose device
    let deviceId = this._config.device || null;
    if (!deviceId) {
      const devs = [...new Set(all.map((e) => e.device_id).filter(Boolean))];
      deviceId = devs[0] || null;
    }
    this._deviceId = deviceId;
    // build translation_key -> entity_id for this device
    const map = {};
    for (const e of all) {
      if (deviceId && e.device_id !== deviceId) continue;
      if (e.translation_key) map[e.translation_key] = e.entity_id;
    }
    this._map = map;
  }

  // ---- helpers -------------------------------------------------------------

  _eid(role) { return this._map[KEYS[role]]; }

  _st(role) {
    const id = this._eid(role);
    return id ? this._hass.states[id] : undefined;
  }

  _val(role) {
    const s = this._st(role);
    return s ? s.state : undefined;
  }

  _num(role, digits) {
    const v = Number(this._val(role));
    if (!Number.isFinite(v)) return null;
    return digits == null ? v : v.toFixed(digits);
  }

  _has(role) { return !!this._eid(role); }

  _device() {
    const d = this._hass.devices || {};
    return (this._deviceId && d[this._deviceId]) || null;
  }

  _title() {
    const dev = this._device();
    if (dev) return dev.name_by_user || dev.name || "Evolute";
    return "Evolute";
  }

  _vin() {
    const dev = this._device();
    if (dev && dev.serial_number) return dev.serial_number;
    const v = this._val("vin");
    return UNAVAILABLE.has(v) ? null : v;
  }

  // ---- actions -------------------------------------------------------------

  _moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId }, bubbles: true, composed: true,
    }));
  }

  _press(role) {
    const id = this._eid(role);
    if (id && this._st(role)?.state !== "unavailable") {
      return this._runCommand("button", "press", id);
    }
  }

  _lockToggle() {
    const s = this._st("lock");
    if (!s || !["locked", "unlocked"].includes(s.state)) return;
    const svc = s.state === "locked" ? "unlock" : "lock";
    return this._runCommand("lock", svc, s.entity_id);
  }

  _busy() {
    return this._requestPending || COMMAND_BUSY.has(this._val("command_status"))
      || ["locking", "unlocking"].includes(this._val("lock"));
  }

  _commandsDisabled() {
    return this._busy() || this._val("online") !== "on"
      || UNAVAILABLE.has(this._val("command_status"));
  }

  async _runCommand(domain, service, entityId) {
    if (this._commandsDisabled()) return;
    this._requestPending = true;
    this._actionError = "";
    this._render();
    try {
      await this._hass.callService(domain, service, { entity_id: entityId });
    } catch (error) {
      this._actionError = typeof error?.message === "string"
        ? error.message : "Не удалось выполнить команду. Проверьте состояние автомобиля.";
    } finally {
      this._requestPending = false;
      this._render();
    }
  }

  // ---- rendering -----------------------------------------------------------

  _signature() {
    // Repaint only when something visible changes.
    const roles = ["odometer", "online", "charging_gun", "signal_percent", "battery_pct", "battery_temp", "remains_mileage",
      "fuel_pct", "remains_mileage_fuel", "coolant_temp", "voltage_12v",
      "outside_temp", "inboard_temp", "climate_target", "data_time", "lock", "trunk", "heating", "cooling",
      "trunk_open", "trunk_close", "blink", "heating_on", "heating_off", "cooling_on", "cooling_off",
      "trip_preparation", "trip_prepare_on", "trip_prepare_off",
      "command_status", "firmware_mismatch", "settings_mismatch"];
    return JSON.stringify([
      this._deviceId, roles.map((r) => [this._eid(r), this._val(r)]),
      this._st("command_status")?.attributes, this._requestPending, this._actionError,
      this._st("firmware_mismatch")?.attributes, this._st("settings_mismatch")?.attributes,
      this._config,
    ]);
  }

  _render() {
    if (!this._hass) return;

    if (!this._deviceId) {
      this.shadowRoot.innerHTML =
        `<ha-card><div style="padding:16px">Не найдено устройство Evolute.
        Убедитесь, что интеграция установлена, или задайте <code>device:</code> в конфигурации карточки.</div></ha-card>`;
      this._built = false;
      return;
    }

    const sig = this._signature();
    if (this._built && sig === this._sig) {
      this._syncMap();
      return;
    }
    this._sig = sig;

    const num = (r, d) => { const v = this._num(r, d); return v == null ? "—" : v; };
    const online = this._val("online") === "on";
    const dot = online ? "var(--success-color,#5cbc63)" : "var(--disabled-color,#a8a8a8)";

    const hasFuel = this._has("fuel_pct") && !UNAVAILABLE.has(this._val("fuel_pct"));
    const battPct = Math.max(0, Math.min(100, Number(this._val("battery_pct")) || 0));
    const fuelPct = Math.max(0, Math.min(100, Number(this._val("fuel_pct")) || 0));

    const lockS = this._st("lock");
    const locked = lockS && lockS.state === "locked";
    const lockLabel = {
      locked: "Закрыт", unlocked: "Открыт", locking: "Закрывается…", unlocking: "Открывается…",
    }[lockS?.state] || "Состояние замка неизвестно";
    const trunkOpen = this._val("trunk") === "on";
    const heating = this._val("heating") === "on";
    const cooling = this._val("cooling") === "on";

    const cells = [
      ["coolant_temp", "mdi:thermometer-water", num("coolant_temp", 1) + "°C", false],
      ["voltage_12v", "mdi:car-battery", num("voltage_12v", 2) + " В", false],
      ["outside_temp", "mdi:weather-partly-cloudy", num("outside_temp", 1) + "°C", false],
      ["inboard_temp", "mdi:air-conditioner", this._cabinValue(), true],
    ].filter(([r]) => this._has(r));

    this.shadowRoot.innerHTML = `
      ${this._styles()}
      <ha-card>
        <div class="wrap">
          <div class="head">
            <div class="odo" data-act="mi" data-role="odometer">
              ${this._signalBadge()}
              ${this._val("charging_gun") === "on"
                ? `<ha-icon class="plug" data-act="mi" data-role="charging_gun" icon="mdi:ev-plug-type2"
                    role="img" aria-label="Зарядный пистолет вставлен" title="Зарядный пистолет вставлен" style="color:${dot}"></ha-icon>`
                : `<span class="dot" title="${online ? "Машина онлайн" : "Машина оффлайн"}" style="background:${dot}"></span>`}
              <ha-icon icon="mdi:counter"></ha-icon>
              <span>${num("odometer", 0)} км</span>
            </div>
            <div class="model">
              <div class="m">${this._escape(this._title())}</div>
              <div class="vin">${this._escape(this._vin() || "—")}</div>
            </div>
          </div>

          ${this._dataTimeRow()}

          <div class="bars">
            ${hasFuel ? this._bar("mdi:fuel", fuelPct, "fuel_pct") : ""}
            ${this._bar("mdi:lightning-bolt", battPct, "battery_pct")}
            ${hasFuel ? this._barVal(num("fuel_pct", 0) + "% / " + num("remains_mileage_fuel", 0) + "км", "fuel_pct") : ""}
            ${this._barVal(num("battery_temp", 0) + "°C / " + num("battery_pct", 0) + "% / " + num("remains_mileage", 0) + " км", "battery_pct")}
          </div>

          ${cells.length ? `<div class="cells">${cells.map(([r, ic, txt, center]) => `
            <div class="cell${center ? " cell--center" : ""}" data-act="mi" data-role="${r}">
              <div class="cv">${txt}</div>
              <ha-icon class="cl" icon="${ic}"></ha-icon>
            </div>`).join("")}</div>` : ""}

          <div class="ctrls">
            ${lockS ? this._btn("lock", locked ? "mdi:lock" : "mdi:lock-open-variant",
              lockLabel, locked ? "" : "warn") : ""}
            ${this._has("trunk_open") ? this._btn("trunk",
              "mdi:car-back", trunkOpen ? "Багажник открыт" : "Багажник", trunkOpen ? "warn" : "") : ""}
            ${this._has("blink") ? this._btn("blink", "mdi:car-light-high", "Сигнал и фары", "") : ""}
            ${this._has("heating_on") ? this._btn("heating", "mdi:heat-wave",
              heating ? "Выключить обогрев" : "Обогрев", heating ? "active" : "") : ""}
            ${this._has("cooling_on") ? this._btn("cooling", "mdi:snowflake",
              cooling ? "Выключить охлаждение" : "Охлаждение", cooling ? "active" : "") : ""}
            ${this._has("trip_prepare_on") ? this._btn("trip", "mdi:car-cog",
              this._val("trip_preparation") === "on" ? "Остановить подготовку" : "Подготовить к поездке",
              this._val("trip_preparation") === "on" ? "active" : "") : ""}
          </div>

          ${this._commandRow()}
          ${this._diagnosticRows()}
        </div>
        ${this._config.show_map && this._has("tracker") ? `<div class="map" id="evmap"></div>` : ""}
      </ha-card>`;

    this._bind();
    this._built = true;
    this._mapEl = null;   // old map (if any) was destroyed by the innerHTML rebuild
    this._syncMap();
  }

  _bar(icon, pct, role) {
    return `<div class="bar" data-act="mi" data-role="${role}"><ha-icon icon="${icon}"></ha-icon>
      <div class="track"><div class="fill" style="width:${pct}%"></div></div></div>`;
  }
  _barVal(txt, role) { return `<div class="barval" data-act="mi" data-role="${role}">${txt}</div>`; }

  _signalBadge() {
    if (!this._has("signal_percent")) return "";
    const raw = this._val("signal_percent");
    const value = typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    const valid = Number.isFinite(value) && value >= 0 && value <= 100;
    const label = valid ? `${Math.round(value)}%` : "—%";
    return `<span class="signal" data-act="mi" data-role="signal_percent"
        title="Уровень сигнала: ${valid ? label : "нет данных"}">
      <ha-icon icon="${valid ? "mdi:signal" : "mdi:signal-off"}"></ha-icon><span>${label}</span>
    </span>`;
  }

  _commandRow() {
    const status = this._val("command_status");
    if (UNAVAILABLE.has(status)) {
      return `<div class="command-note">Для управления обновите интеграцию Evolute до версии ${EVOLUTE_CARD_VERSION}.</div>`;
    }
    const result = this._st("command_status")?.attributes || {};
    const waiting = this._requestPending && !COMMAND_BUSY.has(status);
    const note = waiting ? "Ожидаем ответ…" : this._actionError ? null : {
      sending: "Отправляем команду…", error: "Автомобиль не подтвердил выполнение команды.",
      timeout: "Подтверждение не получено вовремя. Проверьте состояние автомобиля.",
      unconfirmed: "Результат неизвестен. Проверьте состояние автомобиля перед повторной командой.",
    }[status];
    if (status === "idle" && !this._requestPending && !this._actionError) return "";
    const stage = waiting || this._actionError ? undefined : { pending: 0, delivered: 1, success: 2 }[status];
    return `<div class="command-status" role="status" aria-live="polite">
      <div class="command-title">${this._escape(!waiting && !this._actionError && COMMAND_NAMES[result.command] || "Команда автомобиля")}</div>
      ${stage !== undefined ? `<ol class="command-steps">${["Отправлена", "Доставлена", "Выполнена"].map((label, i) =>
        `<li class="${i <= stage ? "reached" : ""}" ${i === stage ? 'aria-current="step"' : ""}>${label}</li>`).join("")}</ol>` : ""}
      ${note ? `<div class="command-note">${note}</div>` : ""}
      ${this._requestPending && stage === undefined && !note ? '<div class="command-note">Ожидаем ответ…</div>' : ""}
      ${this._actionError ? `<div class="command-error" role="alert">${this._escape(this._actionError)}</div>` : ""}
    </div>`;
  }

  _diagnosticRows() {
    return [
      ["firmware_mismatch", "Версия прошивки отличается от профиля"],
      ["settings_mismatch", "Настройки машины отличаются от профиля"],
    ].filter(([role]) => this._val(role) === "on").map(([role, title]) => {
      const attributes = this._st(role)?.attributes || {};
      return `<div class="diagnostic" data-act="mi" data-role="${role}">
        <ha-icon icon="mdi:alert-outline"></ha-icon><div>${title}
        <div class="command-note">На машине: ${this._escape(attributes.actual || "—")}<br>
        В профиле: ${this._escape(attributes.expected || "—")}</div></div></div>`;
    }).join("");
  }

  // Cabin: "current° → target°". Current is colored vs the climate target:
  //   red if hotter than target by >2°, blue if colder than target,
  //   normal (white) when within [target; target+2]. Target is always white.
  //   With no active climate target, shows just "current°C".
  _cabinValue() {
    const cur = this._num("inboard_temp", 1);
    if (cur == null) return "—";
    const tRaw = this._val("climate_target");
    const tgt = (this._has("climate_target") && !UNAVAILABLE.has(tRaw)) ? Number(tRaw) : NaN;
    if (!Number.isFinite(tgt)) return `${cur}°C`;
    const curN = Number(cur);
    let color = "var(--primary-text-color)";
    if (curN > tgt + 2) color = "var(--error-color, #f44336)";
    else if (curN < tgt) color = "var(--info-color, #5aa9ff)";
    const tgtTxt = tgt % 1 ? tgt.toFixed(1) : String(Math.round(tgt));
    return `<span style="color:${color}">${cur}°</span>`
      + `<span class="arrow">→</span>`
      + `<span class="tgt">${tgtTxt}°</span>`;
  }

  _lang() {
    return (this._hass.locale && this._hass.locale.language) || "ru";
  }

  // Returns {abs, rel, color} for the telemetry timestamp, or null.
  _dataTimeInfo() {
    const s = this._st("data_time");
    if (!s || UNAVAILABLE.has(s.state)) return null;
    const d = new Date(s.state);
    if (isNaN(d.getTime())) return null;
    const lang = this._lang();
    const abs = d.toLocaleString(lang, {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    let rel = "";
    try {
      const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
      const diff = (d.getTime() - Date.now()) / 1000;
      const units = [["year", 31536000], ["month", 2592000], ["day", 86400],
        ["hour", 3600], ["minute", 60], ["second", 1]];
      for (const [u, sec] of units) {
        if (Math.abs(diff) >= sec || u === "second") {
          rel = " (" + rtf.format(Math.round(diff / sec), u) + ")";
          break;
        }
      }
    } catch (e) { /* Intl unavailable — show absolute only */ }
    // Freshness color by age of the data.
    const ageMin = (Date.now() - d.getTime()) / 60000;
    let color;
    if (ageMin <= 2) color = "var(--success-color, #4caf50)";       // свежие
    else if (ageMin <= 5) color = "#cddc39";                        // жёлто-зелёный
    else if (ageMin <= 10) color = "var(--warning-color, #ff9800)"; // оранжевый
    else color = "var(--error-color, #f44336)";                     // устарели
    return { abs, rel, color };
  }

  _dataTimeRow() {
    const i = this._dataTimeInfo();
    if (!i) return "";
    return `<div class="foot" data-act="mi" data-role="data_time" style="color:${i.color}">
      <ha-icon icon="mdi:timeline-clock"></ha-icon>
      <span>Время данных: ${i.abs}${i.rel}</span>
    </div>`;
  }

  // Update color + relative text in place, without a full re-render.
  _refreshDataTime() {
    const el = this.shadowRoot && this.shadowRoot.querySelector('.foot[data-role="data_time"]');
    if (!el) return;
    const i = this._dataTimeInfo();
    if (!i) return;
    el.style.color = i.color;
    const span = el.querySelector("span");
    if (span) span.textContent = `Время данных: ${i.abs}${i.rel}`;
  }

  _controlTarget(role) {
    const mode = MODE_CONTROLS[role];
    if (mode) return mode[this._val(mode.state) === "on" ? "off" : "on"];
    if (role === "trunk") return this._val("trunk") === "on" ? "trunk_close" : "trunk_open";
    return role;
  }

  _btn(role, icon, label, cls) {
    const targetRole = this._controlTarget(role);
    const state = this._val(targetRole);
    const mode = MODE_CONTROLS[role];
    const disabled = this._commandsDisabled() || !this._eid(targetRole) || state === "unavailable"
      || (mode && !["on", "off"].includes(this._val(mode.state)))
      || (role === "lock" && !["locked", "unlocked"].includes(state))
      || (role === "trunk" && UNAVAILABLE.has(this._val("trunk")));
    return `<button class="ctrl ${cls}" data-act="ctrl" data-role="${role}" ${disabled ? "disabled" : ""}>
      <ha-icon icon="${icon}"></ha-icon><span>${label}</span></button>`;
  }

  _bind() {
    this.shadowRoot.querySelectorAll("[data-act]").forEach((el) => {
      const act = el.getAttribute("data-act");
      const role = el.getAttribute("data-role");
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (act === "mi") { const id = this._eid(role); if (id) this._moreInfo(id); }
        else if (act === "ctrl") this._ctrl(role);
      });
    });
  }

  _ctrl(role) {
    if (this._commandsDisabled()) return;
    if (role === "lock") return this._lockToggle();
    const mode = MODE_CONTROLS[role];
    if (mode && !["on", "off"].includes(this._val(mode.state))) return;
    if (mode || role === "trunk" || role === "blink") {
      return this._press(this._controlTarget(role));
    }
  }

  // Lazily create & feed the <ha-map> element (optional).
  //
  // ha-map ships in a lazy-loaded chunk that HA only fetches when a stock `map`
  // card is present on a dashboard. If it isn't registered yet, we force-load it
  // via the stock map card helper (which pulls ha-map in), then retry — instead
  // of creating an "unknown element" that renders blank.
  _syncMap() {
    if (!this._config.show_map || !this._has("tracker")) { this._mapEl = null; return; }
    const holder = this.shadowRoot.getElementById("evmap");
    if (!holder) return;

    if (!customElements.get("ha-map")) {
      holder.style.display = "none";          // no reserved blank gap while loading
      this._ensureHaMap().then(() => {
        // re-run once the element is registered (holder may have been rebuilt)
        if (this._config.show_map) this._syncMap();
      });
      return;
    }
    holder.style.display = "";

    if (!this._mapEl) {
      try {
        this._mapEl = document.createElement("ha-map");
        this._mapEl.style.height = (this._config.map_height || 250) + "px";
        this._mapEl.style.display = "block";
        this._mapEl.style.borderRadius = "0 0 12px 12px";
        this._mapEl.style.overflow = "hidden";
        holder.appendChild(this._mapEl);
      } catch (e) { return; }
    }
    this._mapEl.hass = this._hass;
    this._mapEl.entities = [this._eid("tracker")];
    this._mapEl.autoFit = true;
    if (this._config.map_zoom) this._mapEl.zoom = this._config.map_zoom;
  }

  // Trigger HA to load the chunk that defines <ha-map>.
  _ensureHaMap() {
    if (this._haMapPromise) return this._haMapPromise;
    this._haMapPromise = (async () => {
      try {
        const helpers = await window.loadCardHelpers?.();
        if (helpers) {
          // Creating a stock map card element pulls in the ha-map chunk.
          const el = await helpers.createCardElement({ type: "map", entities: [] });
          el.hass = this._hass;
          // attach briefly off-screen so its lazy import kicks in
          el.style.position = "absolute";
          el.style.left = "-9999px";
          el.style.width = el.style.height = "1px";
          (this.shadowRoot || document.body).appendChild(el);
          await customElements.whenDefined("ha-map");
          el.remove();
        } else {
          await customElements.whenDefined("ha-map");
        }
      } catch (e) {
        // last resort: just wait for it to appear if some other card loads it
        try { await customElements.whenDefined("ha-map"); } catch (_) {}
      }
    })();
    return this._haMapPromise;
  }

  _escape(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  _styles() {
    return `<style>
      ha-card { overflow: hidden; }
      .wrap { padding: 16px 16px 12px; display: flex; flex-direction: column; gap: 10px; }
      .head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; }
      .odo { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; cursor: pointer; font-size: 24px; font-weight: 600;
             color: var(--primary-text-color); }
      .odo ha-icon { --mdc-icon-size: 24px; color: var(--state-icon-color, var(--primary-color)); }
      .signal { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0;
                font-size: 13px; font-weight: 500; white-space: nowrap; color: var(--secondary-text-color); }
      .odo .signal ha-icon { --mdc-icon-size: 18px; color: inherit; }
      .dot { width: 14px; height: 14px; border-radius: 50%; flex: 0 0 auto; }
      .odo .plug { --mdc-icon-size: 24px; flex-shrink: 0; }
      .model { margin-left: auto; max-width: 100%; overflow-wrap: anywhere; text-align: right; line-height: 1.1; }
      .model .m { font-size: 22px; font-weight: 500; color: var(--primary-text-color); }
      .model .vin { font-size: 13px; color: var(--secondary-text-color); }
      .bars { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; align-items: center; container-type: inline-size; }
      .bar { display: flex; align-items: center; gap: 10px; cursor: pointer; }
      .bar ha-icon { --mdc-icon-size: 20px; color: var(--primary-color); }
      .track { height: 6px; flex: 1; border-radius: 6px; overflow: hidden;
               background: var(--divider-color, #d5d8de); }
      .fill { height: 100%; background: var(--primary-color); }
      .barval { font-size: 20px; font-weight: 500; cursor: pointer; }
      .barval[data-role="battery_pct"] { font-size: clamp(12px, 3.8cqw, 18px); white-space: nowrap; }
      .cells { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 4px; }
      .cell { cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
      .cell--center { align-items: center; text-align: center; }
      .cv { font-size: 18px; font-weight: 500; color: var(--primary-text-color); }
      .cv .arrow { color: var(--secondary-text-color); margin: 0 2px; }
      .cv .tgt { color: var(--primary-text-color); }
      .cl { --mdc-icon-size: 18px; color: var(--secondary-text-color); }
      .ctrls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
      .ctrl { flex: 1 1 auto; min-width: 90px; display: flex; flex-direction: column; align-items: center;
              gap: 4px; padding: 10px 6px; border: none; border-radius: 12px; cursor: pointer;
              background: var(--secondary-background-color, #e6e6e8); color: var(--primary-text-color);
              font-size: 12px; }
      .ctrl ha-icon { --mdc-icon-size: 24px; }
      .ctrl:hover { filter: brightness(0.97); }
      .ctrl:disabled { opacity: .5; cursor: default; }
      .ctrl.warn ha-icon { color: var(--warning-color, #e08b00); }
      .ctrl.active { background: color-mix(in srgb, var(--primary-color) 22%, transparent); }
      .ctrl.active ha-icon { color: var(--primary-color); }
      .foot { margin: -2px 0 2px; display: flex; align-items: center; gap: 6px; cursor: pointer;
              font-size: 12px; color: var(--secondary-text-color); }
      .foot ha-icon { --mdc-icon-size: 16px; }
      .map { margin: 4px 0 0; }
      .command-status { border: 1px solid var(--divider-color, #ddd); border-radius: 10px; padding: 10px; }
      .command-title { font-size: 13px; font-weight: 600; }
      .command-steps { display: flex; gap: 8px; list-style: none; margin: 8px 0 0; padding: 0; font-size: 12px; }
      .command-steps li { flex: 1; border-top: 3px solid var(--divider-color, #ddd); padding-top: 5px; color: var(--secondary-text-color); }
      .command-steps .reached { border-color: var(--primary-color); color: var(--primary-text-color); }
      .command-note { margin-top: 5px; font-size: 12px; color: var(--secondary-text-color); }
      .command-error { margin-top: 6px; font-size: 13px; color: var(--error-color, #db4437); }
      .diagnostic { display: flex; gap: 8px; padding: 8px; border-radius: 8px; background: var(--secondary-background-color, #eee); color: var(--warning-color, #e08b00); cursor: pointer; font-size: 13px; }
      .diagnostic ha-icon { flex-shrink: 0; }
    </style>`;
  }
}

if (!customElements.get("evolute-card")) {
  customElements.define("evolute-card", EvoluteCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "evolute-card",
  name: "Evolute Card",
  description: "Панель и управление автомобилем Evolute (интеграция evassist).",
  preview: false,
  documentationURL: "https://github.com/Tamahome-M/evolute-card",
});

console.info(
  `%c EVOLUTE-CARD %c v${EVOLUTE_CARD_VERSION} `,
  "color:#fff;background:#3f8fc7;font-weight:700;border-radius:3px 0 0 3px;padding:2px 4px",
  "color:#3f8fc7;background:#0000;font-weight:700;padding:2px 4px"
);
