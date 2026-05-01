/* editor.js — canvas-based 20×20 map editor.
 *
 * State is held in a single `level` object whose JSON serialization
 * is exactly what the server's level_from_json() reads. So saving is
 * literally `POST /api/maps/<slug>` with JSON.stringify(level).
 */
'use strict';

// ---- constants ----------------------------------------------------------

const MAP_DIM = 20;
const TILE_PX = 32;            // canvas px per tile (20*32 = 640)
const CANVAS_PX = MAP_DIM * TILE_PX;

// Match server-side validator
const MIN_PLAYER_SPAWNS = 2;
const MAX_PLAYER_SPAWNS = 4;

// Default light direction: pointing down-and-slightly-forward (matches
// what the existing production maps use; verified from ISLAND.UTE)
const DEFAULT_LIGHT_DIRECTION = [0, 0, -65536];     // 0,0,-1 in fxp 16.16
const DEFAULT_LIGHT_COLOR = 0xFFFF;                  // bright white, alpha bit on
const DEFAULT_NORMAL = [0, 0, 0x10000];              // up-vector
const DEFAULT_GOURAUD_COLOR = 0xFFFF;                // bright corners

// Tile texture quick-palette colors (for canvas only — actual textures
// are in TERRAIN.PAK on the Saturn side)
const TILE_COLORS = {
  0: '#3a7d3a',  // grass
  1: '#86736a',  // path
  2: '#3b5a8c',  // water
  3: '#5a5a5a',  // stone
  4: '#888888',  // concrete
  5: '#c4a25c',  // sand
  6: '#444444',  // asphalt
};
const DEFAULT_TILE_COLOR = '#666666';


// ---- tiny helpers -------------------------------------------------------

const $   = (sel, ctx=document) => ctx.querySelector(sel);
const $$  = (sel, ctx=document) => Array.from(ctx.querySelectorAll(sel));

function toast(msg, isError=false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

function degToFxpRad(deg) {
  // Saturn engine reads entity.Direction as Fxp 16.16 radians.
  const rad = (deg * Math.PI) / 180;
  return Math.round(rad * 65536);
}
function fxpRadToDeg(fxp) {
  const rad = fxp / 65536;
  let deg = Math.round((rad * 180) / Math.PI);
  while (deg < 0)   deg += 360;
  while (deg >= 360) deg -= 360;
  return deg;
}


// ---- level state --------------------------------------------------------

function createEmptyLevel() {
  const tiles   = [];
  const gourad  = [];
  const normals = [];
  for (let i = 0; i < MAP_DIM * MAP_DIM; i++) {
    tiles.push({ raw: 0, texture: 0, dummy: 0 });
    gourad.push([DEFAULT_GOURAUD_COLOR, DEFAULT_GOURAUD_COLOR,
                 DEFAULT_GOURAUD_COLOR, DEFAULT_GOURAUD_COLOR]);
    normals.push([...DEFAULT_NORMAL]);
  }
  return {
    schema_version: 1,
    meta: { name: '', author: '', description: '' },
    light: {
      direction: [...DEFAULT_LIGHT_DIRECTION],
      color: DEFAULT_LIGHT_COLOR,
      reserved: 0,
    },
    tiles, gourad, normals,
    entities: [],
  };
}

let level = createEmptyLevel();
let selectedEntityIdx = -1;
let activeTextureSwatch = 0;


// ---- tile bit-packing (mirrors PawCraft TileData) -----------------------

function packTileRaw(depth, mirror, rotation) {
  return ((depth & 0x0F)) | (mirror ? 0x10 : 0) | ((rotation & 3) << 6);
}
function unpackTileDepth(raw)    { return raw & 0x0F; }
function unpackTileMirror(raw)   { return (raw & 0x10) !== 0; }
function unpackTileRotation(raw) { return (raw >> 6) & 3; }


// ---- canvas drawing -----------------------------------------------------

const canvas = $('#map-canvas');
const ctx    = canvas.getContext('2d');

function drawAll() {
  ctx.fillStyle = '#0a0a14';
  ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);

  // Tile cells
  for (let y = 0; y < MAP_DIM; y++) {
    for (let x = 0; x < MAP_DIM; x++) {
      const idx = x + y * MAP_DIM;
      const t = level.tiles[idx];
      const color = TILE_COLORS[t.texture] || DEFAULT_TILE_COLOR;
      ctx.fillStyle = color;
      ctx.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);

      // Depth shading — darker for higher depth (Z up)
      const depth = unpackTileDepth(t.raw);
      if (depth > 0) {
        ctx.fillStyle = `rgba(0,0,0,${Math.min(depth/15 * 0.5, 0.5)})`;
        ctx.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
      }

      // Texture index small label
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '9px monospace';
      ctx.fillText(String(t.texture), x*TILE_PX + 2, y*TILE_PX + 10);

      // Rotation indicator (small triangle)
      const rot = unpackTileRotation(t.raw);
      if (rot !== 0) {
        ctx.save();
        ctx.translate(x*TILE_PX + TILE_PX/2, y*TILE_PX + TILE_PX/2);
        ctx.rotate(rot * Math.PI / 2);
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.beginPath();
        ctx.moveTo(0, -6);
        ctx.lineTo(-4, 4);
        ctx.lineTo(4, 4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // Grid lines
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= MAP_DIM; i++) {
    ctx.beginPath();
    ctx.moveTo(i * TILE_PX, 0); ctx.lineTo(i * TILE_PX, CANVAS_PX); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * TILE_PX); ctx.lineTo(CANVAS_PX, i * TILE_PX); ctx.stroke();
  }

  // Entities
  level.entities.forEach((e, i) => drawEntity(e, i));
}

function drawEntity(e, idx) {
  const cx = e.x * TILE_PX + TILE_PX/2;
  const cy = e.y * TILE_PX + TILE_PX/2;
  const r = TILE_PX * 0.35;
  const isSel = idx === selectedEntityIdx;

  ctx.save();
  if (isSel) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (e.type === 'player_spawn' || e.type_id === 1) {
    // Green circle with directional notch
    ctx.fillStyle = '#2ecc71';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    // direction tick
    ctx.strokeStyle = '#0a3a14';
    ctx.lineWidth = 3;
    const ang = (e.direction || 0) / 65536;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
    ctx.stroke();
    // P# label
    ctx.fillStyle = '#0a3a14';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`P${spawnIndexFor(idx) + 1}`, cx, cy);
  } else if (e.type === 'model' || e.type_id === 2) {
    // Orange square
    ctx.fillStyle = '#f5a623';
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = '#3a2a0a';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('M', cx, cy);
  } else if (e.type === 'crate' || e.type_id === 3) {
    // Red diamond
    ctx.fillStyle = '#e94560';
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    ctx.fill();
    // flag letters
    const flags = e.reserved[0] || 0;
    let label = '';
    if (flags & 0x01) label += 'H';
    if (flags & 0x02) label += 'B';
    if (flags & 0x04) label += 'M';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label || '?', cx, cy);
  }
  ctx.restore();
}

