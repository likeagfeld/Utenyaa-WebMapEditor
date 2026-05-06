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

// View orientation: the Saturn engine renders the map with world +X
// going to screen LEFT (camera + rotate_x(0.5) + translate(-10,-10,0)
// chain — see Player.hpp HandleMovement comments). The editor canvas
// is conventional: canvas X+ = screen RIGHT. To make WYSIWYG match
// what the player sees in-game we mirror tile X on draw and unmirror
// on click. Single source of truth — flip this constant if the engine
// camera ever changes.
const VIEW_MIRROR_X = true;
function tileToCanvasX(tx) {
  return (VIEW_MIRROR_X ? (MAP_DIM - 1 - tx) : tx) * TILE_PX;
}
function canvasXToTile(cx) {
  const raw = Math.floor(cx / TILE_PX);
  return VIEW_MIRROR_X ? (MAP_DIM - 1 - raw) : raw;
}

function drawAll() {
  ctx.fillStyle = '#0a0a14';
  ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);

  // Tile cells. Tile coords (x,y) are AUTHORING coords — they go into
  // the .UTE file as-is. The canvas position uses tileToCanvasX() to
  // mirror so the editor view matches the in-game orientation.
  for (let y = 0; y < MAP_DIM; y++) {
    for (let x = 0; x < MAP_DIM; x++) {
      const idx = x + y * MAP_DIM;
      const t = level.tiles[idx];
      const cxPx = tileToCanvasX(x);
      const color = TILE_COLORS[t.texture] || DEFAULT_TILE_COLOR;
      ctx.fillStyle = color;
      ctx.fillRect(cxPx, y * TILE_PX, TILE_PX, TILE_PX);

      // Depth shading — darker for higher depth (Z up)
      const depth = unpackTileDepth(t.raw);
      if (depth > 0) {
        ctx.fillStyle = `rgba(0,0,0,${Math.min(depth/15 * 0.5, 0.5)})`;
        ctx.fillRect(cxPx, y * TILE_PX, TILE_PX, TILE_PX);
      }

      // Texture index small label
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '9px monospace';
      ctx.fillText(String(t.texture), cxPx + 2, y*TILE_PX + 10);

      // Rotation indicator (small triangle)
      const rot = unpackTileRotation(t.raw);
      if (rot !== 0) {
        ctx.save();
        ctx.translate(cxPx + TILE_PX/2, y*TILE_PX + TILE_PX/2);
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
  // Mirror the canvas X so entities draw at their in-game screen
  // position (engine: world +X = screen LEFT). Entity tile coords
  // stored in `e.x` are authoring/wire coords — unchanged.
  const cx = tileToCanvasX(e.x) + TILE_PX/2;
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
  // canvasXToTile undoes the X mirror so authored tile coords still
  // correspond to where the user clicked on the (mirrored) canvas.
  return {
    x: Math.max(0, Math.min(MAP_DIM - 1, canvasXToTile(cx))),
    y: Math.max(0, Math.min(MAP_DIM - 1, Math.floor(cy / TILE_PX))),
  };
}

function countSpawns() {
  return level.entities.filter(e =>
    e.type === 'player_spawn' || e.type_id === 1).length;
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

  else if (tool === 'place-spawn' || tool === 'place-model' || tool === 'place-crate') {
    let type;
    if (tool === 'place-spawn') type = 'player_spawn';
    else if (tool === 'place-model') type = 'model';
    else type = 'crate';

    // Engine cap: UNET_MAX_PLAYERS = 4. Block extra spawns.
    if (type === 'player_spawn' && countSpawns() >= MAX_PLAYER_SPAWNS) {
      toast(`Player start limit (${MAX_PLAYER_SPAWNS}) reached — match supports up to 4 players`, true);
      return;
    }

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
  refreshToolUi();
  if (window._afterEdit) window._afterEdit();
}

function refreshToolUi() {
  // Show/hide entity option rows based on which place tool is active.
  const tool = $('input[name="tool"]:checked').value;
  const showModel = (tool === 'place-model' || tool === 'place-crate');
  const showCrate = (tool === 'place-crate');
  $('#row-entity-model').style.display = showModel ? '' : 'none';
  $('#row-entity-crate-flags').style.display = showCrate ? '' : 'none';
  // Spawn-cap counter
  const spawn = countSpawns();
  const counter = $('#spawn-counter');
  counter.textContent = `${spawn}/${MAX_PLAYER_SPAWNS}`;
  counter.style.color = spawn >= MAX_PLAYER_SPAWNS ? '#e94560' : '#888';
}

let isPainting = false;
canvas.addEventListener('mousedown', (ev) => {
  // Right-click rotates the tile under the cursor by 90°. The
  // editor's 4-state tile rotation matches the engine's
  // baseIndex permutation (0/90/180/270) so click-cycling
  // walks the same set of looks the engine will render.
  // Entity rotation: right-click on an entity rotates its
  // direction by 45°. Hold Shift for fine-grained 15° steps.
  if (ev.button === 2) {
    ev.preventDefault();
    rotateAtCursor(ev, ev.shiftKey ? 15 : 45);
    return;
  }
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

// Wheel rotates the cursor's entity (or tile) — fine adjustments
// without dragging or typing. Up = +rotation, Down = -.
canvas.addEventListener('wheel', (ev) => {
  if (ev.ctrlKey) return;  // let browser zoom pass through
  ev.preventDefault();
  const step = ev.shiftKey ? 5 : 15;
  rotateAtCursor(ev, ev.deltaY < 0 ? step : -step);
}, { passive: false });

/* ---- rotation-at-tile helper ------------------------------------------
 *
 * Both the 2D canvas's right-click/wheel handlers AND the 3D view's
 * right-click handler call this with explicit tile coords. If an
 * ENTITY is at the tile, rotate its direction (continuous, fxp 16.16
 * radians on disk). If only a TILE is there, advance its rotation
 * bits by one quarter turn (4-state, 0/90/180/270). Both update
 * immediately and force a redraw + 3D refresh so the user sees the
 * change. Exposed at window scope so editor3d.js can call it. */
window.rotateAtTile = function rotateAtTile(x, y, degDelta) {
  // Entity hit-test: any entity at this tile cell, LIFO.
  let hit = -1;
  for (let i = level.entities.length - 1; i >= 0; i--) {
    if (level.entities[i].x === x && level.entities[i].y === y) {
      hit = i; break;
    }
  }
  if (hit >= 0) {
    const e = level.entities[hit];
    // direction is fxp 16.16 in radians. Convert to degrees, rotate,
    // back to fxp.
    const curDeg = (e.direction / 65536.0) * (180 / Math.PI);
    const newDeg = ((curDeg + degDelta) % 360 + 360) % 360;
    e.direction = degToFxpRad(newDeg);
    selectedEntityIdx = hit;
    drawAll();
    refreshSidebar();
    if (typeof refreshFromLevel === 'function') refreshFromLevel();
    return;
  }
  // No entity → cycle tile rotation by 90°. Sign of degDelta picks
  // direction; small steps still snap to a 90° increment.
  const step = degDelta >= 0 ? 1 : 3;   // 3 = -1 mod 4
  const idx = x + y * MAP_DIM;
  const t = level.tiles[idx];
  if (!t) return;
  const curRot = (t.raw >> 6) & 3;
  const newRot = (curRot + step) & 3;
  const depth  = unpackTileDepth(t.raw);
  const mirror = unpackTileMirror(t.raw);
  level.tiles[idx] = {
    raw: packTileRaw(depth, mirror, newRot),
    texture: t.texture,
    dummy:   t.dummy || 0,
  };
  drawAll();
  if (typeof refreshFromLevel === 'function') refreshFromLevel();
};

function rotateAtCursor(ev, degDelta) {
  const { x, y } = tileFromEvent(ev);
  window.rotateAtTile(x, y, degDelta);
}

// Also expose the apply-tool function so the 3D view can call it
// after raycasting a tile coord. Capture the original function
// references BEFORE reassigning to window — function declarations
// at top level alias the same binding as window.<name>, so a
// naive `window.foo = function () { foo(); }` would clobber the
// lexical binding and recurse infinitely (observed as "maximum
// call stack exceeded" on editor load).
const _origApplyToolAt   = applyToolAt;
const _origRefreshSidebar = refreshSidebar;
const _origDrawAll       = drawAll;
window.applyToolAtTile = function (x, y) { _origApplyToolAt(x, y); _origDrawAll(); };
window.refreshSidebar  = _origRefreshSidebar;


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
  const r = await api('GET', `api/slugify?name=${encodeURIComponent(name)}`);
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
    const r = await api('POST', `api/maps/${encodeURIComponent(slug)}`, level);
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
    const r = await api('POST', 'api/validate', level);
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
    await api('POST', `api/maps/${encodeURIComponent(slug)}?force=1`, level);
    window.location = `api/maps/${encodeURIComponent(slug)}/ute`;
  } catch (e) {
    toast(`Download failed: ${e.message}`, true);
  }
});

// Mirror Map X — server-side X-axis flip on the saved file. Idempotent
// (run twice = original). After the call we re-fetch the saved map so
// the in-memory `level` reflects the flipped state — without this
// re-fetch a subsequent Save would clobber the mirror with the user's
// (un-flipped) in-memory cache. Race-protection: the same race that
// re-mirroring shiro hit during the 0.6 deploy.
$('#btn-mirror-x').addEventListener('click', async () => {
  const name = $('#map-name').value.trim();
  if (!name) { toast('Save the map first, then mirror', true); return; }
  if (!confirm(
        'Mirror the saved "' + name + '" map across its X axis?\n\n' +
        'This rewrites the .UTE file on the server. Run twice to undo.\n' +
        'A pre-mirror backup is created automatically the first time.')) {
    return;
  }
  const slug = await slugifyOnServer(name);
  try {
    // Force-save first so the mirror operates on the user's latest
    // edits, not a stale on-disk copy. Without this, a user who
    // edited in-memory then clicked Mirror X would lose their
    // unsaved changes when the mirror reloaded from disk.
    await api('POST', `api/maps/${encodeURIComponent(slug)}?force=1`, level);
    const r = await api('POST', `api/maps/${encodeURIComponent(slug)}/mirror_x`);
    // Re-fetch the saved map so in-memory level reflects the flip;
    // any pending unsaved edits the user made AFTER the force-save
    // above would be lost — this is intentional, the confirm()
    // above warned them. loadLevelData is the same path used by the
    // Load… dialog so it's already wired to redraw both 2D + 3D.
    const data = await api('GET', `api/maps/${encodeURIComponent(slug)}`);
    loadLevelData(data);
    drawAll();
    toast('Mirrored: ' + r.entities + ' entities flipped, ' +
          (r.ute_size_bytes||'?') + ' bytes');
  } catch (e) {
    toast('Mirror failed: ' + (e && e.message || e), true);
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
    const r = await api('GET', 'api/maps');
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
      // Delete button rendered hidden by default; applyAdminUi() un-
      // hides for admins. Open / Clone are always available.
      li.innerHTML = `
        <div>
          <div><strong>${escapeHtml(m.name || m.slug)}</strong></div>
          <div class="meta">${escapeHtml(m.author || '?')} · ${m.size_bytes} B · ${dt}</div>
        </div>
        <div>
          <button class="btn" data-load="${escapeAttr(m.slug)}">Open</button>
          <button class="btn" data-clone="${escapeAttr(m.slug)}" title="Clone this map and edit as your own">Clone</button>
          <button class="del-btn ${isAdmin ? '' : 'hidden'}" data-del="${escapeAttr(m.slug)}" title="Delete (admin only)">×</button>
        </div>`;
      ul.appendChild(li);
    });
    ul.querySelectorAll('[data-load]').forEach(b => {
      b.addEventListener('click', async () => {
        const slug = b.getAttribute('data-load');
        try {
          const data = await api('GET', `api/maps/${encodeURIComponent(slug)}`);
          loadLevelData(data);
          $('#load-dialog').close();
          toast(`Loaded ${slug}`);
        } catch (e) {
          toast(`Load failed: ${e.message}`, true);
        }
      });
    });
    ul.querySelectorAll('[data-clone]').forEach(b => {
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const slug = b.getAttribute('data-clone');
        try {
          const data = await api('GET', `api/maps/${encodeURIComponent(slug)}`);
          // Generate a new name. Suggest "<original> (copy)" so the
          // resulting slug differs and Save creates a fresh entry.
          const base = (data.meta && data.meta.name) || slug;
          const newName = await promptNewMapName(`${base} (copy)`);
          if (!newName) return;     // user cancelled
          // Reset metadata to mark this as a clone owned by the cloner.
          data.meta = data.meta || {};
          data.meta.name        = newName;
          data.meta.author      = $('#map-author').value || data.meta.author || '';
          data.meta.description = `Cloned from ${slug}`;
          loadLevelData(data);
          $('#load-dialog').close();
          toast(`Cloned ${slug} → "${newName}". Edit and Save to keep.`);
        } catch (e) {
          toast(`Clone failed: ${e.message}`, true);
        }
      });
    });
    ul.querySelectorAll('[data-del]').forEach(b => {
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const slug = b.getAttribute('data-del');
        if (!isAdmin) {
          toast('Admin mode required to delete maps', true);
          return;
        }
        if (!confirm(`Delete ${slug}? This cannot be undone.`)) return;
        try {
          await api('DELETE', `api/maps/${encodeURIComponent(slug)}`);
          toast(`Deleted ${slug}`);
          await refreshLoadDialog();
        } catch (e) {
          if (e.status === 403) {
            toast('Admin mode required to delete maps', true);
            isAdmin = false; applyAdminUi();
          } else {
            toast(`Delete failed: ${e.message}`, true);
          }
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
  drawAll(); refreshSidebar(); refreshToolUi();
  if (window._afterEdit) window._afterEdit();
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


// ---- prompt for a new map name (used by Clone) -------------------------

async function promptNewMapName(suggestion) {
  // Native prompt is fine here — uniform across browsers, doesn't need
  // a custom modal. User can edit / cancel.
  const v = window.prompt('Name for the cloned map:', suggestion || '');
  if (v === null) return null;
  const trimmed = v.trim();
  return trimmed || null;
}


// ---- escaping ----------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }


// ---- tool-radio change wiring ----------------------------------------

$$('input[name="tool"]').forEach(r => {
  r.addEventListener('change', refreshToolUi);
});


// ---- admin mode --------------------------------------------------------
//
// Admin status is server-authoritative (Flask session cookie). We mirror
// it client-side just to drive UI visibility — the server enforces the
// gate independently on every DELETE request.

let isAdmin = false;

async function refreshAdminStatus() {
  // Server-driven: /api/admin/status now reports is_admin + the
  // deploy-time mode flags. Three modes are supported:
  //   - admin portal (UTENYAA_AUTO_ADMIN=1): is_admin always true
  //   - public mount (UTENYAA_PUBLIC_MODE=1): is_admin always false
  //   - standalone:                          is_admin from session
  // Frontend just trusts what the server returns; CSS in index.html
  // already hides the admin-login UI for the admin-portal embed.
  try {
    const r = await api('GET', 'api/admin/status');
    isAdmin = !!r.is_admin;
    // Public mode also hides the admin button + dialog so users
    // don't see a redundant "Admin Mode" prompt that can never
    // succeed. (The CSS rule in index.html covers the auto-admin
    // case; this script-side rule covers public mode where there
    // is no upstream gate.)
    if (r.public_mode) {
      const css = document.createElement('style');
      css.textContent = '#btn-admin,#admin-badge,#admin-dialog{display:none!important}';
      document.head.appendChild(css);
    }
  } catch {
    isAdmin = false;
  }
  applyAdminUi();
}

function applyAdminUi() {
  $('#admin-badge').classList.toggle('hidden', !isAdmin);
  const btn = $('#btn-admin');
  if (isAdmin) {
    btn.textContent = 'Logout admin';
    btn.classList.add('active');
  } else {
    btn.textContent = 'Admin Mode';
    btn.classList.remove('active');
  }
  // Hide delete buttons in the load dialog if not admin
  $$('.del-btn').forEach(b => b.classList.toggle('hidden', !isAdmin));
}

async function adminLogin(username, password) {
  try {
    await api('POST', 'api/admin/login', { username, password });
    isAdmin = true;
    applyAdminUi();
    toast('Admin mode enabled');
    return true;
  } catch (e) {
    return false;
  }
}

async function adminLogout() {
  try {
    await api('POST', 'api/admin/logout');
  } catch { /* ignore */ }
  isAdmin = false;
  applyAdminUi();
  toast('Logged out of admin mode');
}

$('#btn-admin').addEventListener('click', () => {
  if (isAdmin) {
    if (confirm('Log out of admin mode?')) adminLogout();
  } else {
    $('#admin-error').textContent = '';
    $('#admin-user').value = '';
    $('#admin-pass').value = '';
    $('#admin-dialog').showModal();
    setTimeout(() => $('#admin-user').focus(), 50);
  }
});

$('#admin-cancel').addEventListener('click', () => {
  $('#admin-dialog').close();
});

$('#admin-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const u = $('#admin-user').value;
  const p = $('#admin-pass').value;
  const ok = await adminLogin(u, p);
  if (ok) {
    $('#admin-dialog').close();
    // Reflect new admin state in any open Load dialog
    if ($('#load-dialog').open) refreshLoadDialog();
  } else {
    $('#admin-error').textContent = 'Invalid credentials';
  }
});


// ---- texture palette (loaded from server) ------------------------------

let textureInfo = [];   // [{index, width, height}, ...] from /api/textures

async function loadTexturePalette() {
  try {
    const r = await api('GET', 'api/textures');
    textureInfo = r.textures || [];
    renderTexturePalette();
    // Cap the texture index spinner to the actual count
    const spinner = $('#tile-texture');
    if (spinner && textureInfo.length > 0) {
      spinner.max = String(textureInfo.length - 1);
    }
  } catch (e) {
    console.warn('texture palette: ' + e.message);
  }
}

function renderTexturePalette() {
  const div = $('#texture-palette');
  if (!div) return;
  div.innerHTML = '';
  textureInfo.forEach(t => {
    const cell = document.createElement('button');
    cell.className = 'tex-cell';
    cell.title = `Texture ${t.index} (${t.width}x${t.height})`;
    cell.dataset.tex = t.index;
    const img = document.createElement('img');
    img.src = `api/textures/${t.index}.png`;
    img.alt = `tex ${t.index}`;
    cell.appendChild(img);
    const lbl = document.createElement('span');
    lbl.className = 'tex-cell-label';
    lbl.textContent = String(t.index);
    cell.appendChild(lbl);
    cell.addEventListener('click', () => {
      $('#tile-texture').value = t.index;
      $$('.tex-cell').forEach(c => c.classList.remove('active'));
      cell.classList.add('active');
    });
    div.appendChild(cell);
  });
}


// ---- view tab switcher (2D <-> 3D) -------------------------------------

function setupViewTabs() {
  $$('.view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;
      $$('.view-tab').forEach(t => t.classList.toggle('active', t === tab));
      $$('.view-pane').forEach(p =>
        p.classList.toggle('active', p.classList.contains('view-' + view)));
      // Tell the 3D module to refresh + handle its first init
      if (view === '3d' && window.utenyaa3D) {
        window.utenyaa3D.show();
      } else if (window.utenyaa3D) {
        window.utenyaa3D.hide();
      }
    });
  });
}


// ---- expose level state for the 3D module -----------------------------

// editor3d.js reads from window.utenyaaState rather than importing this
// module (separate <script> contexts).
window.utenyaaState = {
  getLevel: () => level,
  getTextures: () => textureInfo,
  onLevelChange: null,
};

// Hook drawAll so any 2D edit also refreshes the 3D scene
const _origDrawAll = drawAll;
window._afterEdit = () => {
  if (window.utenyaa3D && window.utenyaa3D.isVisible()) {
    window.utenyaa3D.refreshFromLevel();
  }
};


// ---- boot --------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  refreshToolUi();
  drawAll();
  refreshSidebar();
  if (window._afterEdit) window._afterEdit();
  setupViewTabs();
  loadTexturePalette();
  refreshAdminStatus();
  // 2D editor is hidden by default — boot directly into 3D so users
  // see the WYSIWYG view immediately without clicking a tab. The 2D
  // pane stays in the DOM (display:none) so its handlers/state stay
  // wired and toggling it back is a one-line CSS change.
  if (window.utenyaa3D) window.utenyaa3D.show();
});
