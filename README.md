# Utenyaa Web Map Editor

Standalone browser-based map editor that produces `.UTE` map files
**byte-identical** to those emitted by [ReyeMe's PawCraft](https://github.com/ReyeMe/PawCraft).

The Saturn Utenyaa engine reads the same `.UTE` format, so any map
authored here will load and play in Utenyaa-Netlink (or upstream
Utenyaa) with no further conversion.

This is intentionally **disconnected** from the live Saturn server —
its only output is `.UTE` files in `webapp/maps/` plus a JSON sidecar
preserving the editor state. A future integration can ingest those
files; nothing in this repo touches the game server.

## What it does

- 20×20 tile grid editor in the browser (HTML5 canvas)
- Tile painting with texture index, depth, rotation
- Place/erase entities: Player Spawn, Model, Crate
- Crate flag editor (Health / Bomb / Mine bitmask, matches the engine)
- Live validation against engine-side rules (≥2 player spawns, in-range
  coordinates, sane crate flags, etc.)
- Save → produces both a JSON sidecar (re-editable later) and a
  matching `.UTE` binary on disk
- Load any saved map and continue editing
- Download the `.UTE` directly from the browser

## Why we know it actually works on the first try

`webapp/tests/test_format.py` round-trips all four production stages
(`ISLAND.UTE`, `CROSS.UTE`, `VALLEY.UTE`, `RAILWAY.UTE`) through the
parser → serializer pipeline and asserts the output is **byte-identical**
to PawCraft's. If any byte position were wrong (field order, endianness,
bit packing in `TileData.DepthAndRotationAndMirror`, the `FieldOrder(3)`
tie between `Direction` and `Reserved` in `EntityData`), one of those
tests would fail. All 10 pass. Plus an end-to-end Flask smoke test (`webapp/tests/smoke_app.py`)
covers the full HTTP API: health/format-info/slugify, list/save/load/delete,
static asset serving, `.UTE` download (verifies first 4 bytes = `UTE\0` and
exact length), validator-rejected-saves return 400, and path-traversal slugs
are rejected. All pass.

```
$ python -m unittest discover -s webapp/tests -v
test_entity_record_size .................... ok
test_fixed_prefix_size ..................... ok
test_identifier_bytes ...................... ok
test_all_references_round_trip ............. ok    [ISLAND/CROSS/VALLEY/RAILWAY]
test_entity_counts ......................... ok    [23/47/26/26 entities]
test_empty_map_round_trip .................. ok
test_empty_map_size ........................ ok
test_signed_int_wrapping ................... ok
test_single_entity_map_size ................ ok
test_tile_bit_packing ...................... ok

----------------------------------------------------------------------
Ran 10 tests in 0.043s

OK
```

## Run on Windows

Requires Python 3.10+. From the repo root:

```
run.bat
```

The first run creates a `.venv\` and installs Flask. Then opens at
`http://127.0.0.1:5000/`.

## Run on Linux

Requires Python 3.10+ with venv support. On Debian/Ubuntu:

```
sudo apt install python3-venv python3-pip
chmod +x run.sh
./run.sh
```

If you'd rather skip the venv (system-wide install or already in one):

```
pip3 install --user flask
python3 webapp/app.py
```

## Configuration

Environment variables (optional):

| Var | Default | Effect |
|---|---|---|
| `UTENYAA_EDITOR_HOST` | `127.0.0.1` | bind address (set to `0.0.0.0` for LAN) |
| `UTENYAA_EDITOR_PORT` | `5000` | port |
| `UTENYAA_MAPS_DIR`    | `webapp/maps` | where saved maps live |
| `FLASK_DEBUG`         | `0` | `1` = enable Flask debug + auto-reload |

## File layout

```
Utenyaa-WebMapEditor/
├── PawCraft_upstream/        # cloned reference (do not edit)
├── reference_maps/           # 4 production .UTE files for tests
├── webapp/
│   ├── app.py                # Flask app + REST endpoints
│   ├── ute_format.py         # binary serializer/parser
│   ├── validator.py          # editor-side validation rules
│   ├── storage.py            # JSON + .UTE filesystem store
│   ├── static/               # frontend HTML/CSS/JS
│   ├── tests/test_format.py  # round-trip correctness proof
│   └── maps/                 # saved maps land here at runtime
├── requirements.txt
├── run.bat / run.sh          # cross-platform launchers
└── README.md
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET    | `/` | editor UI |
| GET    | `/api/health` | liveness |
| GET    | `/api/maps` | list saved maps |
| GET    | `/api/maps/<slug>` | load JSON |
| POST   | `/api/maps/<slug>` | save (body = full editor JSON state) |
| DELETE | `/api/maps/<slug>` | remove |
| GET    | `/api/maps/<slug>/ute` | download the binary `.UTE` |
| POST   | `/api/validate` | dry-run validator on a JSON body |
| GET    | `/api/slugify?name=…` | normalize a map name to a slug |
| GET    | `/api/format-info` | dump format constants for editor sanity |

## Format reference (for future integration)

Multi-byte fields are **big-endian** (PawCraft's `CustomMarshal` reverses
its `Marshal.SizeOf`-derived bytes; the engine reads big-endian on SH-2).

```
LevelData (9624 bytes fixed prefix + 28 bytes per entity)

  off  size  field
  0    4     Identifier  ['U','T','E', 0]
  4    1600  TileData[400]   (4 bytes each)
  1604 16    LevelLight       (FxVector + u16 color + i16 reserved)
  1620 3200  Gourad[400]      (4 × u16 ARGB-1555 each)
  4820 4800  Normals[400]     (FxVector each)
  9620 4     EntityCount (i32 BE)
  9624 N×28  Entities[N]

EntityData record (28 bytes)

  off  size  field
  0    4     Type         (i32 BE)  0=Empty 1=PlayerSpawn 2=Model 3=Crate
  4    2     X            (u16 BE)  tile coord 0..19
  6    2     Y            (u16 BE)  tile coord 0..19
  8    4     Direction    (i32 BE)  fxp 16.16 radians
  12   16    Reserved[16]           [0]=crate flags, [1]=model id

TileData record (4 bytes)

  off  size  field
  0    1     DepthAndRotationAndMirror
                 bits 0..3  Depth (4 bits, 0..15 effective)
                 bit  4     MirrorTexture
                 bits 6..7  RotateTexture (0..3 = 0/90/180/270)
  1    1     TextureIndex (u8)
  2    2     Dummy (u16 BE)
```

## Not yet wired

- No Saturn server integration. Output `.UTE` files live in `webapp/maps/`
  on whichever host runs the editor. When ready to integrate, the server
  fleet can pick them up via the same path.
- No texture preview from `TERRAIN.PAK`. Tile colors in the canvas are
  arbitrary palette swatches — they hint at what the texture index will
  *look like* on Saturn but don't match exactly. The texture index byte
  is what matters.
- No 3D preview. PawCraft has one (SharpGL); we don't, but the round-trip
  guarantees the file is engine-correct.