function spawnIndexFor(entIdx) {
  // count player_spawn entities up to (not including) entIdx
  let n = 0;
  for (let i = 0; i < entIdx; i++) {
    if (level.entities[i].type === 'player_spawn' || level.entities[i].type_id === 1) n++;
  }
  return n;
}


// ---- canvas interaction -------------------------------------------------

function tileFromEvent(ev) {
  const rect = canvas.getBoundingClientRect();
  // Account for any zoom; canvas internal vs CSS size
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const cx = (ev.clientX - rect.left) * sx;
  const cy = (ev.clientY - rect.top) * sy;
  return {
    x: Math.max(0, Math.min(MAP_DIM - 1, Math.floor(cx / TILE_PX))),
    y: Math.max(0, Math.min(MAP_DIM - 1, Math.floor(cy / TILE_PX))),
  };
}

function applyToolAt(x, y) {
  const tool = $('input[name="tool"]:checked').value;

  if (tool === 'paint-tile') {
    const tex   = parseInt($('#tile-texture').value, 10) || 0;
    const depth = parseInt($('#tile-depth').value, 10) || 0;
    const rot   = parseInt($('#tile-rotation').value, 10) || 0;
    const idx = x + y * MAP_DIM;
    level.tiles[idx] = {
      raw: packTileRaw(depth, false, rot),
      texture: tex,
      dummy: 0,
    };
  }

  else if (tool === 'place-entity') {
    const type = $('#entity-type').value;
    const dirDeg = parseInt($('#entity-direction').value, 10) || 0;
    const reserved = new Array(16).fill(0);
    if (type === 'crate') {
      let flags = 0;
      if ($('#crate-flag-health').checked) flags |= 0x01;
      if ($('#crate-flag-bomb').checked)   flags |= 0x02;
      if ($('#crate-flag-mine').checked)   flags |= 0x04;
      reserved[0] = flags;
      reserved[1] = parseInt($('#entity-model').value, 10) || 0;
    } else if (type === 'model') {
      reserved[1] = parseInt($('#entity-model').value, 10) || 0;
    }
    const e = {
      type, type_id: ({empty:0, player_spawn:1, model:2, crate:3})[type],
      x, y,
      direction: degToFxpRad(dirDeg),
      reserved,
    };
    level.entities.push(e);
    selectedEntityIdx = level.entities.length - 1;
  }

  else if (tool === 'erase-entity') {
    // Remove the LAST entity at this tile (LIFO)
    for (let i = level.entities.length - 1; i >= 0; i--) {
      if (level.entities[i].x === x && level.entities[i].y === y) {
        level.entities.splice(i, 1);
        if (selectedEntityIdx === i) selectedEntityIdx = -1;
        else if (selectedEntityIdx > i) selectedEntityIdx--;
        break;
      }
    }
  }

  drawAll();
  refreshSidebar();
}

