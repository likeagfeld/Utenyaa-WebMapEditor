/* Sprites tab — phase 1: read-only display of CHARS.PAK frames.
 *
 * The Saturn engine loads CHARS.PAK as 5 characters × 5 frames each =
 * 25 sprite indices (per main.cxx Player::FramesPerController and
 * the unet_glue_num_characters() shim). Each character row is 5
 * consecutive PAK indices; the frame within a row is selected by
 * Player::Draw based on facing angle (south / diagonal / north /
 * side / dead).
 *
 * Phase 1 (this file) loads /api/chars metadata, renders each frame
 * as an <img> in a 5×5 grid, and supports click-to-enlarge to a
 * canvas detail view. Phase 2 (TBD) will overlay a pixel-grid
 * editor on the detail canvas; Phase 3 will pipeline modified
 * sprites to Saturn over NetLink.
 */

(function () {
  'use strict';

  /* Sprite-frame role labels (matches Player::Draw rotation buckets). */
  const FRAME_LABELS = ['south', 'diagonal', 'north', 'side', 'dead'];

  /* Character names — placeholder labels until we wire up the real
   * roster. The file order in CHARS.PAK is the canonical character
   * index used by the engine and broadcast over UNET_CHARACTER_SELECT. */
  const CHAR_NAMES = ['Char 0', 'Char 1', 'Char 2', 'Char 3', 'Char 4'];

  let initialized = false;

  function $(sel) { return document.querySelector(sel); }

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
        cell.title = `index ${idx} • ${meta.width}×${meta.height} • ${FRAME_LABELS[f] || ('frame ' + f)}`;

        const img = document.createElement('img');
        img.src = `api/chars/${idx}.png`;
        img.alt = `char ${c} frame ${f}`;
        img.draggable = false;
        cell.appendChild(img);

        const cap = document.createElement('div');
        cap.className = 'sprites-cell-cap';
        cap.textContent = FRAME_LABELS[f] || ('f' + f);
        cell.appendChild(cap);

        cell.addEventListener('click', () => openDetail(idx, c, f, meta));
        row.appendChild(cell);
      }
      grid.appendChild(row);
    }
  }

  function openDetail(idx, charIdx, frameIdx, meta) {
    const detail = $('#sprites-detail');
    const label  = $('#sprites-detail-label');
    const canvas = $('#sprites-detail-canvas');
    if (!detail || !label || !canvas) return;
    label.textContent =
      `Index ${idx} — ${CHAR_NAMES[charIdx] || ('Char ' + charIdx)} `
      + `• ${FRAME_LABELS[frameIdx] || ('frame ' + frameIdx)} `
      + `• ${meta.width || '?'}×${meta.height || '?'}`;
    detail.style.display = '';

    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      /* Pixel-perfect upscale to fit canvas. The PNG endpoint serves
       * the actual sprite at native size; we draw it scaled with
       * imageSmoothingEnabled=false so each Saturn pixel becomes a
       * crisp block rather than a blurred upscale. */
      ctx.imageSmoothingEnabled = false;
      const W = canvas.width, H = canvas.height;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const sw = img.naturalWidth || 1, sh = img.naturalHeight || 1;
      const scale = Math.max(1, Math.floor(Math.min(W / sw, H / sh)));
      const dw = sw * scale, dh = sh * scale;
      const dx = ((W - dw) / 2) | 0, dy = ((H - dh) / 2) | 0;
      ctx.drawImage(img, dx, dy, dw, dh);
    };
    img.src = `api/chars/${idx}.png?t=${Date.now()}`;
  }

  function closeDetail() {
    const detail = $('#sprites-detail');
    if (detail) detail.style.display = 'none';
  }

  function init() {
    if (initialized) return;
    initialized = true;

    const refreshBtn = $('#btn-sprites-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', loadSprites);

    const closeBtn = $('#btn-sprites-close');
    if (closeBtn) closeBtn.addEventListener('click', closeDetail);

    /* Hook the Sprites tab — when activated, lazy-load the grid. */
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

    /* Re-show the 3D pane when 3D tab is clicked AFTER sprites was
     * shown. The existing tab logic in editor.js may not handle a
     * three-tab layout correctly because the 2D tab is hidden, so
     * we rebind here defensively. */
    document.querySelectorAll('.view-tab[data-view="3d"]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const pane = document.querySelector('.view-pane.view-sprites');
        if (pane) pane.style.display = 'none';
        closeDetail();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
