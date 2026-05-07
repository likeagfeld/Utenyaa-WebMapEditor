/* Sprites tab — Phase 2: pixel editor on top of Phase 1 grid display.
 *
 * Architecture:
 *   - Grid view (Phase 1): 5×5 thumbnails of CHARS.PAK frames.
 *   - Detail view: click a thumbnail to enter pixel-edit mode.
 *     The sprite is fetched as raw ARGB-1555 ints via
 *     /api/chars/<idx>/pixels and rendered into an editable canvas
 *     (16×16 logical pixels at PIXEL_SCALE on-screen).
 *
 * Tools (mouse on canvas):
 *   - Left-click + drag = paint with current color
 *   - Right-click + drag = erase (set transparent)
 *   - Shift + click      = eyedropper (pick color from clicked pixel)
 *
 * Color is stored client-side as ARGB-1555 u16 to match the on-disk
 * format exactly. The HTML5 color input gives us 8-bit RGB; we
 * quantize to 5-bit per channel before drawing/saving.
 *
 * Save POSTs the edited pixel array to /api/chars/<idx>/pixels.
 * Reset DELETEs the custom override so the original PAK pixels
 * come back.
 */

(function () {
  'use strict';

  const FRAME_LABELS = ['south', 'diagonal', 'north', 'side', 'dead'];
  const CHAR_NAMES   = ['Char 0', 'Char 1', 'Char 2', 'Char 3', 'Char 4'];
  const PIXEL_SCALE  = 16;   // 16x screen-pixels per sprite-pixel (16*16 = 256)
  const GRID_LINE_COLOR = 'rgba(255,255,255,0.12)';

  let initialized = false;

  /* Editor state for the currently-open frame. */
  let edit = null;
  /*  edit = {
   *    idx, charIdx, frameIdx,
   *    width, height, isCustom,
   *    pixels:    Uint16Array,  // ARGB-1555 BE, length = w*h
   *    selectedColor: int u16,  // current paint color
   *    dirty:     bool,
   *    drawing:   false | 'paint' | 'erase',
   *  }
   */

  function $(sel) { return document.querySelector(sel); }

  /* ---- Saturn ARGB-1555 helpers ---------------------------------- */

  function rgb888To1555(r, g, b, a) {
    const r5 = (r >> 3) & 0x1F;
    const g5 = (g >> 3) & 0x1F;
    const b5 = (b >> 3) & 0x1F;
    const av = a !== 0 ? 0x8000 : 0;
    /* ARGB-1555 packing per pak_format.py: low 5 = R, mid 5 = G,
     * high 5 = B, bit 15 = alpha. */
    return av | (b5 << 10) | (g5 << 5) | r5;
  }
  function argb1555ToRgba(p) {
    const a = (p & 0x8000) ? 255 : 0;
    const b5 = (p >> 10) & 0x1F;
    const g5 = (p >> 5)  & 0x1F;
    const r5 = p & 0x1F;
    return [
      (r5 << 3) | (r5 >> 2),
      (g5 << 3) | (g5 >> 2),
      (b5 << 3) | (b5 >> 2),
      a,
    ];
  }
  function argb1555ToHex(p) {
    /* Returns a #RRGGBB hex string for the HTML5 color input — we
     * intentionally drop the alpha bit since <input type=color>
     * doesn't carry one. */
    const [R, G, B] = argb1555ToRgba(p);
    return '#' + [R, G, B].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  function hexToArgb1555(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return 0xFFFF;
    const v = parseInt(m[1], 16);
    return rgb888To1555(
      (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF,
      alpha ? 1 : 0);
  }

  /* ---- Phase 1 grid (refreshed when grid view is active) --------- */

  async function loadSprites() {
    const grid = $('#sprites-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="muted" style="padding:8px">Loading…</div>';
    let info;
    try {
      const r = await fetch('api/chars');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      info = await r.json();
    } catch (e) {
      grid.innerHTML =
        '<div class="muted" style="padding:8px;color:#f55">Failed to load CHARS.PAK: '
        + (e.message || e) + '</div>';
      return;
    }

    const frames = info.frames_per_character || 5;
    const chars  = info.characters || 5;
    const customizedSet = new Set(info.customized || []);
    grid.innerHTML = '';
    grid.style.setProperty('--sprites-cols', String(frames));

    for (let c = 0; c < chars; c++) {
      const row = document.createElement('div');
      row.className = 'sprites-row';

      const label = document.createElement('div');
      label.className = 'sprites-row-label';
      label.textContent = CHAR_NAMES[c] || ('Char ' + c);
      row.appendChild(label);

      for (let f = 0; f < frames; f++) {
        const idx = c * frames + f;
        if (idx >= info.count) continue;
        const meta = info.textures[idx] || {};
        const cell = document.createElement('div');
        cell.className = 'sprites-cell';
        if (customizedSet.has(idx)) cell.classList.add('customized');
        cell.title = `index ${idx} • ${meta.width}×${meta.height} • ${FRAME_LABELS[f] || ('frame ' + f)}`
          + (customizedSet.has(idx) ? ' • CUSTOM' : '');

        const img = document.createElement('img');
        img.src = `api/chars/${idx}.png?t=${Date.now()}`;  // cache-bust
        img.alt = `char ${c} frame ${f}`;
        img.draggable = false;
        cell.appendChild(img);

        const cap = document.createElement('div');
        cap.className = 'sprites-cell-cap';
        cap.textContent = FRAME_LABELS[f] || ('f' + f);
        cell.appendChild(cap);

        cell.addEventListener('click', () => openEditor(idx, c, f, meta));
        row.appendChild(cell);
      }
      grid.appendChild(row);
    }
  }

  /* ---- Editor (Phase 2) ----------------------------------------- */

  async function openEditor(idx, charIdx, frameIdx, meta) {
    const detail = $('#sprites-detail');
    const label  = $('#sprites-detail-label');
    if (!detail || !label) return;
    detail.style.display = '';

    label.textContent =
      `Index ${idx} — ${CHAR_NAMES[charIdx] || ('Char ' + charIdx)} `
      + `• ${FRAME_LABELS[frameIdx] || ('frame ' + frameIdx)} • Loading…`;

    let pixData;
    try {
      const r = await fetch(`api/chars/${idx}/pixels`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      pixData = await r.json();
    } catch (e) {
      label.textContent = `Index ${idx} — failed to load: ${e.message || e}`;
      return;
    }

    edit = {
      idx, charIdx, frameIdx,
      width:  pixData.width,
      height: pixData.height,
      pixels: new Uint16Array(pixData.pixels),
      selectedColor: 0xFFFF,  // pure white opaque (Saturn 0xFFFF = R31 G31 B31 + alpha)
      isCustom: !!pixData.custom,
      dirty: false,
      drawing: false,
    };

    label.textContent =
      `Index ${idx} — ${CHAR_NAMES[charIdx] || ('Char ' + charIdx)} `
      + `• ${FRAME_LABELS[frameIdx] || ('frame ' + frameIdx)} `
      + `• ${edit.width}×${edit.height}`
      + (edit.isCustom ? ' • CUSTOM' : '');

    setupCanvas();
    setupColorPicker();
    setupSaveBar();
    redraw();
  }

  function setupCanvas() {
    const canvas = $('#sprites-detail-canvas');
    if (!canvas) return;
    canvas.width  = edit.width  * PIXEL_SCALE;
    canvas.height = edit.height * PIXEL_SCALE;
    canvas.style.width  = canvas.width  + 'px';
    canvas.style.height = canvas.height + 'px';

    /* Re-bind handlers (replace any prior bindings by cloning). */
    const fresh = canvas.cloneNode(false);
    canvas.parentNode.replaceChild(fresh, canvas);

    fresh.addEventListener('mousedown', onCanvasMouseDown);
    fresh.addEventListener('mousemove', onCanvasMouseMove);
    fresh.addEventListener('mouseup',   onCanvasMouseUp);
    fresh.addEventListener('mouseleave', onCanvasMouseUp);
    fresh.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  function pixelAtEvent(ev) {
    const canvas = $('#sprites-detail-canvas');
    const rect = canvas.getBoundingClientRect();
    const px = Math.floor((ev.clientX - rect.left) / PIXEL_SCALE);
    const py = Math.floor((ev.clientY - rect.top)  / PIXEL_SCALE);
    if (px < 0 || px >= edit.width || py < 0 || py >= edit.height) return null;
    return { x: px, y: py };
  }

  function onCanvasMouseDown(ev) {
    if (!edit) return;
    const p = pixelAtEvent(ev);
    if (!p) return;
    if (ev.shiftKey) {
      /* Eyedropper. */
      const v = edit.pixels[p.y * edit.width + p.x];
      edit.selectedColor = v;
      reflectSelectedColor();
      return;
    }
    edit.drawing = (ev.button === 2) ? 'erase' : 'paint';
    paintAt(p);
    ev.preventDefault();
  }
  function onCanvasMouseMove(ev) {
    if (!edit || !edit.drawing) return;
    const p = pixelAtEvent(ev);
    if (!p) return;
    paintAt(p);
  }
  function onCanvasMouseUp(ev) {
    if (edit) edit.drawing = false;
  }

  function paintAt(p) {
    const i = p.y * edit.width + p.x;
    const newVal = (edit.drawing === 'erase') ? 0x0000 : edit.selectedColor;
    if (edit.pixels[i] !== newVal) {
      edit.pixels[i] = newVal;
      edit.dirty = true;
      drawPixel(p.x, p.y);
      updateSaveBar();
    }
  }

  function drawPixel(x, y) {
    const canvas = $('#sprites-detail-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const v = edit.pixels[y * edit.width + x];
    const [R, G, B, A] = argb1555ToRgba(v);
    if (A === 0) {
      /* Transparent — show checkerboard. */
      const cx = x * PIXEL_SCALE, cy = y * PIXEL_SCALE;
      const half = PIXEL_SCALE >> 1;
      ctx.fillStyle = '#222';
      ctx.fillRect(cx, cy, PIXEL_SCALE, PIXEL_SCALE);
      ctx.fillStyle = '#333';
      ctx.fillRect(cx, cy, half, half);
      ctx.fillRect(cx + half, cy + half, half, half);
    } else {
      ctx.fillStyle = `rgb(${R},${G},${B})`;
      ctx.fillRect(x * PIXEL_SCALE, y * PIXEL_SCALE, PIXEL_SCALE, PIXEL_SCALE);
    }
    /* Faint grid line on top of each pixel. */
    ctx.strokeStyle = GRID_LINE_COLOR;
    ctx.lineWidth = 1;
    ctx.strokeRect(x * PIXEL_SCALE + 0.5, y * PIXEL_SCALE + 0.5,
                   PIXEL_SCALE - 1, PIXEL_SCALE - 1);
  }

  function redraw() {
    const canvas = $('#sprites-detail-canvas');
    if (!canvas || !edit) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < edit.height; y++) {
      for (let x = 0; x < edit.width; x++) {
        drawPixel(x, y);
      }
    }
  }

  /* ---- Color picker --------------------------------------------- */

  function setupColorPicker() {
    let bar = $('#sprites-tool-bar');
    if (!bar) return;
    bar.innerHTML = '';

    const colorLabel = document.createElement('label');
    colorLabel.textContent = 'Color';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.id = 'sprites-color';
    colorInput.value = argb1555ToHex(edit.selectedColor);
    colorInput.addEventListener('input', () => {
      edit.selectedColor = hexToArgb1555(colorInput.value, true);
      reflectSelectedColor();
    });
    colorLabel.appendChild(colorInput);
    bar.appendChild(colorLabel);

    const swatch = document.createElement('span');
    swatch.id = 'sprites-color-swatch';
    swatch.title = 'Currently selected paint color (Saturn-quantized)';
    bar.appendChild(swatch);

    const help = document.createElement('span');
    help.className = 'muted';
    help.style.marginLeft = '12px';
    help.innerHTML = 'Left-click = paint · Right-click = erase · '
      + '<b>Shift+click = eyedropper</b>';
    bar.appendChild(help);

    reflectSelectedColor();
  }

  function reflectSelectedColor() {
    const input  = $('#sprites-color');
    const swatch = $('#sprites-color-swatch');
    if (input)  input.value = argb1555ToHex(edit.selectedColor);
    if (swatch) {
      const [R, G, B, A] = argb1555ToRgba(edit.selectedColor);
      swatch.style.background =
        A === 0 ? 'transparent' : `rgb(${R},${G},${B})`;
      swatch.style.borderStyle = A === 0 ? 'dashed' : 'solid';
    }
  }

  /* ---- Save / Reset / Close bar --------------------------------- */

  function setupSaveBar() {
    let bar = $('#sprites-action-bar');
    if (!bar) return;
    bar.innerHTML = '';

    const saveBtn = document.createElement('button');
    saveBtn.id = 'btn-sprites-save';
    saveBtn.className = 'btn primary';
    saveBtn.textContent = 'Save';
    saveBtn.disabled = true;
    saveBtn.addEventListener('click', save);
    bar.appendChild(saveBtn);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn';
    resetBtn.textContent = 'Reset to original';
    resetBtn.disabled = !edit.isCustom;
    resetBtn.addEventListener('click', reset);
    bar.appendChild(resetBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closeEditor);
    bar.appendChild(closeBtn);

    const status = document.createElement('span');
    status.id = 'sprites-status';
    status.className = 'muted';
    bar.appendChild(status);
  }

  function updateSaveBar() {
    const saveBtn = $('#btn-sprites-save');
    const status  = $('#sprites-status');
    if (saveBtn) saveBtn.disabled = !edit || !edit.dirty;
    if (status)  status.textContent = (edit && edit.dirty) ? 'Unsaved changes' : '';
  }

  async function save() {
    if (!edit || !edit.dirty) return;
    const saveBtn = $('#btn-sprites-save');
    const status  = $('#sprites-status');
    if (saveBtn) saveBtn.disabled = true;
    if (status)  status.textContent = 'Saving…';
    try {
      const r = await fetch(`api/chars/${edit.idx}/pixels`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          width:  edit.width,
          height: edit.height,
          pixels: Array.from(edit.pixels),
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || ('HTTP ' + r.status));
      }
      edit.dirty = false;
      edit.isCustom = true;
      if (status) status.textContent = 'Saved.';
      updateSaveBar();
      /* Refresh thumbnail so the grid shows the change. */
      const cells = document.querySelectorAll('.sprites-cell img');
      cells.forEach((img) => {
        if (img.src.includes(`api/chars/${edit.idx}.png`)) {
          img.src = `api/chars/${edit.idx}.png?t=${Date.now()}`;
        }
      });
    } catch (e) {
      if (status) status.textContent = 'Save failed: ' + (e.message || e);
      updateSaveBar();
    }
  }

  async function reset() {
    if (!edit) return;
    if (!confirm('Discard custom edits for this frame and revert to the original CHARS.PAK pixels?')) return;
    const status = $('#sprites-status');
    try {
      const r = await fetch(`api/chars/${edit.idx}/reset`, { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      /* Reload editor with the original pixels. */
      const cur = { idx: edit.idx, c: edit.charIdx, f: edit.frameIdx };
      closeEditor();
      await openEditor(cur.idx, cur.c, cur.f, {});
      loadSprites();
    } catch (e) {
      if (status) status.textContent = 'Reset failed: ' + (e.message || e);
    }
  }

  function closeEditor() {
    edit = null;
    const detail = $('#sprites-detail');
    if (detail) detail.style.display = 'none';
  }

  /* ---- Tab plumbing --------------------------------------------- */

  function init() {
    if (initialized) return;
    initialized = true;

    document.querySelectorAll('.view-tab[data-view="sprites"]').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.view-pane').forEach(p => p.style.display = 'none');
        const pane = document.querySelector('.view-pane.view-sprites');
        if (pane) pane.style.display = '';
        if (window.utenyaa3D && window.utenyaa3D.hide) window.utenyaa3D.hide();
        loadSprites();
      });
    });
    document.querySelectorAll('.view-tab[data-view="3d"]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const pane = document.querySelector('.view-pane.view-sprites');
        if (pane) pane.style.display = 'none';
        closeEditor();
      });
    });

    const refreshBtn = $('#btn-sprites-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', loadSprites);

    const helpBtn = $('#btn-sprites-help');
    if (helpBtn) helpBtn.addEventListener('click', () => {
      const dlg = $('#sprites-help-dialog');
      if (dlg && typeof dlg.showModal === 'function') dlg.showModal();
    });

    const importInput = $('#sprites-import-file');
    if (importInput) importInput.addEventListener('change', async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      const ok = confirm(
        `Import "${file.name}" as the new sprite sheet?\n\n`
        + 'Each of the 25 cells will become a custom override. '
        + 'The ORIGINAL CHARS.PAK on disk is NOT modified — '
        + 'you can recover the originals at any time with '
        + '"Reset all to original" or per-frame "Reset to original".\n\n'
        + 'Continue?');
      if (!ok) {
        ev.target.value = '';
        return;
      }
      try {
        const r = await fetch('api/chars/import', {
          method:  'POST',
          headers: { 'Content-Type': 'image/png' },
          body:    file,
        });
        const result = await r.json().catch(() => ({}));
        if (!r.ok) {
          alert('Import failed: ' + (result.error || ('HTTP ' + r.status)));
          return;
        }
        alert('Imported ' + (result.count || 0) + ' frames from a '
          + (result.sheet || '?') + ' sheet (' + (result.scale || 1) + '× scale, '
          + 'cell ' + (result.cell || '?') + ').\n\n'
          + 'Original CHARS.PAK on disk is unchanged.');
        loadSprites();
      } catch (e) {
        alert('Import failed: ' + (e.message || e));
      } finally {
        ev.target.value = '';
      }
    });

    const resetAllBtn = $('#btn-sprites-reset-all');
    if (resetAllBtn) resetAllBtn.addEventListener('click', async () => {
      if (!confirm(
        'Delete ALL custom sprite overrides and restore every frame '
        + 'to its original CHARS.PAK pixels?\n\n'
        + 'This affects the editor only — the source CHARS.PAK on '
        + 'disk is not touched. The deletion is irreversible: any '
        + 'unsaved custom edits will be lost.')) return;
      try {
        const r = await fetch('api/chars/reset_all', { method: 'POST' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const result = await r.json();
        alert('Restored ' + (result.deleted || 0) + ' frame(s) to original.');
        closeEditor();
        loadSprites();
      } catch (e) {
        alert('Reset all failed: ' + (e.message || e));
      }
    });
  }

  /* =================================================================
   * Custom characters (Phase A) — full named character authoring
   * with name + creator metadata, parallel to map authoring. Saturn-
   * side download flow + lobby integration is Phase B/C/D.
   * ================================================================= */

  const CC_FRAMES = 5;     // matches engine FramesPerController
  const CC_W = 16, CC_H = 16;
  const CC_PIXEL_SCALE = 16;

  /* ccEdit state — separate from `edit` (which is the built-in PAK
   * frame editor). Mirrors the same shape so the pixel-paint code
   * paths stay one-to-one. */
  let ccEdit = null;
  /*  ccEdit = {
   *    slug, name, creator, isNew,
   *    frames: [Uint16Array(256), ...×5],   // ARGB-1555 per pixel
   *    selectedFrame: 0..4,
   *    selectedColor: u16,
   *    drawing: false | 'paint' | 'erase',
   *    dirty: bool,
   *  }
   */

  function ccSlugify(name) {
    let s = (name || '').toLowerCase().trim();
    s = s.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (s.length > 32) s = s.substring(0, 32);
    return s || 'char';
  }

  async function loadCustomCharsList() {
    const list = $('#custom-chars-list');
    if (!list) return;
    list.innerHTML = '<div class="muted" style="padding:8px">Loading…</div>';
    let info;
    try {
      const r = await fetch('api/custom_chars');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      info = await r.json();
    } catch (e) {
      list.innerHTML =
        '<div class="muted" style="padding:8px;color:#f55">Failed: '
        + (e.message || e) + '</div>';
      return;
    }
    list.innerHTML = '';
    const chars = info.characters || [];
    if (!chars.length) {
      list.innerHTML =
        '<div class="muted" style="padding:8px">'
        + 'No custom characters yet. Click <b>+ New custom character</b> '
        + 'to create one.</div>';
      return;
    }
    for (const c of chars) {
      const card = document.createElement('div');
      card.className = 'cc-card';
      const meta = document.createElement('div');
      meta.className = 'cc-card-meta';
      const nameEl = document.createElement('div');
      nameEl.className = 'cc-card-name';
      nameEl.textContent = c.name || c.slug;
      const creatorEl = document.createElement('div');
      creatorEl.className = 'cc-card-creator';
      creatorEl.textContent = c.creator
        ? `by ${c.creator}`
        : '(no creator credit)';
      const slugEl = document.createElement('div');
      slugEl.className = 'cc-card-slug';
      slugEl.textContent = c.slug;
      meta.appendChild(nameEl);
      meta.appendChild(creatorEl);
      meta.appendChild(slugEl);
      card.appendChild(meta);

      const strip = document.createElement('div');
      strip.className = 'cc-card-strip';
      for (let f = 0; f < CC_FRAMES; f++) {
        const img = document.createElement('img');
        img.src = `api/custom_chars/${c.slug}/frame/${f}.png?t=${Date.now()}`;
        img.draggable = false;
        strip.appendChild(img);
      }
      card.appendChild(strip);

      const actions = document.createElement('div');
      actions.className = 'cc-card-actions';
      const editBtn = document.createElement('button');
      editBtn.className = 'btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openCcEditor(c.slug));
      actions.appendChild(editBtn);
      card.appendChild(actions);
      list.appendChild(card);
    }
  }

  /* ---- Custom-character editor (per-frame pixel painting) -------- */

  function newCcEdit(slug, name, creator) {
    const frames = [];
    for (let f = 0; f < CC_FRAMES; f++) {
      frames.push(new Uint16Array(CC_W * CC_H));   // all 0 = transparent
    }
    return {
      slug, name: name || slug, creator: creator || '',
      isNew: true, frames,
      selectedFrame: 0,
      selectedColor: 0xFFFF,
      drawing: false,
      dirty: true,
    };
  }

  async function openCcEditor(slug) {
    if (!slug) {
      showCcEditor(false);
      return;
    }
    let data;
    try {
      const r = await fetch(`api/custom_chars/${encodeURIComponent(slug)}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
    } catch (e) {
      alert('Failed to load: ' + (e.message || e));
      return;
    }
    const frames = (data.frames || []).slice(0, CC_FRAMES).map(
      arr => new Uint16Array(arr));
    while (frames.length < CC_FRAMES) {
      frames.push(new Uint16Array(CC_W * CC_H));
    }
    ccEdit = {
      slug:    data.slug || slug,
      name:    data.name || slug,
      creator: data.creator || '',
      isNew:   false,
      frames,
      selectedFrame: 0,
      selectedColor: 0xFFFF,
      drawing: false,
      dirty: false,
    };
    showCcEditor(true);
    setupCcEditor();
  }

  function startCcNew() {
    const name = prompt('Character name (required):', '');
    if (!name || !name.trim()) return;
    const creator = prompt('Creator name (optional, shown alongside the character):', '') || '';
    const slug = ccSlugify(name);
    if (!slug) {
      alert('Could not produce a valid slug from that name. Try letters / numbers / hyphens.');
      return;
    }
    ccEdit = newCcEdit(slug, name.trim(), creator.trim());
    showCcEditor(true);
    setupCcEditor();
    /* Auto-save on first paint isn't ideal; keep the user in control.
     * The editor stays in dirty=true state until they hit Save. */
  }

  function showCcEditor(show) {
    const ed = $('#custom-chars-editor');
    if (ed) ed.style.display = show ? '' : 'none';
  }

  function setupCcEditor() {
    if (!ccEdit) return;
    const nameInput    = $('#cc-name');
    const creatorInput = $('#cc-creator');
    const slugDisplay  = $('#cc-slug-display');
    const dlBtn        = $('#btn-cc-download-png');
    if (nameInput)    nameInput.value    = ccEdit.name;
    if (creatorInput) creatorInput.value = ccEdit.creator;
    if (slugDisplay)  slugDisplay.textContent =
      `slug: ${ccEdit.slug}` + (ccEdit.isNew ? ' (new)' : '');
    if (dlBtn) {
      dlBtn.href = ccEdit.isNew
        ? 'api/custom_chars/template.png'
        : `api/custom_chars/${encodeURIComponent(ccEdit.slug)}/template.png`;
      dlBtn.download = `utenyaa-${ccEdit.slug}-template.png`;
    }

    /* Frame thumbnails (5 across, click to select). */
    const thumbs = $('#cc-frame-thumbs');
    if (thumbs) {
      thumbs.innerHTML = '';
      for (let f = 0; f < CC_FRAMES; f++) {
        const t = document.createElement('div');
        t.className = 'cc-thumb';
        if (f === ccEdit.selectedFrame) t.classList.add('selected');
        const cv = document.createElement('canvas');
        cv.width = CC_W * 4; cv.height = CC_H * 4;   // 4× scale
        renderFrameToCanvas(cv, ccEdit.frames[f], CC_W, CC_H);
        t.appendChild(cv);
        const cap = document.createElement('div');
        cap.className = 'cc-thumb-cap';
        cap.textContent = FRAME_LABELS[f] || ('f' + f);
        t.appendChild(cap);
        t.addEventListener('click', () => {
          ccEdit.selectedFrame = f;
          setupCcEditor();
        });
        thumbs.appendChild(t);
      }
    }

    /* Bind canvas events fresh each time. */
    const canvas = $('#cc-edit-canvas');
    if (canvas) {
      canvas.width  = CC_W * CC_PIXEL_SCALE;
      canvas.height = CC_H * CC_PIXEL_SCALE;
      const fresh = canvas.cloneNode(false);
      canvas.parentNode.replaceChild(fresh, canvas);
      fresh.addEventListener('mousedown',  ccCanvasDown);
      fresh.addEventListener('mousemove',  ccCanvasMove);
      fresh.addEventListener('mouseup',    ccCanvasUp);
      fresh.addEventListener('mouseleave', ccCanvasUp);
      fresh.addEventListener('contextmenu', (ev) => ev.preventDefault());
      ccRedraw();
    }

    /* Tool bar (color picker) */
    const bar = $('#cc-tool-bar');
    if (bar) {
      bar.innerHTML = '';
      const lbl = document.createElement('label');
      lbl.textContent = 'Color';
      const ci = document.createElement('input');
      ci.type = 'color';
      ci.value = argb1555ToHex(ccEdit.selectedColor);
      ci.addEventListener('input', () => {
        ccEdit.selectedColor = hexToArgb1555(ci.value, true);
        const sw = $('#cc-color-swatch');
        if (sw) {
          const [R, G, B] = argb1555ToRgba(ccEdit.selectedColor);
          sw.style.background = `rgb(${R},${G},${B})`;
        }
      });
      lbl.appendChild(ci);
      bar.appendChild(lbl);
      const sw = document.createElement('span');
      sw.id = 'cc-color-swatch';
      const [R, G, B] = argb1555ToRgba(ccEdit.selectedColor);
      sw.style.background = `rgb(${R},${G},${B})`;
      sw.style.cssText += 'display:inline-block;width:22px;height:22px;border:1px solid #2a3a55;border-radius:3px;margin-left:4px';
      bar.appendChild(sw);
      const help = document.createElement('span');
      help.className = 'muted';
      help.style.marginLeft = '12px';
      help.innerHTML = 'Left = paint · Right = erase · <b>Shift</b> = eyedrop';
      bar.appendChild(help);
    }
  }

  function renderFrameToCanvas(canvas, pixelsU16, w, h) {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const sx = canvas.width / w;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = pixelsU16[y * w + x];
        const [R, G, B, A] = argb1555ToRgba(v);
        if (A === 0) {
          ctx.fillStyle = (x + y) & 1 ? '#222' : '#333';
        } else {
          ctx.fillStyle = `rgb(${R},${G},${B})`;
        }
        ctx.fillRect(x * sx, y * sx, sx, sx);
      }
    }
  }

  function ccPixelAtEvent(ev) {
    const canvas = $('#cc-edit-canvas');
    const rect = canvas.getBoundingClientRect();
    const px = Math.floor((ev.clientX - rect.left) / CC_PIXEL_SCALE);
    const py = Math.floor((ev.clientY - rect.top)  / CC_PIXEL_SCALE);
    if (px < 0 || px >= CC_W || py < 0 || py >= CC_H) return null;
    return { x: px, y: py };
  }
  function ccCanvasDown(ev) {
    if (!ccEdit) return;
    const p = ccPixelAtEvent(ev);
    if (!p) return;
    if (ev.shiftKey) {
      const v = ccEdit.frames[ccEdit.selectedFrame][p.y * CC_W + p.x];
      ccEdit.selectedColor = v || 0xFFFF;
      setupCcEditor();
      return;
    }
    ccEdit.drawing = (ev.button === 2) ? 'erase' : 'paint';
    ccPaintAt(p);
    ev.preventDefault();
  }
  function ccCanvasMove(ev) {
    if (!ccEdit || !ccEdit.drawing) return;
    const p = ccPixelAtEvent(ev);
    if (!p) return;
    ccPaintAt(p);
  }
  function ccCanvasUp() {
    if (ccEdit) ccEdit.drawing = false;
  }
  function ccPaintAt(p) {
    const fr = ccEdit.frames[ccEdit.selectedFrame];
    const i = p.y * CC_W + p.x;
    const newVal = (ccEdit.drawing === 'erase') ? 0x0000 : ccEdit.selectedColor;
    if (fr[i] !== newVal) {
      fr[i] = newVal;
      ccEdit.dirty = true;
      ccDrawPixel(p.x, p.y);
      const stat = $('#cc-status');
      if (stat) stat.textContent = 'Unsaved changes';
    }
  }
  function ccDrawPixel(x, y) {
    const canvas = $('#cc-edit-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const v = ccEdit.frames[ccEdit.selectedFrame][y * CC_W + x];
    const [R, G, B, A] = argb1555ToRgba(v);
    if (A === 0) {
      const cx = x * CC_PIXEL_SCALE, cy = y * CC_PIXEL_SCALE;
      const half = CC_PIXEL_SCALE >> 1;
      ctx.fillStyle = '#222';
      ctx.fillRect(cx, cy, CC_PIXEL_SCALE, CC_PIXEL_SCALE);
      ctx.fillStyle = '#333';
      ctx.fillRect(cx, cy, half, half);
      ctx.fillRect(cx + half, cy + half, half, half);
    } else {
      ctx.fillStyle = `rgb(${R},${G},${B})`;
      ctx.fillRect(x * CC_PIXEL_SCALE, y * CC_PIXEL_SCALE,
                   CC_PIXEL_SCALE, CC_PIXEL_SCALE);
    }
    ctx.strokeStyle = GRID_LINE_COLOR;
    ctx.strokeRect(x * CC_PIXEL_SCALE + 0.5, y * CC_PIXEL_SCALE + 0.5,
                   CC_PIXEL_SCALE - 1, CC_PIXEL_SCALE - 1);
  }
  function ccRedraw() {
    const canvas = $('#cc-edit-canvas');
    if (!canvas || !ccEdit) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < CC_H; y++)
      for (let x = 0; x < CC_W; x++) ccDrawPixel(x, y);
  }

  async function saveCcEdit() {
    if (!ccEdit) return;
    const nameInput    = $('#cc-name');
    const creatorInput = $('#cc-creator');
    const stat = $('#cc-status');
    const newName    = (nameInput && nameInput.value.trim()) || ccEdit.name;
    const newCreator = (creatorInput && creatorInput.value.trim()) || '';
    if (!newName) {
      alert('Name required.');
      return;
    }
    /* Slug stays stable after creation so URLs / saves don't drift. */
    const payload = {
      name: newName,
      creator: newCreator,
      frames: ccEdit.frames.map(fr => Array.from(fr)),
    };
    if (stat) stat.textContent = 'Saving…';
    try {
      const r = await fetch(
        `api/custom_chars/${encodeURIComponent(ccEdit.slug)}`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(payload),
        });
      const result = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(result.error || ('HTTP ' + r.status));
      ccEdit.name = newName;
      ccEdit.creator = newCreator;
      ccEdit.isNew = false;
      ccEdit.dirty = false;
      if (stat) stat.textContent = 'Saved.';
      loadCustomCharsList();
      setupCcEditor();
    } catch (e) {
      if (stat) stat.textContent = 'Save failed: ' + (e.message || e);
    }
  }

  async function deleteCcEdit() {
    if (!ccEdit) return;
    if (ccEdit.isNew) {
      if (!confirm('Discard this new character without saving?')) return;
      ccEdit = null;
      showCcEditor(false);
      return;
    }
    if (!confirm(`Delete "${ccEdit.name}" (slug ${ccEdit.slug}) permanently?`)) return;
    try {
      const r = await fetch(
        `api/custom_chars/${encodeURIComponent(ccEdit.slug)}`,
        { method: 'DELETE' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || ('HTTP ' + r.status));
      }
      ccEdit = null;
      showCcEditor(false);
      loadCustomCharsList();
    } catch (e) {
      alert('Delete failed: ' + (e.message || e));
    }
  }

  async function uploadCcPng(file) {
    if (!ccEdit) return;
    if (ccEdit.isNew) {
      alert('Save the new character first (so it has a slug), then upload to overwrite its frames.');
      return;
    }
    const stat = $('#cc-status');
    if (stat) stat.textContent = 'Uploading…';
    try {
      const url = `api/custom_chars/${encodeURIComponent(ccEdit.slug)}/import`;
      const r = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'image/png' },
        body:    file,
      });
      const result = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(result.error || ('HTTP ' + r.status));
      /* Re-fetch the now-updated character so the editor + thumbs reflect. */
      await openCcEditor(ccEdit.slug);
      if (stat) stat.textContent = `Imported (${result.imported_from || '?'}, ${result.scale || 1}× scale).`;
      loadCustomCharsList();
    } catch (e) {
      if (stat) stat.textContent = 'Upload failed: ' + (e.message || e);
    }
  }

  function initCustomChars() {
    const newBtn = $('#btn-cc-new');
    if (newBtn) newBtn.addEventListener('click', startCcNew);
    const refresh = $('#btn-cc-refresh');
    if (refresh) refresh.addEventListener('click', loadCustomCharsList);
    const closeBtn = $('#btn-cc-close');
    if (closeBtn) closeBtn.addEventListener('click', () => {
      if (ccEdit && ccEdit.dirty
          && !confirm('Close without saving? Unsaved edits will be lost.')) return;
      ccEdit = null;
      showCcEditor(false);
    });
    const saveBtn = $('#btn-cc-save');
    if (saveBtn) saveBtn.addEventListener('click', saveCcEdit);
    const delBtn = $('#btn-cc-delete');
    if (delBtn) delBtn.addEventListener('click', deleteCcEdit);
    const uploadInput = $('#cc-upload-png');
    if (uploadInput) uploadInput.addEventListener('change', (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (file) uploadCcPng(file);
      ev.target.value = '';
    });
  }

  /* Hook into the existing init() so Custom Characters loads when
   * the Sprites tab is opened (alongside the built-in grid). */
  const origLoadSprites = loadSprites;
  loadSprites = async function () {
    await origLoadSprites();
    loadCustomCharsList();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); initCustomChars(); });
  } else {
    init();
    initCustomChars();
  }
})();