let isPainting = false;
canvas.addEventListener('mousedown', (ev) => {
  isPainting = true;
  const { x, y } = tileFromEvent(ev);
  applyToolAt(x, y);
});
canvas.addEventListener('mousemove', (ev) => {
  if (!isPainting) return;
  const tool = $('input[name="tool"]:checked').value;
  if (tool !== 'paint-tile') return;   // only painting drags
  const { x, y } = tileFromEvent(ev);
  applyToolAt(x, y);
});
window.addEventListener('mouseup', () => { isPainting = false; });
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());


// ---- sidebar / info refresh --------------------------------------------

function refreshSidebar() {
  const ents = level.entities;
  const spawns = ents.filter(e => e.type === 'player_spawn' || e.type_id === 1).length;
  const crates = ents.filter(e => e.type === 'crate'        || e.type_id === 3).length;
  $('#info-entities').textContent = ents.length;
  $('#info-spawns').textContent   = spawns;
  $('#info-crates').textContent   = crates;
  // Estimated .UTE size
  const FIXED_PREFIX = 9624;
  const ENT_SIZE = 28;
  $('#info-size').textContent = `${FIXED_PREFIX + ents.length * ENT_SIZE} B`;

  // Entity list
  const ul = $('#entity-list');
  ul.innerHTML = '';
  ents.forEach((e, i) => {
    const li = document.createElement('li');
    if (i === selectedEntityIdx) li.classList.add('selected');
    const t = e.type || 'empty';
    const tagClass = ({player_spawn:'ent-spawn', model:'ent-model',
                       crate:'ent-crate', empty:'ent-empty'})[t] || 'ent-empty';
    li.innerHTML = `<span class="ent-tag ${tagClass}">${t}</span>` +
                   `<span class="muted">(${e.x},${e.y}) dir=${fxpRadToDeg(e.direction)}°</span>`;
    li.addEventListener('click', () => {
      selectedEntityIdx = i;
      drawAll();
      refreshSidebar();
    });
    ul.appendChild(li);
  });
}


// ---- API client --------------------------------------------------------

async function api(method, path, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  let data;
  try { data = await r.json(); } catch { data = null; }
  if (!r.ok) {
    const e = new Error((data && (data.error || data.errors)) || r.statusText);
    e.status = r.status;
    e.body = data;
    throw e;
  }
  return data;
}

async function slugifyOnServer(name) {
  const r = await api('GET', `/api/slugify?name=${encodeURIComponent(name)}`);
  return r.slug;
}


// ---- save / load / new --------------------------------------------------

$('#btn-new').addEventListener('click', () => {
  if (!confirm('Discard current map and start fresh?')) return;
  level = createEmptyLevel();
  selectedEntityIdx = -1;
  $('#map-name').value = '';
  $('#map-author').value = '';
  drawAll(); refreshSidebar();
  toast('New empty map created');
});

$('#btn-save').addEventListener('click', async () => {
  const name = $('#map-name').value.trim();
  const author = $('#map-author').value.trim();
  if (!name) {
    toast('Please enter a map name first', true);
    return;
  }
  level.meta.name   = name;
  level.meta.author = author;

  const slug = await slugifyOnServer(name);

  try {
    const r = await api('POST', `/api/maps/${encodeURIComponent(slug)}`, level);
    let msg = `Saved ${slug} (${r.ute_size_bytes} B .UTE)`;
    if (r.warnings && r.warnings.length) {
      msg += ` — ${r.warnings.length} warning(s)`;
    }
    toast(msg);
    showValidation(r.errors || [], r.warnings || []);
  } catch (e) {
    if (e.body && e.body.errors) {
      showValidation(e.body.errors, e.body.warnings || []);
      toast(`Cannot save: ${e.body.errors.length} error(s) — see panel`, true);
    } else {
      toast(`Save failed: ${e.message}`, true);
    }
  }
});

$('#btn-validate').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/validate', level);
    showValidation(r.errors, r.warnings);
    if (r.errors.length === 0) {
      toast(`Valid — would produce ${r.ute_size_bytes}-byte .UTE`);
    } else {
      toast(`${r.errors.length} error(s), ${r.warnings.length} warning(s)`, true);
    }
  } catch (e) {
    toast(`Validate failed: ${e.message}`, true);
  }
});

