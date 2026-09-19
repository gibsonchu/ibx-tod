"""Build the lot-level building layers for the IBX housing explorer.

Input : ../gis-src/half-mile-ibxstations-housing.{shp,dbf}  (the study's PLUTO 24v4.1 walkshed layer)
        ../data/ibx.json                                     (stations + per-station scenario allocations)
Output: ../data/lots.json   every lot that has homes today, plus every lot that receives new homes
        ../data/ibx.json    updated with real per-station "homes today" counts and lot stats

Grey buildings are real: one per tax lot with residential units, at its real floor count.
Coloured buildings place each station's allocated new homes (from ibx.json) onto real lots of the
zoning category that scenario rezones, softest (most underbuilt) sites first.
"""
import json, math, os, sys
from pluto import read_dbf, read_polys, to_lonlat

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'gis-src', 'half-mile-ibxstations-housing')
DATA = os.path.join(HERE, '..', 'data')

WALKSHED_M = 804.672
SQFT_PER_UNIT = 880          # the report's "realistic" average unit size
FLOOR_M = 3.1
CATS = ['commercial', 'manufacturing', 'lowRes', 'highRes']
NO_BUILD_LANDUSE = {'07', '08', '09'}   # transport/utility, public facilities, open space

# Residential FAR each scenario rezones a category *to* (NYC zoning district equivalents from the report)
TARGET_FAR = {
    's1': {'lowRes': 1.25, 'highRes': 3.0, 'manufacturing': 2.0, 'commercial': 3.0},   # one step up everywhere
    's2': {'manufacturing': 3.0, 'commercial': 4.2},                                     # M1-4/R6A, C4-5D
    's3': {'lowRes': 2.2},                                                               # R1–R5 -> R6
    's4': {'highRes': 6.02},                                                             # R6 -> R8A
    's5': {'commercial': 4.2, 'manufacturing': 3.0, 'lowRes': 1.25, 'highRes': 3.44},   # C4-5D, M1-4/R6A, R5, R7
}


def zone_cat(z):
    z = z.upper()
    if z.startswith('M'): return 'manufacturing'
    if z.startswith('C'): return 'commercial'
    if z.startswith('R'):
        try: n = int(z[1:].split('-')[0].rstrip('ABDX'))
        except ValueError: return None
        return 'lowRes' if n <= 5 else 'highRes'
    return None


def num(v):
    try: return float(v)
    except (TypeError, ValueError): return 0.0


def ring_area_m2(ring):
    lat0 = math.radians(ring[0][1]); kx = 111320 * math.cos(lat0); ky = 110574
    a = 0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        a += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky)
    return abs(a) / 2


