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

  // ----- "Pick up + aim" rotation mode (intuitive entity rotation) -----
  // Click an entity to grab it; mouse movement re-aims it to face the
  // cursor (live preview); next click commits, ESC reverts. The
  // visual scales up slightly to confirm "you have it". OrbitControls
  // is disabled while aiming so a drag doesn't both orbit AND rotate.
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
  function _enterAimMode(idx) {
    const level = window.utenyaaState && window.utenyaaState.getLevel();
    if (!level || !level.entities[idx]) return;
    _aimEntityIdx   = idx;
    _aimOriginalDir = level.entities[idx].direction || 0;
    const visual = groupEntities.children[idx];
    if (visual) visual.scale.set(1.18, 1.18, 1.18);
    if (controls) controls.enabled = false;
    _setHelpHint('Aiming entity — move mouse to rotate · click to commit · ESC to cancel');
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
    _setHelpHint(null);
    if (typeof window.refreshSidebar === 'function') window.refreshSidebar();
  }

  renderer.domElement.addEventListener('mousedown', (ev) => {
    _picker.downX = ev.clientX;
    _picker.downY = ev.clientY;
    _picker.downBtn = ev.button;
  });
  renderer.domElement.addEventListener('mouseup', (ev) => {
    // ANY click while aiming commits the current direction.
    if (_aimEntityIdx >= 0) {
      _exitAimMode(true);
      return;
    }
    const dx = Math.abs(ev.clientX - _picker.downX);
    const dy = Math.abs(ev.clientY - _picker.downY);
    if (dx + dy >= 5) return;             // drag → orbit, not edit
    if (ev.button !== _picker.downBtn) return;
    _setPointerFromEvent(ev);
    const t = _raycastTile();
    if (!t) return;
    const level = window.utenyaaState && window.utenyaaState.getLevel();
    if (ev.button === 0) {
      // Left click on an existing entity → enter aim mode (rotate).
      // Left click on empty tile → apply current toolbox tool.
      const entIdx = _entityAtTile(level, t.x, t.y);
      const tool = (document.querySelector('input[name="tool"]:checked') || {}).value;
      if (entIdx >= 0 && tool !== 'erase-entity') {
        _enterAimMode(entIdx);
      } else if (typeof window.applyToolAtTile === 'function') {
        window.applyToolAtTile(t.x, t.y);
        refreshFromLevel();
      }
    } else if (ev.button === 2) {
      // Right click — quick 90° tile rotation OR enter aim mode for an
      // entity (same gesture as left-click on entity, but works even
      // when the toolbox is on an erase tool).
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
    // direction is fxp 16.16 raw of radians (1.0 rad == 65536 raw)
    e.direction = Math.round(snapped * 65536) | 0;
    const visual = groupEntities.children[_aimEntityIdx];
    if (visual) visual.rotation.z = snapped;
  });
  // ESC reverts an in-progress aim.
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && _aimEntityIdx >= 0) {
      ev.preventDefault();
      _exitAimMode(false);
    }
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

      // UV: rotation+mirror per DepthAndRotationAndMirror byte.
      // Engine (Map.hpp) uses `baseIndex = 3 - rotation` to permute
      // the polygon's slot[0..3] vertex assignment; SGL then maps
      // texture corners (0,0),(1,0),(1,1),(0,1) to slots 0..3 in
      // order. Working out the math at rot=0 gives:
      //   slot 0 = SE   →  texture (0,0)
      //   slot 1 = SW   →  texture (1,0)
      //   slot 2 = NW   →  texture (1,1)
      //   slot 3 = NE   →  texture (0,1)
      // Editor positions are pushed in NW,NE,SE,SW order, so to
      // match Saturn output at rot=0 the base UV in that vertex
      // order is [(1,1),(0,1),(0,0),(1,0)]. The previous
      // [(0,0),(1,0),(1,1),(0,1)] base produced 180°-rotated
      // textures vs the engine — symptom: corner-textured roads
      // looked clean in editor but had chevron/arrow artifacts
      // in-game. Each rotation step right-shifts the UV array,
      // which matches the engine's baseIndex decrement.
      const rot = (tile.raw >> 6) & 3;
      const mir = (tile.raw & 0x10) !== 0;
      let uv = [[1,1], [0,1], [0,0], [1,0]];
      for (let r = 0; r < rot; r++) uv = [uv[3], uv[0], uv[1], uv[2]];
      if (mir) uv = uv.map(([u, v]) => [1 - u, v]);
      for (const [u, v] of uv) uvs.push(u, v);

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
