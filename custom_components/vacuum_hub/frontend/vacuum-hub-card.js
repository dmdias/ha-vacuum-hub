/*
 * Vacuum Hub card for Home Assistant.
 * Author: Daniel Dias (@dmdias) - https://github.com/dmdias/ha-vacuum-hub
 *
 * Served and loaded automatically by the Vacuum Hub integration, which also
 * provides the `vacuum_hub.clean_rooms` action used for room cleaning.
 *
 * One card for several robot vacuums (e.g. Xiaomi accounts on different
 * cloud servers): pick the vacuum, see its state, battery and map, start,
 * pause, stop or dock it, change the suction mode, run device actions
 * (mopping) and clean selected rooms.
 *
 *   type: custom:vacuum-hub-card
 *   vacuums:                       # optional, every vacuum by default
 *     - entity: vacuum.robot_1
 *       name: Downstairs           # optional
 *       map: image.robot_1_map     # optional, Xiaomi Cloud Map Extractor image (v3) or camera (v2)
 *       map_zoom: true             # optional, zoom on the drawn area of the map (default)
 *       rooms:                     # optional, when the map has no room names
 *         16: Kitchen
 *         17: Living room
 *     - vacuum.robot_2
 *
 * Related entities (mode select, action buttons, room cleaning action,
 * battery sensor) are found through the device of each vacuum.
 */

const CARD_VERSION = "0.5.1";
const HUB_MODELS = /^(viomi|roborock|rockrobo)\.vacuum\./;

// VacuumEntityFeature bits
const F = { PAUSE: 4, STOP: 8, RETURN_HOME: 16, FAN_SPEED: 32, BATTERY: 64, SEND_COMMAND: 256, LOCATE: 512, START: 8192 };

const TEXT = {
  pt: {
    start: "Iniciar", pause: "Pausar", stop: "Parar", dock: "Base", locate: "Localizar",
    mode: "Modo", actions: "Ações", rooms: "Quartos", map: "Mapa", battery: "Bateria",
    clean_rooms: "Limpar quartos", clear: "Limpar seleção", select_rooms: "Toca nos quartos a limpar",
    no_map: "Sem mapa configurado para este aspirador.", no_rooms: "Este aspirador não permite limpar quartos.",
    rooms_need_map: "Para escolher quartos é preciso o mapa (ou a lista de quartos na configuração).",
    no_vacuums: "Nenhum aspirador encontrado.", unavailable: "Indisponível", sent: "Comando enviado",
    states: { docked: "Na base", cleaning: "A limpar", returning: "A voltar à base", paused: "Em pausa", idle: "Parado", error: "Erro", unavailable: "Indisponível", unknown: "Desconhecido" },
  },
  en: {
    start: "Start", pause: "Pause", stop: "Stop", dock: "Dock", locate: "Locate",
    mode: "Mode", actions: "Actions", rooms: "Rooms", map: "Map", battery: "Battery",
    clean_rooms: "Clean rooms", clear: "Clear selection", select_rooms: "Tap the rooms to clean",
    no_map: "No map configured for this vacuum.", no_rooms: "This vacuum cannot clean selected rooms.",
    rooms_need_map: "Choosing rooms needs the map (or a room list in the card configuration).",
    no_vacuums: "No vacuum found.", unavailable: "Unavailable", sent: "Command sent",
    states: { docked: "Docked", cleaning: "Cleaning", returning: "Returning", paused: "Paused", idle: "Idle", error: "Error", unavailable: "Unavailable", unknown: "Unknown" },
  },
};

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ICONS = {
  start: "M8 5v14l11-7z",
  pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
  stop: "M6 6h12v12H6z",
  dock: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z",
  locate: "M12 8a4 4 0 100 8 4 4 0 000-8zm8.94 3A8.994 8.994 0 0013 3.06V1h-2v2.06A8.994 8.994 0 003.06 11H1v2h2.06A8.994 8.994 0 0011 20.94V23h2v-2.06A8.994 8.994 0 0020.94 13H23v-2h-2.06zM12 19a7 7 0 110-14 7 7 0 010 14z",
  mop: "M12 2c-1.1 0-2 .9-2 2v7H7l-2 9h14l-2-9h-3V4c0-1.1-.9-2-2-2zm-3.6 16l1-5h5.2l1 5H8.4z",
  sweep: "M19.36 2.72l1.42 1.42-5.72 5.71c1.07 1.54 1.22 3.39.32 4.59L9.06 8.12c1.2-.9 3.05-.75 4.59.32l5.71-5.72M5.93 17.57c-2.01-2.01-3.24-4.41-3.58-6.65l4.88-2.09 7.44 7.44-2.09 4.88c-2.24-.34-4.64-1.57-6.65-3.58z",
};
const icon = (name) => `<svg viewBox="0 0 24 24" class="i"><path d="${ICONS[name] || ICONS.start}"/></svg>`;

class VacuumHubCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._index = 0;
    this._selected = new Set();
    this._signature = "";
    this._mapSize = {};
    this._mapContent = {}; // content box of each map image, from a pixel scan
    this._scanned = {};
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    this._config = config || {};
    this._devices = undefined;
    this._render();
  }

  getCardSize() {
    return 9;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._discover();
    const sig = this._sig();
    if (sig !== this._signature) {
      this._signature = sig;
      this._render();
    }
  }

  get _t() {
    const lang = (this._hass?.locale?.language || this._hass?.language || "en").slice(0, 2);
    return TEXT[lang] || TEXT.en;
  }

  /* ----- discovery ----- */

  async _discover() {
    let registry = [];
    try {
      registry = await this._hass.callWS({ type: "config/entity_registry/list" });
    } catch (err) {
      registry = [];
    }
    const byDevice = {};
    for (const e of registry) if (e.device_id && !e.disabled_by) (byDevice[e.device_id] ??= []).push(e);

    const configured = this._config.vacuums?.length
      ? this._config.vacuums.map((v) => (typeof v === "string" ? { entity: v } : v))
      : Object.keys(this._hass.states).filter((id) => id.startsWith("vacuum.")).sort().map((entity) => ({ entity }));

    this._devices = configured.map((cfg) => {
      const reg = registry.find((e) => e.entity_id === cfg.entity);
      const siblings = (reg && byDevice[reg.device_id]) || [];
      const model = (reg && this._hass.devices?.[reg.device_id]?.model) || "";
      const pick = (domain, test = () => true) => siblings.filter((e) => e.entity_id.startsWith(`${domain}.`) && test(e)).map((e) => e.entity_id);
      return {
        ...cfg,
        model,
        mode: cfg.mode_entity || pick("select", (e) => /mode|suction|fan/i.test(e.entity_id))[0] || null,
        buttons: cfg.buttons || pick("button"),
        roomAction: cfg.room_action || pick("notify", (e) => /room/i.test(e.entity_id))[0] || null,
        battery: cfg.battery_entity || pick("sensor", (e) => /battery/i.test(e.entity_id))[0] || null,
      };
    });
    this._signature = "";
    this._render();
  }

  _sig() {
    if (!this._devices || !this._hass) return String(this._devices);
    return this._devices
      .flatMap((d) => [d.entity, d.mode, d.battery, d.map, d.roomAction, ...d.buttons])
      .filter(Boolean)
      .map((id) => {
        const s = this._hass.states[id];
        return s ? `${s.state}:${s.attributes.entity_picture || ""}` : "";
      })
      .join("|");
  }

  /* ----- helpers ----- */

  _state(id) {
    return id ? this._hass.states[id] : undefined;
  }

  _name(dev) {
    return dev.name || this._state(dev.entity)?.attributes.friendly_name || dev.entity;
  }

  _battery(dev) {
    const attr = this._state(dev.entity)?.attributes.battery_level;
    if (attr !== undefined && attr !== null) return Number(attr);
    const s = this._state(dev.battery)?.state;
    return s !== undefined && !isNaN(Number(s)) ? Number(s) : null;
  }

  _stateText(state) {
    return this._t.states[state] || state || this._t.states.unknown;
  }

  _rooms(dev) {
    const out = {};
    const map = this._state(dev.map);
    const mapRooms = map?.attributes?.rooms;
    if (mapRooms && typeof mapRooms === "object") {
      for (const [id, r] of Object.entries(mapRooms)) out[id] = { id, name: r?.name || `${this._t.rooms.slice(0, -1)} ${id}`, box: r };
    }
    for (const [id, name] of Object.entries(dev.rooms || {})) out[id] = { ...(out[id] || { id }), id, name };
    return Object.values(out);
  }

  /** Whether the Vacuum Hub integration can clean rooms on this vacuum. */
  _hubRooms(dev) {
    return Boolean(this._hass.services?.vacuum_hub?.clean_rooms && HUB_MODELS.test(dev.model || ""));
  }

  _call(domain, service, data) {
    this._hass.callService(domain, service, data).catch((err) => this._toast(err.message || String(err)));
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }

  /* ----- rendering ----- */

  _render() {
    if (!this._config) return;
    let body;
    if (!this._hass || this._devices === undefined) body = `<div class="empty">…</div>`;
    else if (!this._devices.length) body = `<div class="empty">${esc(this._t.no_vacuums)}</div>`;
    else body = this._body();
    this.shadowRoot.innerHTML = `<style>${STYLES}</style><ha-card>${body}</ha-card>`;
    this._bind();
  }

  _body() {
    const t = this._t;
    this._index = Math.min(this._index, this._devices.length - 1);
    const dev = this._devices[this._index];
    const st = this._state(dev.entity);
    const state = st?.state || "unavailable";
    const features = Number(st?.attributes.supported_features || 0);
    const battery = this._battery(dev);

    const tabs = this._devices
      .map((d, i) => {
        const s = this._state(d.entity)?.state || "unavailable";
        const b = this._battery(d);
        return `<button class="tab ${i === this._index ? "on" : ""}" data-index="${i}">
          <span class="dot ${esc(s)}"></span><span class="tab-name">${esc(this._name(d))}</span>
          ${b === null ? "" : `<span class="tab-bat">${b}%</span>`}</button>`;
      })
      .join("");

    const btn = (action, label, feature, cls = "") =>
      features & feature || (action === "start" && features === 0)
        ? `<button class="ctl ${cls}" data-action="${action}" ${state === "unavailable" ? "disabled" : ""}>${icon(action)}<span>${esc(label)}</span></button>`
        : "";
    const cleaning = state === "cleaning";

    // Suction mode: the vacuum fan speeds, else the device mode select
    let mode = "";
    if (features & F.FAN_SPEED && st?.attributes.fan_speed_list?.length) {
      mode = this._select("fan", st.attributes.fan_speed_list, st.attributes.fan_speed);
    } else if (dev.mode && this._state(dev.mode)) {
      const ms = this._state(dev.mode);
      mode = this._select("mode", ms.attributes.options || [], ms.state);
    }

    const actions = dev.buttons
      .filter((id) => this._state(id))
      .map((id) => {
        const label = this._buttonLabel(dev, id);
        return `<button class="chip" data-button="${esc(id)}">${icon(/mop/i.test(id) ? "mop" : "sweep")}${esc(label)}</button>`;
      })
      .join("");

    return `
      <div class="tabs">${tabs}</div>
      <div class="hero">
        <div class="robot ${esc(state)}">${ROBOT_ART}</div>
        <div class="info">
          <div class="name">${esc(this._name(dev))}</div>
          <div class="status ${esc(state)}">${esc(this._stateText(state))}</div>
          ${
            battery === null
              ? ""
              : `<div class="battery"><div class="bar"><i style="width:${Math.max(0, Math.min(100, battery))}%" class="${battery < 20 ? "low" : ""}"></i></div><span>${battery}%</span></div>`
          }
          ${mode ? `<label class="mode"><span>${esc(t.mode)}</span>${mode}</label>` : ""}
        </div>
      </div>
      <div class="controls">
        ${cleaning ? btn("pause", t.pause, F.PAUSE, "primary") : btn("start", t.start, F.START, "primary")}
        ${btn("stop", t.stop, F.STOP)}
        ${btn("dock", t.dock, F.RETURN_HOME)}
        ${btn("locate", t.locate, F.LOCATE)}
      </div>
      ${actions ? `<div class="section"><div class="section-title">${esc(t.actions)}</div><div class="chips">${actions}</div></div>` : ""}
      ${this._mapSection(dev)}`;
  }

  _select(kind, options, value) {
    return `<select data-${kind}>${options
      .map((o) => `<option value="${esc(o)}" ${o === value ? "selected" : ""}>${esc(o)}</option>`)
      .join("")}</select>`;
  }

  _buttonLabel(dev, id) {
    const fn = this._state(id)?.attributes.friendly_name || id;
    const base = this._state(dev.entity)?.attributes.friendly_name || "";
    // Xiaomi Home names are "<device>  <action>": "Mi Robot Vacuum-Mop P  Start Sweep Mop"
    let label = fn.includes("  ") ? fn.split("  ").pop() : fn;
    if (base && label.startsWith(base)) label = label.slice(base.length);
    label = label.replace(/^\W+/, "").trim();
    const known = { "start sweep mop": { pt: "Aspirar e esfregar", en: "Sweep and mop" }, "start mop": { pt: "Só esfregar", en: "Mop only" } };
    const key = label.toLowerCase();
    const lang = this._t === TEXT.pt ? "pt" : "en";
    for (const [k, v] of Object.entries(known)) if (key.endsWith(k)) return v[lang];
    return label || fn;
  }

  _mapSection(dev) {
    const t = this._t;
    const map = this._state(dev.map);
    const rooms = this._rooms(dev);
    const canRooms = Boolean(dev.room_service || this._hubRooms(dev) || dev.roomAction);

    let mapHtml = "";
    if (map?.attributes?.entity_picture) {
      // The picture URL stays the same when the map changes: add the update
      // time so the browser fetches the new image instead of its cached copy
      const pic = map.attributes.entity_picture;
      const src = pic.startsWith("data:") ? pic : `${pic}${pic.includes("?") ? "&" : "?"}t=${encodeURIComponent(map.last_updated || map.state || "")}`;
      const inner = `<img src="${esc(src)}" alt="${esc(t.map)}" data-map="${esc(dev.map)}">${canRooms ? this._roomOverlay(map, rooms, dev.map) : ""}`;
      const crop = this._mapCrop(dev, map, rooms);
      const size = this._imageSize(map, dev.map);
      mapHtml =
        crop && size
          ? `<div class="map zoomed" style="aspect-ratio:${crop.w} / ${crop.h}"><div class="map-inner" style="width:${(size[0] / crop.w) * 100}%;left:${(-crop.x / crop.w) * 100}%;top:${(-crop.y / crop.h) * 100}%">${inner}</div></div>`
          : `<div class="map"><div class="map-inner">${inner}</div></div>`;
    } else if (dev.map) {
      mapHtml = `<div class="hint">${esc(t.no_map)}</div>`;
    }

    let roomsHtml = "";
    if (canRooms && rooms.length) {
      const chips = rooms
        .map((r) => `<button class="chip room ${this._selected.has(String(r.id)) ? "on" : ""}" data-room="${esc(r.id)}">${esc(r.name)}</button>`)
        .join("");
      roomsHtml = `
        <div class="hint">${esc(t.select_rooms)}</div>
        <div class="chips">${chips}</div>
        <div class="room-actions">
          <button class="ctl primary" data-action="clean-rooms" ${this._selected.size ? "" : "disabled"}>${icon("start")}<span>${esc(t.clean_rooms)}${this._selected.size ? ` (${this._selected.size})` : ""}</span></button>
          ${this._selected.size ? `<button class="ctl" data-action="clear-rooms">${esc(t.clear)}</button>` : ""}
        </div>`;
    } else if (canRooms) {
      roomsHtml = `<div class="hint">${esc(t.rooms_need_map)}</div>`;
    } else if (rooms.length) {
      roomsHtml = `<div class="hint">${esc(t.no_rooms)}</div>`;
    }

    if (!mapHtml && !roomsHtml) return "";
    return `<div class="section"><div class="section-title">${esc(map ? t.map : t.rooms)}</div>${mapHtml}${roomsHtml}</div>`;
  }

  /** Size of a map image: reported by Map Extractor v2, read from the loaded image for v3. */
  _imageSize(map, mapId) {
    const w = map.attributes.image_width || map.attributes.width || this._mapSize[mapId]?.[0];
    const h = map.attributes.image_height || map.attributes.height || this._mapSize[mapId]?.[1];
    return w && h ? [w, h] : null;
  }

  /**
   * Part of the map image to show: the drawn area (walls and floor) found by
   * scanning the image, else the room outlines, plus a margin. Null shows the
   * whole image (map_zoom: false, or nothing known yet).
   */
  _mapCrop(dev, map, rooms) {
    if (dev.map_zoom === false) return null;
    const size = this._imageSize(map, dev.map);
    if (!size) return null;
    // Union of the drawn area and the room outlines, so no clickable room is cut
    const parts = [this._mapContent[dev.map], ...(this._roomPixels(map, rooms, dev.map) || [])].filter(Boolean);
    let box = null;
    if (parts.length) {
      const x0 = Math.min(...parts.map((r) => r.x));
      const y0 = Math.min(...parts.map((r) => r.y));
      const x1 = Math.max(...parts.map((r) => r.x + r.w));
      const y1 = Math.max(...parts.map((r) => r.y + r.h));
      box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    if (!box || box.w <= 0 || box.h <= 0) return null;
    const pad = Math.max(8, Math.max(box.w, box.h) * (typeof dev.map_padding === "number" ? dev.map_padding : 0.05));
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    const crop = { x, y, w: Math.min(size[0], box.x + box.w + pad) - x, h: Math.min(size[1], box.y + box.h + pad) - y };
    // Not worth zooming when the drawn area already fills the image
    return crop.w * crop.h > size[0] * size[1] * 0.85 ? null : crop;
  }

  /** Room boxes in map image pixels, from the Map Extractor calibration points. */
  _roomPixels(map, rooms, mapId) {
    const cal = map.attributes.calibration_points;
    if (!Array.isArray(cal) || cal.length < 3) return null;
    const boxes = rooms.filter((r) => r.box && ["x0", "y0", "x1", "y1"].every((k) => typeof r.box[k] === "number"));
    if (!boxes.length) return null;
    // Affine transform vacuum -> map pixels from three calibration points
    const [a, b, c] = cal;
    const solve = (axis) => {
      const [x1, y1, v1] = [a.vacuum.x, a.vacuum.y, a.map[axis]];
      const [x2, y2, v2] = [b.vacuum.x, b.vacuum.y, b.map[axis]];
      const [x3, y3, v3] = [c.vacuum.x, c.vacuum.y, c.map[axis]];
      const det = x1 * (y2 - y3) - y1 * (x2 - x3) + (x2 * y3 - x3 * y2);
      if (!det) return null;
      const p = (v1 * (y2 - y3) - y1 * (v2 - v3) + (v2 * y3 - v3 * y2)) / det;
      const q = (x1 * (v2 - v3) - v1 * (x2 - x3) + (x2 * v3 - x3 * v2)) / det;
      const r = (x1 * (y2 * v3 - y3 * v2) - y1 * (x2 * v3 - x3 * v2) + v1 * (x2 * y3 - x3 * y2)) / det;
      return (x, y) => p * x + q * y + r;
    };
    const fx = solve("x");
    const fy = solve("y");
    if (!fx || !fy) return null;
    return boxes.map((r) => {
      const xs = [fx(r.box.x0, r.box.y0), fx(r.box.x1, r.box.y1)];
      const ys = [fy(r.box.x0, r.box.y0), fy(r.box.x1, r.box.y1)];
      return { room: r, x: Math.min(...xs), y: Math.min(...ys), w: Math.abs(xs[1] - xs[0]), h: Math.abs(ys[1] - ys[0]) };
    });
  }

  /** Clickable room boxes over the map. */
  _roomOverlay(map, rooms, mapId) {
    const size = this._imageSize(map, mapId);
    const rects = this._roomPixels(map, rooms, mapId);
    if (!size || !rects) return "";
    const marks = rects
      .map(
        ({ room, x, y, w, h }) => `<g class="room-box ${this._selected.has(String(room.id)) ? "on" : ""}" data-room="${esc(room.id)}">
          <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/>
          <text x="${x + w / 2}" y="${y + h / 2}">${esc(room.name)}</text></g>`
      )
      .join("");
    return `<svg class="overlay" viewBox="0 0 ${size[0]} ${size[1]}" preserveAspectRatio="none">${marks}</svg>`;
  }

  /**
   * Bounding box of what is drawn on a map image: pixels that differ from the
   * background colour found in the corners. Scanned on a small copy for speed.
   */
  _scanContent(img) {
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const scale = Math.min(1, 320 / Math.max(W, H));
    const w = Math.max(1, Math.round(W * scale));
    const h = Math.max(1, Math.round(H * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data; // throws if the image is cross-origin
    const at = (x, y) => px.subarray((y * w + x) * 4, (y * w + x) * 4 + 4);
    const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
    const bg = corners.sort((a, b) => a[3] - b[3])[0]; // the most transparent corner, else any
    const differs = (p) => Math.abs(p[3] - bg[3]) > 40 || (p[3] > 40 && Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 48);
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (differs(at(x, y))) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    return { x: x0 / scale, y: y0 / scale, w: (x1 - x0 + 1) / scale, h: (y1 - y0 + 1) / scale };
  }

  /* ----- events ----- */

  _bind() {
    const root = this.shadowRoot;
    root.querySelectorAll("[data-index]").forEach((b) =>
      b.addEventListener("click", () => {
        this._index = Number(b.dataset.index);
        this._selected.clear();
        this._render();
      })
    );
    const dev = this._devices?.[this._index];
    if (!dev) return;
    root.querySelectorAll("[data-action]").forEach((b) => b.addEventListener("click", () => this._action(dev, b.dataset.action)));
    root.querySelectorAll("[data-button]").forEach((b) =>
      b.addEventListener("click", () => this._call("button", "press", { entity_id: b.dataset.button }))
    );
    root.querySelectorAll("[data-room]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = String(b.dataset.room);
        this._selected.has(id) ? this._selected.delete(id) : this._selected.add(id);
        this._render();
      })
    );
    root.querySelectorAll("img[data-map]").forEach((img) => {
      const read = () => {
        const id = img.dataset.map;
        const size = [img.naturalWidth, img.naturalHeight];
        if (!size[0]) return;
        let changed = false;
        const known = this._mapSize[id];
        if (!known || known[0] !== size[0] || known[1] !== size[1]) {
          this._mapSize[id] = size;
          changed = true;
        }
        if (this._scanned[id] !== img.src) {
          this._scanned[id] = img.src;
          try {
            const box = this._scanContent(img);
            const old = this._mapContent[id];
            const moved = (a, b) => Math.abs(a - b) > Math.max(size[0], size[1]) * 0.01;
            if (box && (!old || moved(box.x, old.x) || moved(box.y, old.y) || moved(box.w, old.w) || moved(box.h, old.h))) {
              this._mapContent[id] = box;
              changed = true;
            }
          } catch (err) {
            // Cross-origin image: fall back to the room outlines
          }
        }
        if (changed) this._render();
      };
      img.complete ? read() : img.addEventListener("load", read, { once: true });
    });
    const fan = root.querySelector("[data-fan]");
    if (fan) fan.addEventListener("change", () => this._call("vacuum", "set_fan_speed", { entity_id: dev.entity, fan_speed: fan.value }));
    const mode = root.querySelector("[data-mode]");
    if (mode) mode.addEventListener("change", () => this._call("select", "select_option", { entity_id: dev.mode, option: mode.value }));
  }

  _action(dev, action) {
    const entity_id = dev.entity;
    switch (action) {
      case "start":
        return this._call("vacuum", "start", { entity_id });
      case "pause":
        return this._call("vacuum", "pause", { entity_id });
      case "stop":
        return this._call("vacuum", "stop", { entity_id });
      case "dock":
        return this._call("vacuum", "return_to_base", { entity_id });
      case "locate":
        return this._call("vacuum", "locate", { entity_id });
      case "clear-rooms":
        this._selected.clear();
        return this._render();
      case "clean-rooms": {
        const ids = [...this._selected];
        if (!ids.length) return;
        if (dev.room_service) {
          // e.g. { service: vacuum.send_command, data: { command: app_segment_clean } }
          // or a script / shell_command receiving `rooms` ("16,17") and `params` ([16, 17])
          const [domain, service] = dev.room_service.service.split(".");
          const data = { ...(domain === "vacuum" ? { entity_id } : {}), ...(dev.room_service.data || {}) };
          data.params = ids.map(Number);
          if (domain !== "vacuum") data.rooms = ids.join(",");
          this._call(domain, service, data);
        } else if (this._hubRooms(dev)) {
          // Vacuum Hub integration: local miio room cleaning
          this._call("vacuum_hub", "clean_rooms", { entity_id, rooms: ids.map(Number) });
        } else {
          // Xiaomi Home MIoT "start room sweep" action: room ids as text
          this._call("notify", "send_message", { entity_id: dev.roomAction, message: ids.join(",") });
        }
        this._selected.clear();
        this._toast(this._t.sent);
        return this._render();
      }
    }
  }
}

