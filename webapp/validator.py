"""
validator.py — Sanity-checks a LevelData before serializing/storing.

Rules derived from how the Saturn engine consumes the .UTE format
(see Utenyaa-Netlink/src/Entities/World.hpp + src/Objects/Map.hpp):

    PlayerSpawn entities → become Entities::Player at fixed_xy + 0.5 << 3
                            (world units). Engine spawns up to
                            JO_INPUT_MAX_DEVICE & PlayerCount of them
                            in spawn-list order. The match needs at
                            least 2 spawns to start (UNET_MIN_TO_START).

    Model entities       → Entities::StaticDetail3D, model id from
                            Reserved[1]. Decorative (trees, walls).

    Crate entities       → Entities::Crate, flags from Reserved[0]
                            (bits: Health|Bomb|Mine), model from
                            Reserved[1]. At least one is needed for
                            pickups to spawn.

Entity coords are TILE coordinates (0..MAP_DIMENSION-1). The engine
multiplies by 8 and adds 0.5 to get world position. Out-of-range
coords cause the engine's tile-height lookup to read OOB.
"""

from __future__ import annotations
from typing import List, Tuple
from ute_format import (
    LevelData, MAP_DIMENSION, TILE_COUNT,
    ENTITY_TYPE_PLAYER_SPAWN, ENTITY_TYPE_MODEL,
    ENTITY_TYPE_CRATE, ENTITY_TYPE_EMPTY,
)


# Engine-side limits (matched to the Saturn build):
MIN_PLAYER_SPAWNS = 2     # UNET_MIN_TO_START in utenyaa_protocol.h
MAX_PLAYER_SPAWNS = 4     # UNET_MAX_PLAYERS
RECOMMENDED_MIN_CRATES = 1
MAX_TOTAL_ENTITIES = 64   # generous; production maps cap at 47

# Saturn-side streaming cap (UNET_MAP_MAX_SIZE in utenyaa_protocol.h).
# Maps larger than this get rejected by the server before streaming
# AND would overflow the Saturn's RX buffer if they slipped through.
# Bumping this cap requires a binary update on every Saturn — keep
# this constant in sync with the protocol header.
SATURN_MAP_MAX_BYTES = 16384

# Soft warning threshold — author should know they're getting close
# to the cap. 80% of cap.
SATURN_MAP_WARN_BYTES = int(SATURN_MAP_MAX_BYTES * 0.80)


