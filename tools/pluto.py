"""Readers for the study's PLUTO walkshed layer (no third-party deps)."""
import math, struct

# EPSG:2263 NAD83 / New York Long Island (ftUS) — Lambert Conformal Conic, 2SP, GRS80
_a = 6378137.0; _f = 1 / 298.257222101; _e = math.sqrt(2 * _f - _f * _f)
_FT = 0.3048006096012192
_lat1, _lat2, _lat0, _lon0 = map(math.radians, (41.03333333333333, 40.66666666666666, 40.16666666666666, -74.0))
_x0 = 300000.0; _y0 = 0.0

def _m(p): return math.cos(p) / math.sqrt(1 - (_e * math.sin(p)) ** 2)
def _t(p): return math.tan(math.pi / 4 - p / 2) / ((1 - _e * math.sin(p)) / (1 + _e * math.sin(p))) ** (_e / 2)
_n = (math.log(_m(_lat1)) - math.log(_m(_lat2))) / (math.log(_t(_lat1)) - math.log(_t(_lat2)))
_F = _m(_lat1) / (_n * _t(_lat1) ** _n)
_r0 = _a * _F * _t(_lat0) ** _n

def to_lonlat(xft, yft):
    x = xft * _FT - _x0; y = _r0 - (yft * _FT - _y0)
    r = math.copysign(math.hypot(x, y), _n)
    t = (r / (_a * _F)) ** (1 / _n)
    theta = math.atan2(x, y)
    lat = math.pi / 2 - 2 * math.atan(t)
    for _ in range(8):
        es = _e * math.sin(lat)
        lat = math.pi / 2 - 2 * math.atan(t * ((1 - es) / (1 + es)) ** (_e / 2))
    return math.degrees(theta / _n + _lon0), math.degrees(lat)

def read_dbf(path, keep):
    f = open(path, 'rb'); h = f.read(32)
    n = struct.unpack('<I', h[4:8])[0]; hl = struct.unpack('<H', h[8:10])[0]; rl = struct.unpack('<H', h[10:12])[0]
    fields = []; off = 1
    while True:
        d = f.read(32)
        if d[0:1] == b'\r': break
        name = d[0:11].split(b'\0')[0].decode(); ln = d[16]
        fields.append((name, off, ln)); off += ln
    fields = [x for x in fields if x[0] in keep]
    f.seek(hl); rows = []
    for _ in range(n):
        rec = f.read(rl)
        rows.append({k: rec[o:o + l].decode('latin1').strip() for k, o, l in fields})
    return rows

def read_polys(path):
    """Yield each record's rings (lists of [x, y] in file units)."""
    f = open(path, 'rb'); f.seek(24); flen = struct.unpack('>I', f.read(4))[0] * 2
    f.seek(100); out = []
    while f.tell() < flen:
        _, clen = struct.unpack('>II', f.read(8)); data = f.read(clen * 2)
        st = struct.unpack('<I', data[0:4])[0]
        if st not in (5, 15, 25):
            out.append([]); continue
        np_, npt = struct.unpack('<II', data[36:44])
        parts = struct.unpack('<%dI' % np_, data[44:44 + 4 * np_]); po = 44 + 4 * np_
        pts = struct.unpack('<%dd' % (2 * npt), data[po:po + 16 * npt])
        pts = [[pts[2 * i], pts[2 * i + 1]] for i in range(npt)]
        out.append([pts[parts[i]:(parts[i + 1] if i + 1 < np_ else npt)] for i in range(np_)])
    return out