def main():
    ibx = json.load(open(os.path.join(DATA, 'ibx.json')))
    stations = ibx['stations']
    keep = {'BBL', 'Address', 'ZoneDist1', 'LandUse', 'LotArea', 'BldgArea', 'UnitsRes', 'NumFloors',
            'BuiltFAR', 'Latitude', 'Longitude'}
    rows = read_dbf(SRC + '.dbf', keep)
    polys = read_polys(SRC + '.shp')
    assert len(rows) == len(polys)
    print(f'{len(rows)} lots', file=sys.stderr)

    lots = []
    for r, rings in zip(rows, polys):
        if not rings or not r['Latitude']: continue
        lon, lat = num(r['Longitude']), num(r['Latitude'])
        ring = max(rings, key=len)
        ll = [to_lonlat(x, y) for x, y in ring]
        if ll[0] == ll[-1]: ll = ll[:-1]
        # thin out near-duplicate vertices (<1.2 m apart)
        thin = [ll[0]]
        for p in ll[1:]:
            if math.hypot((p[0] - thin[-1][0]) * 84000, (p[1] - thin[-1][1]) * 111000) > 1.2: thin.append(p)
        if len(thin) < 3: continue
        # inset toward the centroid so neighbouring lots read as separate buildings
        cx = sum(p[0] for p in thin) / len(thin); cy = sum(p[1] for p in thin) / len(thin)
        k = 0.84
        thin = [(cx + (p[0] - cx) * k, cy + (p[1] - cy) * k) for p in thin]
        # the study's layer holds every lot *touching* a walkshed, so allow for lot depth past the circle
        near = [i for i, s in enumerate(stations)
                if math.hypot((lon - s['lon']) * 111320 * math.cos(math.radians(lat)), (lat - s['lat']) * 110574) <= WALKSHED_M + 90]
        if not near: continue
        lots.append(dict(
            ring=thin, zone=r['ZoneDist1'], cat=zone_cat(r['ZoneDist1']), landuse=r['LandUse'],
            addr=r['Address'].title(), lotArea=num(r['LotArea']), bldgArea=num(r['BldgArea']),
            units=int(num(r['UnitsRes'])), floors=num(r['NumFloors']), builtFar=num(r['BuiltFAR']),
            stations=near, lon=lon, lat=lat))
    print(f'{len(lots)} lots inside a walkshed', file=sys.stderr)

    # ── real homes today, per station ───────────────────────────
    for i, s in enumerate(stations):
        s['existingUnits'] = sum(l['units'] for l in lots if i in l['stations'])
        s['residentialLots'] = sum(1 for l in lots if i in l['stations'] and l['units'] > 0)
    ibx['corridor']['plutoUnits'] = sum(l['units'] for l in lots)
    ibx['corridor']['plutoResidentialLots'] = sum(1 for l in lots if l['units'] > 0)

    # ── place new homes on real lots ────────────────────────────
    placements = {}
    for sc in ibx['scenarios']:
        sid = sc['id']; far = TARGET_FAR[sid]; used = set(); out = []; short = 0
        # biggest allocations first so contested overlap lots go where they matter most
        jobs = sorted(((si, c, stations[si]['breakdown'][sid][c]) for si in range(len(stations)) for c in CATS),
                      key=lambda j: -j[2])
        for si, cat, need in jobs:
            if need <= 0 or cat not in far: continue
            F = far[cat]
            cands = []
            for li, l in enumerate(lots):
                if li in used or si not in l['stations'] or l['cat'] != cat or l['landuse'] in NO_BUILD_LANDUSE: continue
                if l['lotArea'] < 1200: continue
                gap = F - l['builtFar']
                cap = int((l['lotArea'] * F - l['bldgArea']) / SQFT_PER_UNIT)
                if gap <= 0 or cap < 1: continue
                cands.append((gap, l['lotArea'], li, cap))
            cands.sort(key=lambda c: (-c[0], -c[1]))
            if not cands:
                # nothing underbuilt left in this category here: fall back to any lot of the category
                cands = [(0, l['lotArea'], li, max(1, int(l['lotArea'] * F / SQFT_PER_UNIT)))
                         for li, l in enumerate(lots)
                         if li not in used and si in l['stations'] and l['cat'] == cat and l['landuse'] not in NO_BUILD_LANDUSE]
                cands.sort(key=lambda c: -c[1])
            got = []; left = need
            for gap, area, li, cap in cands:
                if left <= 0: break
                take = min(cap, left); got.append([li, take]); left -= take
            if left > 0 and got:
                # zoning capacity at this station ran out before the allocation did: spread the remainder
                short += left
                tot = sum(g[1] for g in got); spread = 0
                for g in got:
                    add = left * g[1] // tot; g[1] += add; spread += add
                got[0][1] += left - spread           # keep the station total exact
            elif left > 0:
                # the report counts this zoning here but no such lot's centre falls inside the circle
                # (Utica Avenue's 7% R6+): use the nearest lots of that category just past the edge
                st = stations[si]
                d = lambda l: math.hypot((l['lon'] - st['lon']) * 111320 * math.cos(math.radians(l['lat'])), (l['lat'] - st['lat']) * 110574)
                pool = sorted((li for li, l in enumerate(lots)
                               if li not in used and l['cat'] == cat and l['landuse'] not in NO_BUILD_LANDUSE),
                              key=lambda li: d(lots[li]))[:12]
                print(f'  .. {sid} {st["name"]} {cat}: {left} homes placed on nearest {cat} lots '
                      f'({d(lots[pool[0]]):.0f}-{d(lots[pool[-1]]):.0f} m out)', file=sys.stderr)
                per = left // len(pool)
                got = [[li, per] for li in pool]; got[0][1] += left - per * len(pool)
            for li, n in got:
                used.add(li); out.append([li, CATS.index(cat), n, si])
        placements[sid] = out
        placed = sum(p[2] for p in out)
        print(f'{sid}: {len(out)} lots, {placed} homes placed (report {sc["units"]}), {short} over zoning capacity', file=sys.stderr)
        sc['lotsBuilt'] = len(out)

    # per-station lot counts for the detail panel
    for s in stations: s['newLots'] = {}
    for sid, out in placements.items():
        for li, c, n, si in out:
            stations[si]['newLots'][sid] = stations[si]['newLots'].get(sid, 0) + 1

    # ── write only the lots we draw ─────────────────────────────
    needed = sorted({li for li, l in enumerate(lots) if l['units'] > 0} |
                    {p[0] for out in placements.values() for p in out})
    remap = {li: i for i, li in enumerate(needed)}
    ox = min(p[0] for li in needed for p in lots[li]['ring']); oy = min(p[1] for li in needed for p in lots[li]['ring'])
    Q = 1e5  # ~1 m
    zones = sorted({lots[li]['zone'] for li in needed})
    geom, h, u, z, a = [], [], [], [], []
    for li in needed:
        l = lots[li]
        pts = [(round((x - ox) * Q), round((y - oy) * Q)) for x, y in l['ring']]
        flat = [pts[0][0], pts[0][1]]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]): flat += [x1 - x0, y1 - y0]
        geom.append(flat)
        h.append(round(max(l['floors'], 1) * FLOOR_M) if l['units'] > 0 else 0)
        u.append(l['units']); z.append(zones.index(l['zone'])); a.append(l['addr'])

    # new-building height: added floor area spread over ~65% lot coverage
    scen = {}
    for sid, out in placements.items():
        rows_ = []
        for li, c, n, si in out:
            l = lots[li]
            floors = n * SQFT_PER_UNIT * 1.15 / max(l['lotArea'] * 0.65, 400)
            rows_.append([remap[li], c, n, max(3, round(floors * FLOOR_M))])
        scen[sid] = rows_

    json.dump(dict(o=[round(ox, 6), round(oy, 6)], q=Q, zones=zones, g=geom, h=h, u=u, z=z, a=a, s=scen),
              open(os.path.join(DATA, 'lots.json'), 'w'), separators=(',', ':'))
    json.dump(ibx, open(os.path.join(DATA, 'ibx.json'), 'w'), separators=(',', ':'))
    print(f'wrote {len(needed)} lots, {os.path.getsize(os.path.join(DATA, "lots.json")) / 1e6:.1f} MB', file=sys.stderr)


if __name__ == '__main__':
    main()
