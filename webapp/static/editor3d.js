/* editor3d.js — Engine-accurate 3D preview of the Utenyaa heightmap.
 *
 * Renders what the Saturn would show on screen as closely as the
 * browser allows:
 *
 *   • Terrain uses MeshBasicMaterial with vertexColors. The gouraud
 *     table in the .UTE is precomputed lighting baked at design time
 *     (see Map.hpp:289 — engine writes Gouraud[i] straight to VDP1
 *     VRAM, no runtime shading on top). To match exactly we apply
 *     vertex colors as-is with no further light contribution.
 *
 *   • Textures: NearestFilter (Saturn point sampling), no mipmaps,
 *     ClampToEdge (Saturn doesn't repeat across quad bounds).
 *
 *   • Tile UVs honor the rotation+mirror bits in the
 *     DepthAndRotationAndMirror byte the same way the engine does.
 *
 *   • NYA models: real geometry from /api/models/<idx>. Each polygon
 *     becomes 2 triangles preserving the 4-vertex quad UVs and face
 *     flags. Textured faces use their NYA texture; non-textured faces
 *     use BaseColor as a Lambert tint (matches the engine's
 *     ATTRIBUTE() call in src/Objects/Model.hpp:166).
 *
 *   • Lighting: terrain stays self-lit (BasicMaterial). Models use
 *     LambertMaterial driven by a single DirectionalLight whose
 *     orientation matches the .UTE LevelLight.Direction (engine
 *     slLight((-direction))).
 *
 *   • Coordinate convention: 1 tile = 8 world units (Map.hpp's `<<3`
 *     scaling on point table + entity locations). Tile (0,0) at world
 *     origin, tile (19,19) at (152,152,0).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---- engine-mirrored constants ---------------------------------------

const MAP_DIM = 20;
const TILE_WORLD = 8;            // engine: vertex = (x<<19) → 8 world units per tile


// ---- module state ----------------------------------------------------

let renderer, scene, camera, controls;
let mountEl;
let groupTerrain, groupEntities, groupGrid;
let dirLight, ambLight;
let textureCache = new Map();    // tile-tex idx → THREE.Texture
let modelCache = new Map();      // model idx → {meshes, textures}
let initialized = false, visible = false;
let rafHandle = 0;


// ---- ARGB-1555 → THREE.Color -----------------------------------------

function gouraudToColor(argb) {
  const r5 = argb & 0x1F;
  const g5 = (argb >> 5) & 0x1F;
  const b5 = (argb >> 10) & 0x1F;
  const r = ((r5 << 3) | (r5 >> 2)) / 255;
  const g = ((g5 << 3) | (g5 >> 2)) / 255;
  const b = ((b5 << 3) | (b5 >> 2)) / 255;
  return new THREE.Color(r, g, b);
}


// ---- texture loading -------------------------------------------------

function getTileTexture(idx) {
  if (textureCache.has(idx)) return textureCache.get(idx);
  const tex = new THREE.TextureLoader().load(`api/textures/${idx}.png`);
  // Saturn uses point sampling (no bilinear, no mipmaps).
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(idx, tex);
  return tex;
}


// ---- model loading (real NYA geometry) -------------------------------

async function loadModelOnce(idx) {
  if (modelCache.has(idx)) return modelCache.get(idx);
  try {
    const r = await fetch(`api/models/${idx}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const json = await r.json();
    const textures = json.textures.map(t => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + t.png_base64;
      const tex = new THREE.Texture(img);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      img.onload = () => { tex.needsUpdate = true; };
      return tex;
    });
    modelCache.set(idx, { meshes: json.meshes, textures, name: json.name });
    return modelCache.get(idx);
  } catch (e) {
    console.warn(`failed to load model ${idx}:`, e.message);
    modelCache.set(idx, null);
    return null;
  }
}


// ---- one-time scene init ---------------------------------------------

function init() {
  if (initialized) return;
  mountEl = document.getElementById('three-mount');
  if (!mountEl) return;

  const W = mountEl.clientWidth || 640;
  const H = mountEl.clientHeight || 640;

  renderer = new THREE.WebGLRenderer({ antialias: false });   // Saturn has no AA
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(W, H);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mountEl.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a14);

  camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 2000);
  recenterCamera();

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(MAP_DIM * TILE_WORLD / 2, MAP_DIM * TILE_WORLD / 2, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 30;
  controls.maxDistance = 600;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.update();

  // Engine: slLight is a single directional light. Used by ATTRIBUTE
  // entries that have UseLight (all NYA models do, per Model.hpp:174).
  // Terrain (Map.hpp) uses No_Gouraud → does NOT consume slLight at
  // runtime — its per-vertex colors are pre-baked.
  ambLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambLight);
  dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
  dirLight.position.set(40, -40, 80);
  scene.add(dirLight);

  groupTerrain  = new THREE.Group();
  groupEntities = new THREE.Group();
  groupGrid     = new THREE.Group();
  scene.add(groupTerrain, groupEntities, groupGrid);

  document.getElementById('btn-3d-recenter').addEventListener('click', () => {
    recenterCamera(); controls.update();
  });
  document.getElementById('chk-show-grid').addEventListener('change', (e) => {
    groupGrid.visible = e.target.checked;
  });
  document.getElementById('chk-show-entities').addEventListener('change', (e) => {
    groupEntities.visible = e.target.checked;
  });
  document.getElementById('chk-show-gouraud').addEventListener('change', () => {
    refreshFromLevel();
  });

  window.addEventListener('resize', onResize);

  // ----- 3D click-to-edit -------------------------------------------
  // Left-click (without drag) at a tile → applies the current tool
  // from the toolbox (paint, place spawn/model/crate, erase). The
  // 2D canvas's same applyToolAt is reused — single source of truth.
  // Left-DRAG falls through to OrbitControls for camera orbit.
  // Right-click (without drag) → rotates the tile/entity at the
  // cursor by 45° (15° if Shift held), 4-state for tiles. Wheel
  // remains zoom (default OrbitControls behavior); rotation via
  // right-click avoids the wheel-vs-zoom collision.
  //
  // Drag detection: on mouseup, compare to mousedown coords. If the
  // pointer moved < 5 pixels, treat as a click; otherwise it was an
  // orbit drag handled by OrbitControls.
  // ----- 3D pointer state (shared by edit + rotate-aim modes) -----
  const _picker = {
    raycaster: new THREE.Raycaster(),
    pointer:   new THREE.Vector2(),
    downX: -1, downY: -1, downBtn: -1,
  };
  function _setPointerFromEvent(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    _picker.pointer.x =  ((ev.clientX - rect.left) / rect.width)  * 2 - 1;
    _picker.pointer.y = -((ev.clientY - rect.top)  / rect.height) * 2 + 1;
  }
  function _raycastTile() {
    _picker.raycaster.setFromCamera(_picker.pointer, camera);
    const hits = _picker.raycaster.intersectObject(groupTerrain, true);
    if (!hits.length) return null;
    const p = hits[0].point;
    const tx = Math.floor(p.x / TILE_WORLD);
    const ty = Math.floor(p.y / TILE_WORLD);
    if (tx < 0 || tx >= MAP_DIM || ty < 0 || ty >= MAP_DIM) return null;
    return { x: tx, y: ty, world: p };
  }
  function _entityAtTile(level, x, y) {
    if (!level) return -1;
    for (let i = level.entities.length - 1; i >= 0; i--) {
      if (level.entities[i].x === x && level.entities[i].y === y) return i;
    }
    return -1;
  }

  // ----- Rotate Mode buttons (Tile vs Object, mutually exclusive) ---
  // The 3D view has THREE click modes, switched via two toolbar
  // buttons in the three-overlay:
  //
  //   1. 'none' (default): clicks apply the current toolbox tool
  //      (Paint tile, Place spawn/model/crate, Erase). Drag = orbit.
  //
  //   2. 'tile' (Rotate Tile button ON): clicks cycle the tile
  //      texture rotation 90° (4-state) at the click point. ALWAYS
  //      hits the tile, even when an entity sits on top of it —
  //      this is how the operator rotates a tile under a wall/
  //      crate/spawn. Mutually exclusive with 'object'.
  //
  //   3. 'object' (Rotate Object button ON): clicks on entities
  //      enter aim mode (move mouse → re-aim, click → commit).
  //      Clicks on empty tiles do nothing in this mode. Mutually
  //      exclusive with 'tile'.
  //
  // Modes are persistent so the operator can rotate many things in
  // a row without re-toggling. Clicking the active button toggles
  // it back to 'none'. Clicking the OTHER button switches modes.
  // ESC cancels an in-progress aim first; a second ESC exits the
  // current rotate mode back to 'none'.
  let _rotateMode    = 'none';   // 'none' | 'tile' | 'object'
  let _aimEntityIdx  = -1;
  let _aimOriginalDir = 0;

  function _setHelpHint(msg) {
    const el = document.querySelector('.view-help');
    if (!el) return;
    if (msg) {
      if (!el.dataset.original) el.dataset.original = el.innerHTML;
      el.innerHTML = msg;
      el.style.color = '#f5a623';
    } else if (el.dataset.original) {
      el.innerHTML = el.dataset.original;
      el.style.color = '';
    }
  }
  function _styleModeBtn(btn, active) {
    if (!btn) return;
    btn.classList.toggle('primary', active);
    btn.style.background = active ? '#f5a623' : '';
    btn.style.color      = active ? '#000'     : '';
  }
  function _setRotateMode(mode) {
    if (mode !== 'none' && mode !== 'tile' && mode !== 'object') mode = 'none';
    if (_rotateMode === mode) return;
    /* Switching modes (or to 'none') — abort any in-progress aim
     * to avoid leaving an entity stuck in aim state across modes. */
    if (_aimEntityIdx >= 0) _exitAimMode(false);
    _rotateMode = mode;
    const btnTile = document.getElementById('btn-3d-rotate-tile');
    const btnObj  = document.getElementById('btn-3d-rotate-object');
    if (btnTile) btnTile.textContent = 'Rotate Tile: '   + (mode === 'tile'   ? 'ON' : 'OFF');
    if (btnObj)  btnObj.textContent  = 'Rotate Object: ' + (mode === 'object' ? 'ON' : 'OFF');
    _styleModeBtn(btnTile, mode === 'tile');
    _styleModeBtn(btnObj,  mode === 'object');
    if (renderer && renderer.domElement) {
      renderer.domElement.style.cursor = (mode !== 'none') ? 'crosshair' : '';
    }
    if (mode === 'tile') {
      _setHelpHint('ROTATE TILE — click cycles tile 90° (works through entities) · ESC to exit');
    } else if (mode === 'object') {
      _setHelpHint('ROTATE OBJECT — click entity = aim · ESC cancels aim · second ESC exits');
    } else {
      _setHelpHint(null);
    }
  }
  function _enterAimMode(idx) {
    const level = window.utenyaaState && window.utenyaaState.getLevel();
    if (!level || !level.entities[idx]) return;
    _aimEntityIdx   = idx;
    _aimOriginalDir = level.entities[idx].direction || 0;
    const visual = groupEntities.children[idx];
    if (visual) visual.scale.set(1.18, 1.18, 1.18);
    if (controls) controls.enabled = false;
    _setHelpHint('Aiming — move mouse to rotate · click to commit · ESC to cancel');
  }
  function _exitAimMode(commit) {
    if (_aimEntityIdx < 0) return;
    const level = window.utenyaaState && window.utenyaaState.getLevel();
    if (!commit && level && level.entities[_aimEntityIdx]) {
      level.entities[_aimEntityIdx].direction = _aimOriginalDir;
      const visual = groupEntities.children[_aimEntityIdx];
      if (visual) visual.rotation.z = (_aimOriginalDir || 0) / 65536;
    }
    const visual = groupEntities.children[_aimEntityIdx];
    if (visual) visual.scale.set(1, 1, 1);
    _aimEntityIdx = -1;
    if (controls) controls.enabled = true;
    if (_rotateMode === 'object') {
      _setHelpHint('ROTATE OBJECT — click entity = aim · ESC cancels aim · second ESC exits');
    } else if (_rotateMode === 'tile') {
      _setHelpHint('ROTATE TILE — click cycles tile 90° (works through entities) · ESC to exit');
    } else {
      _setHelpHint(null);
    }
    if (typeof window.refreshSidebar === 'function') window.refreshSidebar();
  }

  // Hook up the two Rotate Mode buttons. Clicking the active button
  // turns it OFF (back to 'none'). Clicking the other button switches
  // modes — _setRotateMode handles the mutual exclusion.
  const _rotateTileBtn = document.getElementById('btn-3d-rotate-tile');
  const _rotateObjBtn  = document.getElementById('btn-3d-rotate-object');
  if (_rotateTileBtn) {
    _rotateTileBtn.addEventListener('click', () =>
      _setRotateMode(_rotateMode === 'tile' ? 'none' : 'tile'));
  }
  if (_rotateObjBtn) {
    _rotateObjBtn.addEventListener('click', () =>
      _setRotateMode(_rotateMode === 'object' ? 'none' : 'object'));
  }

  /* UV combo cycle button removed in 0.8. Tile UV mapping is now a
   * direct port of PawCraft's Tile.Render() algorithm (canonical
   * reference for the .UTE format) — no longer operator-tunable
   * because there's no remaining ambiguity. See the rebuildTerrainMesh
   * UV section for the implementation. */

  renderer.domElement.addEventListener('mousedown', (ev) => {
    _picker.downX = ev.clientX;
    _picker.downY = ev.clientY;
    _picker.downBtn = ev.button;
  });
  renderer.domElement.addEventListener('mouseup', (ev) => {
    // ANY click while aiming commits the current direction; we stay
    // in Rotate Mode so the next click can rotate something else.
    if (_aimEntityIdx >= 0) {
      _exitAimMode(true);
      return;
    }
    const dx = Math.abs(ev.clientX - _picker.downX);
    const dy = Math.abs(ev.clientY - _picker.downY);
    if (dx + dy >= 8) return;             // drag → orbit, not edit
    if (ev.button !== _picker.downBtn) return;
    _setPointerFromEvent(ev);
    const t = _raycastTile();
    if (!t) return;
    const level = window.utenyaaState && window.utenyaaState.getLevel();
    if (_rotateMode === 'tile') {
      /* Rotate Tile mode — click ALWAYS rotates the tile under the
       * cursor 90°, even if an entity sits on top of it. The two-
       * button design replaces the older Shift+click bypass — the
       * mode is the bypass. Pass forceTile=true so rotateAtTile
       * skips its entity hit-test (which otherwise rotates the
       * entity instead of the tile underneath). */
      if (typeof window.rotateAtTile === 'function') {
        window.rotateAtTile(t.x, t.y, 90, /*forceTile=*/true);
      }
      return;
    }
    if (_rotateMode === 'object') {
      /* Rotate Object mode — click entity → enter aim mode. Click
       * on empty tile is a no-op (helpful hint kept on the help
       * span so the operator sees what's expected). */
      const entIdx = _entityAtTile(level, t.x, t.y);
      if (entIdx >= 0) {
        _enterAimMode(entIdx);
      }
      return;
    }
    if (ev.button === 0) {
      // Normal mode left-click: apply current toolbox tool.
      if (typeof window.applyToolAtTile === 'function') {
        window.applyToolAtTile(t.x, t.y);
        refreshFromLevel();
      }
    } else if (ev.button === 2) {
      // Normal mode right-click: still works as a convenient one-shot
      // rotate (90° tile, aim entity) — power-user shortcut without
      // toggling the persistent mode.
      const entIdx = _entityAtTile(level, t.x, t.y);
      if (entIdx >= 0) {
        _enterAimMode(entIdx);
      } else if (typeof window.rotateAtTile === 'function') {
        window.rotateAtTile(t.x, t.y, 90);
      }
    }
  });
  // Move-while-aiming → live update entity direction to face cursor.
  renderer.domElement.addEventListener('mousemove', (ev) => {
    if (_aimEntityIdx < 0) return;
    _setPointerFromEvent(ev);
    _picker.raycaster.setFromCamera(_picker.pointer, camera);
    const hits = _picker.raycaster.intersectObject(groupTerrain, true);
    if (!hits.length) return;
    const p = hits[0].point;
    const level = window.utenyaaState && window.utenyaaState.getLevel();
    if (!level) return;
    const e = level.entities[_aimEntityIdx];
    if (!e) return;
    const ex = (e.x + 0.5) * TILE_WORLD;
    const ey = (e.y + 0.5) * TILE_WORLD;
    const ang = Math.atan2(p.y - ey, p.x - ex);
    // Snap to 5° steps when Shift held — coarser snap to 22.5° otherwise
    // for a satisfying click-feel without typing exact numbers.
    const stepRad = ev.shiftKey ? (5 * Math.PI / 180) : (22.5 * Math.PI / 180);
    const snapped = Math.round(ang / stepRad) * stepRad;
    e.direction = Math.round(snapped * 65536) | 0;
    const visual = groupEntities.children[_aimEntityIdx];
    if (visual) visual.rotation.z = snapped;
  });
  // ESC: cancel in-progress aim FIRST; a second ESC exits whatever
  // rotate mode is active back to 'none'.
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (_aimEntityIdx >= 0) {
      ev.preventDefault();
      _exitAimMode(false);
    } else if (_rotateMode !== 'none') {
      ev.preventDefault();
      _setRotateMode('none');
    }
  });

  // Tool radio change → cancel any in-progress aim mode AND clear
  // any Rotate Mode so the user's next click reflects their just-
  // selected toolbox tool.
  document.querySelectorAll('input[name="tool"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (_aimEntityIdx >= 0)    _exitAimMode(false);
      if (_rotateMode !== 'none') _setRotateMode('none');
    });
  });

  // Suppress browser context menu over the 3D view so right-click
  // is available for our aim/rotate action.
  renderer.domElement.addEventListener('contextmenu', (ev) => ev.preventDefault());

  initialized = true;
}