$('#btn-download').addEventListener('click', async () => {
  const name = $('#map-name').value.trim();
  if (!name) { toast('Save the map first', true); return; }
  const slug = await slugifyOnServer(name);
  // Force a save then download
  try {
    await api('POST', `/api/maps/${encodeURIComponent(slug)}?force=1`, level);
    window.location = `/api/maps/${encodeURIComponent(slug)}/ute`;
  } catch (e) {
    toast(`Download failed: ${e.message}`, true);
  }
});

$('#btn-load').addEventListener('click', async () => {
  await refreshLoadDialog();
  $('#load-dialog').showModal();
});

async function refreshLoadDialog() {
  const ul = $('#load-list');
  ul.innerHTML = '<li class="muted">Loading…</li>';
  try {
    const r = await api('GET', '/api/maps');
    ul.innerHTML = '';
    if (!r.maps.length) {
      ul.innerHTML = '<li class="muted">No saved maps yet</li>';
      return;
    }
    r.maps.forEach(m => {
      const li = document.createElement('li');
      const dt = m.updated_at
        ? new Date(m.updated_at * 1000).toLocaleString()
        : '—';
      li.innerHTML = `
        <div>
          <div><strong>${escapeHtml(m.name || m.slug)}</strong></div>
          <div class="meta">${escapeHtml(m.author || '?')} · ${m.size_bytes} B · ${dt}</div>
        </div>
        <div>
          <button class="btn" data-load="${escapeAttr(m.slug)}">Open</button>
          <button class="del-btn" data-del="${escapeAttr(m.slug)}">×</button>
        </div>`;
      ul.appendChild(li);
    });
    ul.querySelectorAll('[data-load]').forEach(b => {
      b.addEventListener('click', async () => {
        const slug = b.getAttribute('data-load');
        try {
          const data = await api('GET', `/api/maps/${encodeURIComponent(slug)}`);
          loadLevelData(data);
          $('#load-dialog').close();
          toast(`Loaded ${slug}`);
        } catch (e) {
          toast(`Load failed: ${e.message}`, true);
        }
      });
    });
    ul.querySelectorAll('[data-del]').forEach(b => {
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const slug = b.getAttribute('data-del');
        if (!confirm(`Delete ${slug}?`)) return;
        try {
          await api('DELETE', `/api/maps/${encodeURIComponent(slug)}`);
          toast(`Deleted ${slug}`);
          await refreshLoadDialog();
        } catch (e) {
          toast(`Delete failed: ${e.message}`, true);
        }
      });
    });
  } catch (e) {
    ul.innerHTML = `<li class="muted">Failed: ${escapeHtml(e.message)}</li>`;
  }
}

function loadLevelData(data) {
  level = data;
  // Ensure required arrays exist
  if (!level.tiles || level.tiles.length !== MAP_DIM*MAP_DIM) {
    const fresh = createEmptyLevel();
    level.tiles = level.tiles || fresh.tiles;
    level.gourad = level.gourad || fresh.gourad;
    level.normals = level.normals || fresh.normals;
    level.light = level.light || fresh.light;
  }
  level.entities = level.entities || [];
  $('#map-name').value   = (level.meta && level.meta.name)   || '';
  $('#map-author').value = (level.meta && level.meta.author) || '';
  selectedEntityIdx = -1;
  drawAll(); refreshSidebar();
}


// ---- validation panel display ------------------------------------------

function showValidation(errors, warnings) {
  const div = $('#validation-output');
  if (!errors.length && !warnings.length) {
    div.innerHTML = '<span class="ok">✓ All good.</span>';
    return;
  }
  let html = '';
  if (errors.length) {
    html += '<div class="err"><strong>Errors:</strong></div>';
    errors.forEach(e => { html += `<div class="err">• ${escapeHtml(e)}</div>`; });
  }
  if (warnings.length) {
    html += '<div class="warn"><strong>Warnings:</strong></div>';
    warnings.forEach(w => { html += `<div class="warn">• ${escapeHtml(w)}</div>`; });
  }
  div.innerHTML = html;
}


// ---- escaping ----------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }


// ---- swatch palette wiring --------------------------------------------

$$('.swatch').forEach(b => {
  b.style.background = b.getAttribute('data-color');
  b.addEventListener('click', () => {
    $$('.swatch').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    $('#tile-texture').value = b.getAttribute('data-tex');
  });
});


// ---- entity-type panel toggle -----------------------------------------

function refreshEntityToolUi() {
  const t = $('#entity-type').value;
  $('#row-entity-model').style.display       = (t === 'model' || t === 'crate') ? '' : 'none';
  $('#row-entity-crate-flags').style.display = (t === 'crate') ? '' : 'none';
}
$('#entity-type').addEventListener('change', refreshEntityToolUi);


// ---- boot --------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  refreshEntityToolUi();
  drawAll();
  refreshSidebar();
});