def validate(L: LevelData, *, strict: bool = False) -> Tuple[List[str], List[str]]:
    """Run all checks. Returns (errors, warnings).

    `errors` block save (the .UTE wouldn't load or play correctly).
    `warnings` are recommended fixes but don't block save.

    With strict=True, warnings are upgraded to errors.
    """
    errors: List[str] = []
    warnings: List[str] = []

    # --- Tile grid integrity ---
    if len(L.tiles) != TILE_COUNT:
        errors.append(f"tile count must be exactly {TILE_COUNT}, got {len(L.tiles)}")
    if len(L.gourad) != TILE_COUNT:
        errors.append(f"gourad count must be exactly {TILE_COUNT}, got {len(L.gourad)}")
    if len(L.normals) != TILE_COUNT:
        errors.append(f"normal count must be exactly {TILE_COUNT}, got {len(L.normals)}")

    # --- Entities ---
    n_player_spawn = sum(1 for e in L.entities if e.type == ENTITY_TYPE_PLAYER_SPAWN)
    n_crate        = sum(1 for e in L.entities if e.type == ENTITY_TYPE_CRATE)

    if n_player_spawn < MIN_PLAYER_SPAWNS:
        errors.append(
            f"need at least {MIN_PLAYER_SPAWNS} player spawn(s); have {n_player_spawn}")
    if n_player_spawn > MAX_PLAYER_SPAWNS:
        warnings.append(
            f"player spawns > {MAX_PLAYER_SPAWNS}: only the first {MAX_PLAYER_SPAWNS} "
            f"will be used by the engine (Settings::PlayerCount cap)")

    if n_crate < RECOMMENDED_MIN_CRATES:
        warnings.append(
            f"no crate spawns — players won't be able to pick up "
            f"Health/Bomb/Mine pickups during the match")

    if len(L.entities) > MAX_TOTAL_ENTITIES:
        warnings.append(
            f"entity count {len(L.entities)} > {MAX_TOTAL_ENTITIES}: high counts can "
            f"strain the SH-2 entity update budget")

    # Out-of-bounds coords
    for i, e in enumerate(L.entities):
        if e.x >= MAP_DIMENSION:
            errors.append(
                f"entity[{i}] x={e.x} out of range 0..{MAP_DIMENSION-1}")
        if e.y >= MAP_DIMENSION:
            errors.append(
                f"entity[{i}] y={e.y} out of range 0..{MAP_DIMENSION-1}")
        if e.type not in (ENTITY_TYPE_EMPTY, ENTITY_TYPE_PLAYER_SPAWN,
                          ENTITY_TYPE_MODEL, ENTITY_TYPE_CRATE):
            errors.append(
                f"entity[{i}] unknown type {e.type}; valid: 0(Empty), "
                f"1(PlayerSpawn), 2(Model), 3(Crate)")
        if len(e.reserved) != 16:
            errors.append(
                f"entity[{i}] reserved len {len(e.reserved)}, must be 16")

    # --- Crate flag sanity ---
    for i, e in enumerate(L.entities):
        if e.type != ENTITY_TYPE_CRATE:
            continue
        flags = e.reserved[0]
        # Engine accepts bits 0/1/2 = Health/Bomb/Mine. Higher bits ignored
        # but we warn so the .UTE round-trips byte-identical.
        if flags == 0:
            warnings.append(
                f"entity[{i}] crate has flags=0 — the server's pickup "
                f"randomizer needs at least one of bits 0..2 set "
                f"(0x01=Health, 0x02=Bomb, 0x04=Mine)")
        if flags > 0x07:
            warnings.append(
                f"entity[{i}] crate flags 0x{flags:02X} has bits beyond 0..2 set; "
                f"engine ignores those bits")

    # Co-located player spawns
    seen_xy = {}
    for i, e in enumerate(L.entities):
        if e.type != ENTITY_TYPE_PLAYER_SPAWN:
            continue
        key = (e.x, e.y)
        if key in seen_xy:
            warnings.append(
                f"entity[{i}] player spawn at ({e.x},{e.y}) duplicates "
                f"entity[{seen_xy[key]}] — players will spawn on top of each other")
        else:
            seen_xy[key] = i

    # Saturn-streaming size cap. Compute the on-disk .UTE size now so
    # we can flag oversized maps BEFORE they're saved (and certainly
    # before they're pushed to the Saturn for live play).
    try:
        from ute_format import serialize as _serialize
        ute_size = len(_serialize(L))
    except Exception:
        ute_size = 0

    if ute_size > SATURN_MAP_MAX_BYTES:
        errors.append(
            f"map size {ute_size} bytes exceeds Saturn streaming cap "
            f"({SATURN_MAP_MAX_BYTES} bytes / UNET_MAP_MAX_SIZE). The "
            f"server will refuse to push it to clients. Reduce entity "
            f"count to shrink (each entity is 28 bytes; the rest of "
            f"the file is fixed-size)."
        )
    elif ute_size > SATURN_MAP_WARN_BYTES:
        pct = 100.0 * ute_size / SATURN_MAP_MAX_BYTES
        warnings.append(
            f"map size {ute_size} bytes is {pct:.0f}% of Saturn cap "
            f"({SATURN_MAP_MAX_BYTES} bytes). Adding more entities "
            f"could push past the cap and block live streaming."
        )

    if strict:
        errors += warnings
        warnings = []

    return errors, warnings