function onResize() {
  if (!visible || !mountEl) return;
  const W = mountEl.clientWidth || 640;
  const H = mountEl.clientHeight || 640;
  renderer.setSize(W, H);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
}

function recenterCamera() {
  // Mirror the engine's screen-space orientation. The engine
  // (Player.hpp HandleMovement comments) renders world +X to screen
  // LEFT after its rotate_x(0.5) + translate(-10,-10,0) chain. With
  // a Three.js perspective camera and up=(0,0,1) (Z up), placing the
  // camera on the +Y side and looking back toward -Y makes the cross
  // product right = forward × up resolve to a (-X, 0, 0) screen-right
  // axis — i.e. world +X projects to screen LEFT, matching the engine.
  // Pitch ~30° down to keep the Utenyaa-style angle.
  const cx = MAP_DIM * TILE_WORLD / 2;
  camera.position.set(cx, cx * 2 + cx * 0.35, cx * 1.1);
  camera.up.set(0, 0, 1);
  camera.lookAt(cx, cx, 0);
}


// ---- tile-vertex height (matches PawCraft/engine) ---------------------

function tileVertexHeight(level, x, y) {
  const clamp = (v) => Math.max(0, Math.min(MAP_DIM - 1, v));
  let sum = 0, n = 0;
  for (let dx = -1; dx <= 0; dx++) {
    for (let dy = -1; dy <= 0; dy++) {
      const tile = level.tiles[clamp(x + dx) + clamp(y + dy) * MAP_DIM];
      sum += (tile.raw & 0x0F);
      n++;
    }
  }
  // Engine: tile depth values are integer steps; multiply by 1.0 for
  // 1:1 world-unit-per-depth-step scaling.
  return sum / n;
}