const ROBOT_ART = `
  <svg viewBox="0 0 120 120">
    <defs>
      <radialGradient id="rb" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#c9ced8"/></radialGradient>
    </defs>
    <circle cx="60" cy="62" r="50" fill="#0d1018" opacity="0.35"/>
    <circle cx="60" cy="58" r="50" fill="url(#rb)"/>
    <circle cx="60" cy="58" r="50" fill="none" stroke="#aab1bf" stroke-width="2"/>
    <circle cx="60" cy="40" r="13" fill="#e4e7ee" stroke="#b5bcc9" stroke-width="2"/>
    <circle cx="60" cy="40" r="5" class="led"/>
    <rect x="38" y="70" width="44" height="6" rx="3" fill="#b5bcc9"/>
  </svg>`;

const STYLES = `
  :host { --bg:#0d111a; --panel:#1b2130; --panel2:#2a3142; --line:#3a4256; --text:#e8ebf2; --muted:#9aa3b5; --accent:#5fd3a8; display:block; }
  ha-card { display:block; background:var(--bg); color:var(--text); border-radius:16px; padding:14px; border:none; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .empty { padding:30px; text-align:center; color:var(--muted); }
  .tabs { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; }
  .tab { flex:1; min-width:140px; display:flex; align-items:center; gap:8px; background:var(--panel2); border:1px solid transparent; color:var(--muted);
    border-radius:12px; padding:10px 14px; font-size:15px; cursor:pointer; font-family:inherit; }
  .tab.on { color:var(--text); background:#3a4359; border-color:#6fd8c0; }
  .tab-name { flex:1; text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tab-bat { font-size:13px; color:var(--muted); }
  .dot { width:9px; height:9px; border-radius:50%; background:#7b8494; flex:none; }
  .dot.cleaning { background:var(--accent); box-shadow:0 0 6px var(--accent); } .dot.returning { background:#58b8ff; }
  .dot.error { background:#f05a5a; } .dot.paused { background:#e9a33d; } .dot.unavailable { background:#4a5060; }
  .hero { display:flex; gap:18px; align-items:center; background:var(--panel); border-radius:16px; padding:18px; margin-top:12px; }
  .robot { width:110px; flex:none; } .robot svg { width:100%; display:block; }
  .robot .led { fill:#7b8494; } .robot.cleaning .led { fill:var(--accent); animation:pulse 1.4s ease-in-out infinite; }
  .robot.cleaning svg { animation:spin 6s linear infinite; } .robot.returning .led { fill:#58b8ff; } .robot.error .led { fill:#f05a5a; }
  @keyframes spin { to { transform:rotate(360deg); } } @keyframes pulse { 50% { opacity:.3; } }
  .info { flex:1; display:flex; flex-direction:column; gap:8px; min-width:0; }
  .name { font-size:20px; font-weight:600; }
  .status { color:var(--muted); font-size:15px; } .status.cleaning { color:var(--accent); } .status.error { color:#f05a5a; } .status.returning { color:#58b8ff; }
  .battery { display:flex; align-items:center; gap:10px; font-size:14px; color:var(--muted); }
  .bar { flex:1; max-width:220px; height:8px; background:#3a4254; border-radius:4px; overflow:hidden; }
  .bar i { display:block; height:100%; background:linear-gradient(90deg,#5fd3a8,#7ef0c6); } .bar i.low { background:#f05a5a; }
  .mode { display:flex; align-items:center; gap:10px; font-size:14px; color:var(--muted); }
  select { background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:10px; padding:7px 10px; font-size:14px; font-family:inherit; }
  .controls { display:grid; grid-template-columns:repeat(auto-fit,minmax(90px,1fr)); gap:8px; margin-top:12px; }
  .ctl { display:flex; flex-direction:column; align-items:center; gap:4px; background:var(--panel2); color:var(--text); border:none; border-radius:12px;
    padding:12px 8px; font-size:13px; cursor:pointer; font-family:inherit; }
  .ctl:hover { background:#3a4359; } .ctl[disabled] { opacity:.4; cursor:default; }
  .ctl.primary { background:linear-gradient(135deg,#46c79a,#3a9fd8); color:#08110d; font-weight:600; }
  .room-actions .ctl { flex-direction:row; justify-content:center; padding:10px 16px; }
  .i { width:22px; height:22px; fill:currentColor; }
  .chip .i { width:16px; height:16px; }
  .section { background:var(--panel); border-radius:16px; padding:14px 16px; margin-top:12px; display:flex; flex-direction:column; gap:10px; }
  .section-title { font-size:15px; font-weight:600; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; }
  .chip { display:flex; align-items:center; gap:6px; background:var(--panel2); color:var(--text); border:1px solid transparent; border-radius:20px;
    padding:8px 14px; font-size:14px; cursor:pointer; font-family:inherit; }
  .chip:hover { background:#3a4359; } .chip.on { border-color:var(--accent); color:var(--accent); background:rgba(95,211,168,.12); }
  .hint { color:var(--muted); font-size:13px; }
  .room-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .map { position:relative; border-radius:12px; overflow:hidden; background:#10141d; }
  .map-inner { position:relative; }
  .map.zoomed .map-inner { position:absolute; }
  .map img { width:100%; display:block; }
  .overlay { position:absolute; inset:0; width:100%; height:100%; }
  .room-box rect { fill:rgba(95,211,168,0.06); stroke:rgba(95,211,168,0.35); stroke-width:1.5; cursor:pointer; }
  .room-box.on rect { fill:rgba(95,211,168,0.3); stroke:var(--accent); stroke-width:2.5; }
  .room-box text { fill:#fff; font-size:12px; text-anchor:middle; dominant-baseline:middle; pointer-events:none; paint-order:stroke; stroke:#000; stroke-width:3px; }
`;

// The card can be loaded twice (dashboard resource and an older page): define it once
if (!customElements.get("vacuum-hub-card")) {
  customElements.define("vacuum-hub-card", VacuumHubCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "vacuum-hub-card", name: "Vacuum Hub", description: "Several robot vacuums in one card: state, controls, mopping, map and rooms", preview: false });
}
console.info(`%c VACUUM-HUB-CARD %c ${CARD_VERSION} `, "background:#5fd3a8;color:#000", "background:#1b2130;color:#fff");