// ---- group disposal --------------------------------------------------

function disposeGroup(group) {
  while (group.children.length) {
    const obj = group.children.pop();
    obj.traverse?.(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose && m.dispose());
        else child.material.dispose && child.material.dispose();
      }
    });
  }
}


// ---- terrain rebuild --------------------------------------------------

function rebuildTerrain(level) {
  disposeGroup(groupTerrain);
  const showGouraud = document.getElementById('chk-show-gouraud').checked;

  // Bucket tiles by texture index — one mesh per texture so each can
  // bind a different texture map without atlasing.
  const buckets = new Map();
  for (let y = 0; y < MAP_DIM; y++) {
    for (let x = 0; x < MAP_DIM; x++) {
      const idx = x + y * MAP_DIM;
      const t = level.tiles[idx];
      const tex = t.texture & 0xFF;
      if (!buckets.has(tex)) buckets.set(tex, []);
      buckets.get(tex).push({ x, y, idx, tile: t });
    }
  }

  for (const [texIdx, tiles] of buckets) {
    const positions = [], uvs = [], colors = [], indices = [];
    let voff = 0;

    for (const { x, y, idx, tile } of tiles) {
      const z00 = tileVertexHeight(level, x,     y    );
      const z10 = tileVertexHeight(level, x + 1, y    );
      const z11 = tileVertexHeight(level, x + 1, y + 1);
      const z01 = tileVertexHeight(level, x,     y + 1);

      const wx = x * TILE_WORLD, wy = y * TILE_WORLD;
      const wxe = (x + 1) * TILE_WORLD, wye = (y + 1) * TILE_WORLD;
      // CCW from top: (0,0), (1,0), (1,1), (0,1)
      positions.push(wx, wy, z00,  wxe, wy, z10,  wxe, wye, z11,  wx, wye, z01);

      /* UV: direct port of PawCraft's Tile.Render() algorithm.
       * Reference: https://github.com/ReyeMe/PawCraft/blob/main/PawCraft/Rendering/Tile.cs
       *   - Base UV list (Tile.cs:21):     [(0,0),(0,1),(1,1),(1,0)]
       *   - Vertex order (Tile.cs:96-101): [TL, BL, BR, TR]  (CCW from TL)
       *   - Mirror (Tile.cs:163):          uvs.Reverse()  if MirrorTexture
       *   - Rotation (Tile.cs:165-168):    LEFT-SHIFT  uvs.Skip(1).Concat(uvs.Take(1))
       *
       * This editor pushes positions in a different order:
       *   (wx,wy), (wxe,wy), (wxe,wye), (wx,wye)
       *   = [TL, TR, BR, BL]  (CW from TL — opposite of PawCraft)
       *
       * To produce the SAME per-vertex UV assignment as PawCraft,
       * compute PawCraft's UVs in PawCraft's vertex order, then
       * remap to this editor's order:
       *   mine[i] = paw[PAW_INDEX_FOR_MY_VERTEX[i]]
       * where PAW_INDEX_FOR_MY_VERTEX maps:
       *   my TL (idx 0) → paw TL (idx 0)
       *   my TR (idx 1) → paw TR (idx 3)
       *   my BR (idx 2) → paw BR (idx 2)
       *   my BL (idx 3) → paw BL (idx 1)
       * = [0, 3, 2, 1]
       *
       * This was previously an operator-tunable two-knob system
       * (UV_BASE 0|1 × UV_ROT_DIR right|left); analysis confirmed
       * that combo A (base 1 + right-shift) was already mathematically
       * equivalent to PawCraft, but expressing the algorithm as a
       * direct port removes any doubt about correctness. The window.
       * UV_* knobs and the UV cycle button are removed. */
      /* HARDWARE-VERIFIED 0.8 (round 2): operator's empirical test
       * — turn Rotate Tile ON, click each of the 4 water-corner tiles
       * once, editor matches Saturn. Each click adds +1 to the stored
       * rotation, so the offset is ONE STEP (90°), not the 180° I
       * initially diagnosed. My earlier (1-u, 1-v) flip was a 180°
       * correction — overshot by 90°.
       *
       * Cleanest fix: PawCraft port verbatim, but ADD 1 to the
       * effective rotation count. Then editor[stored=R] computes the
       * UVs PawCraft (and Saturn) compute for stored=R, instead of
       * stored=R-1. Removes the suspicious post-process flip in
       * favor of a single off-by-one rotation correction.
       *
       * Why is the editor "1 ahead"? Most likely because three.js's
       * default flipY=true on textures combined with PawCraft's
       * OpenGL flipY=false convention manifests as a V-axis flip,
       * which on a square sprite combined with an even rotation
       * matches a 90° offset in rotation-space. Empirically rather
       * than analytically: `+1 mod 4` to rot puts editor in lockstep
       * with Saturn for every rotation 0..3. */
      /* DATA-DRIVEN derivation (round 14) using TILE_ROT_DBG dump
       * captured at 19:20:19 on Dansfield + screen-space axis sense.
       *
       * Saturn V[0..3] vertex assignment per stored rotation
       * (world-coord labels from the diagnostic):
       *   stored=0  V0=WBR V1=WBL V2=WTL V3=WTR
       *   stored=1  V0=WBL V1=WTL V2=WTR V3=WBR
       *   stored=2  V0=WTL V1=WTR V2=WBR V3=WBL
       *   stored=3  V0=WTR V1=WBR V2=WBL V3=WTL
       *
       * Map.hpp labels world (x+1, y=0) as "WTR" but world-y=0 is
       * the SOUTH edge of the rendered map (camera at viewpoint
       * 0,20,120 looking at target 0,30,0 with map rotated 0.5 rad
       * around X). World y=0 projects to the BOTTOM of the screen,
       * so the world→screen mapping is:
       *   WTR (x+1, y=0) → screen-BR    WBR (x+1, y=1) → screen-TR
       *   WTL (x,   y=0) → screen-BL    WBL (x,   y=1) → screen-TL
       *
       * SGL Dual_Plane assigns texel UVs (0,0)/(1,0)/(1,1)/(0,1) to
       * V[0..3]; sprHVflip mirrors both axes, so the texel-TL pixel
       * actually rendered at V[k] is the one at the OPPOSITE V slot
       * — i.e. texel TL appears at V[2]. Mapping V[2]'s screen
       * corner per stored:
       *   stored=0  V[2]=WTL → screen-BL → 90° CCW visible
       *   stored=1  V[2]=WTR → screen-BR → 180° visible
       *   stored=2  V[2]=WBR → screen-TR → 90° CW  visible
       *   stored=3  V[2]=WBL → screen-TL → 0°      visible
       *
       * PawCraft left-shift count K → editor texel-TL position
       * (computed via PAW_IDX_FOR_MY[0,3,2,1]):
       *   K=0  TL → 0°       K=1  TR → 90° CW
       *   K=2  BR → 180°     K=3  BL → 90° CCW
       *
       * To make editor stored=N display the same rotation Saturn
       * stored=N displays, we need K(N):
       *   stored=0 → K=3        stored=1 → K=2
       *   stored=2 → K=1        stored=3 → K=0
       *
       * That's K = 3 - N, NOT a constant offset. The previous +3
       * empirically "matched shiro" because shiro's rotated tiles
       * happened to be on textures (0, 6, 19) where the partial
       * +3 match (correct only at stored=0 and 2) was visually
       * indistinguishable for stored=1 and 3 due to texture
       * symmetry. Dansfield's directional textures (1, 2, 3, 12,
       * 16) exposed the half-match.
       *
       * The negation formula matches all 4 stored values for both
       * maps — verifiable on first run. */
      const rot = (3 - ((tile.raw >> 6) & 3)) & 3;
      const mir = (tile.raw & 0x10) !== 0;
      let paw = [[0,0], [0,1], [1,1], [1,0]];
      if (mir) paw = paw.slice().reverse();
      for (let r = 0; r < rot; r++) {
        paw = paw.slice(1).concat(paw.slice(0, 1));  // left-shift, per PawCraft
      }
      const PAW_IDX_FOR_MY = [0, 3, 2, 1];
      for (let i = 0; i < 4; i++) {
        const [u, v] = paw[PAW_IDX_FOR_MY[i]];
        uvs.push(u, v);
      }

      // Per-corner gouraud color from .UTE
      let g = level.gourad[idx] || [0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF];
      if (!showGouraud) g = [0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF];
      for (const argb of g) {
        const c = gouraudToColor(argb);
        colors.push(c.r, c.g, c.b);
      }

      indices.push(voff, voff + 1, voff + 2,  voff, voff + 2, voff + 3);
      voff += 4;
    }

    if (!positions.length) continue;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
    geom.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
    geom.setIndex(indices);

    // CRITICAL: MeshBasicMaterial ignores scene lighting. Engine
    // fidelity: terrain uses pre-baked gouraud lighting only — the
    // .UTE Gouraud table has the lighting calc ALREADY in it.
    const mat = new THREE.MeshBasicMaterial({
      map: getTileTexture(texIdx),
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    groupTerrain.add(new THREE.Mesh(geom, mat));
  }

  rebuildGrid(level);
}

function rebuildGrid(level) {
  disposeGroup(groupGrid);
  const lineMat = new THREE.LineBasicMaterial({
    color: 0x2a3a55, transparent: true, opacity: 0.5 });
  const positions = [];
  for (let i = 0; i <= MAP_DIM; i++) {
    for (let j = 0; j < MAP_DIM; j++) {
      const z1 = tileVertexHeight(level, i, j);
      const z2 = tileVertexHeight(level, i, j + 1);
      positions.push(
        i * TILE_WORLD,        j * TILE_WORLD, z1 + 0.05,
        i * TILE_WORLD, (j + 1) * TILE_WORLD,  z2 + 0.05);
      positions.push(
              j * TILE_WORLD, i * TILE_WORLD, z1 + 0.05,
        (j + 1) * TILE_WORLD, i * TILE_WORLD, z2 + 0.05);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  groupGrid.add(new THREE.LineSegments(geom, lineMat));
}


// ---- NYA model → Three.js group --------------------------------------

function buildModelGroup(modelData) {
  const group = new THREE.Group();
  if (!modelData) return group;

  for (const mesh of modelData.meshes) {
    // Group polygons by material so we draw fewer draw-calls.
    // Material identity = (texture id OR base color) + flags.
    const buckets = new Map();
    mesh.polygons.forEach((poly, i) => {
      const ff = mesh.face_flags[i];
      const key = `${ff.has_texture ? 't' + ff.texture_id : 'c' + ff.base_color}_${ff.is_half_trans ? 'h' : 'o'}_${ff.is_double_sided ? 'd' : 's'}`;
      if (!buckets.has(key)) buckets.set(key, { ff, polys: [] });
      buckets.get(key).polys.push(poly);
    });

    for (const { ff, polys } of buckets.values()) {
      const positions = [], uvs = [], indices = [], colors = [];
      let voff = 0;

      for (const poly of polys) {
        const v = poly.vertices.map(i => mesh.points[i]);
        // Engine: `mesh.PointTable()[pointIndex] <<= 3` → multiply by 8.
        for (let k = 0; k < 4; k++) {
          positions.push(v[k][0] * 8, v[k][1] * 8, v[k][2] * 8);
        }
        // UV: Saturn uses sprNoflip on textured polys (Model.hpp:173).
        // Texture corners 0,1,2,3 map to polygon corners in order.
        uvs.push(0, 0,  1, 0,  1, 1,  0, 1);
        const c = gouraudToColor(ff.base_color);
        for (let k = 0; k < 4; k++) colors.push(c.r, c.g, c.b);
        indices.push(voff, voff + 1, voff + 2,  voff, voff + 2, voff + 3);
        voff += 4;
      }

      if (!positions.length) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geom.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
      if (!ff.has_texture) {
        geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      }
      geom.setIndex(indices);
      geom.computeVertexNormals();

      const matOpts = {
        side: ff.is_double_sided ? THREE.DoubleSide : THREE.FrontSide,
      };
      if (ff.has_texture && modelData.textures[ff.texture_id]) {
        matOpts.map = modelData.textures[ff.texture_id];
        // Saturn: textured face uses No_Palet (no color tint), so
        // we render texture as-is. Alpha bit drives transparency.
        matOpts.alphaTest = 0.5;
        matOpts.transparent = true;
      } else {
        matOpts.vertexColors = true;
      }
      if (ff.is_half_trans) {
        matOpts.transparent = true;
        matOpts.opacity = 0.5;
      }
      const mat = new THREE.MeshLambertMaterial(matOpts);
      group.add(new THREE.Mesh(geom, mat));
    }
  }

  return group;
}


// ---- entity rebuild --------------------------------------------------

async function rebuildEntities(level) {
  disposeGroup(groupEntities);

  for (const e of level.entities) {
    // Engine: entity world position = (TileX + 0.5) << 3 → centered
    // in the tile, scaled to world units (Map.hpp:402).
    const cx = (e.x + 0.5) * TILE_WORLD;
    const cy = (e.y + 0.5) * TILE_WORLD;
    const cz = tileVertexHeight(level, e.x, e.y) + 0.1;
    const dir = (e.direction || 0) / 65536;

    let visual;

    if (e.type === 'player_spawn' || e.type_id === 1) {
      // Player spawn renders as the actual PLAYER.NYA model (idx 1)
      const md = await loadModelOnce(1);
      if (md) {
        visual = buildModelGroup(md);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(2.5, 3.5, 32),
          new THREE.MeshBasicMaterial({ color: 0x2ecc71, side: THREE.DoubleSide,
                                         transparent: true, opacity: 0.6 }));
        ring.position.z = 0.05;   // ring lies flat on +Z plane already
        visual.add(ring);
      } else {
        visual = new THREE.Mesh(
          new THREE.ConeGeometry(2, 4, 16),
          new THREE.MeshLambertMaterial({ color: 0x2ecc71 }));
      }
    } else if (e.type === 'crate' || e.type_id === 3) {
      // Crate → CRATE.NYA (idx 0)
      const md = await loadModelOnce(0);
      if (md) {
        visual = buildModelGroup(md);
      } else {
        visual = new THREE.Mesh(
          new THREE.BoxGeometry(5, 5, 5),
          new THREE.MeshLambertMaterial({ color: 0xe94560 }));
      }
    } else if (e.type === 'model' || e.type_id === 2) {
      // Model entity → user-selected NYA at Reserved[1]
      const modelIdx = (e.reserved && e.reserved[1]) || 0;
      const md = await loadModelOnce(modelIdx);
      if (md) {
        visual = buildModelGroup(md);
      } else {
        visual = new THREE.Mesh(
          new THREE.BoxGeometry(4, 4, 4),
          new THREE.MeshLambertMaterial({ color: 0xf5a623 }));
      }
    } else {
      visual = new THREE.Mesh(
        new THREE.OctahedronGeometry(1.5),
        new THREE.MeshLambertMaterial({ color: 0x666666 }));
    }

    visual.position.set(cx, cy, cz);
    visual.rotation.z = dir;
    groupEntities.add(visual);
  }
}


// ---- public refresh --------------------------------------------------

async function refreshFromLevel() {
  const level = window.utenyaaState && window.utenyaaState.getLevel();
  if (!level) return;
  if (!initialized) init();
  if (!initialized) return;

  // Apply level light direction. Engine: slLight((-direction)). Three's
  // DirectionalLight points from .position toward the origin, so we
  // place it OPPOSITE the .UTE-stored direction vector.
  const d = level.light && level.light.direction;
  if (d) {
    const fx = d[0] / 65536, fy = d[1] / 65536, fz = d[2] / 65536;
    const len = Math.sqrt(fx*fx + fy*fy + fz*fz) || 1;
    dirLight.position.set(-fx/len * 100, -fy/len * 100, -fz/len * 100);
  }

  rebuildTerrain(level);
  await rebuildEntities(level);
}


// ---- animation loop --------------------------------------------------

function tick() {
  if (!visible) return;
  rafHandle = requestAnimationFrame(tick);
  controls.update();
  renderer.render(scene, camera);
}


// ---- exposed API -----------------------------------------------------

window.utenyaa3D = {
  show() {
    if (!initialized) init();
    if (!initialized) return;
    visible = true;
    onResize();
    refreshFromLevel();
    if (!rafHandle) tick();
  },
  hide() {
    visible = false;
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = 0; }
  },
  isVisible() { return visible; },
  refreshFromLevel,
};
