# IBX TOD — Housing Explorer

A 3D map of housing capacity around the 19 proposed [Interborough Express](https://en.wikipedia.org/wiki/Interborough_Express) stations, built from the New York Building Congress / New York Building Foundation 2025 report *Housing and the Interborough Express: Tackling New York City's Housing Crisis One Stop at a Time*.

- **Real buildings**: every tax lot with homes today is drawn grey, on its real outline at its real floor count (PLUTO 24v4.1 — 52,000+ lots, 184,675 homes).
- **New homes as buildings**: each scenario's new homes are placed on real lots of the zoning it rezones — most underbuilt first — and coloured by that zoning (commercial, manufacturing, low- and high-density residential).
- **Five scenarios** from the report, with corridor totals against the 70,925-home TOD target.
- **Address search** (NYC Planning GeoSearch) shows which half-mile station walksheds an address falls inside.
- **Station detail**: land-use mix, quick-win and equity scores, and a cross-scenario comparison.

## Data

Station land use, lot area, typology, scores and scenario totals are transcribed from the report; station points and the route come from the study's GIS. The report gives scenario totals only for the whole corridor, so per-station figures are an allocation of those totals by rezoned land area — see "How these numbers are built" in the app.

## Rebuilding the data

`data/lots.json` is generated from the study's PLUTO walkshed layer (not in this repo):

```bash
# put half-mile-ibxstations-housing.{shp,dbf,prj} in gis-src/, then
python3 tools/build_buildings.py
```

## Run locally

Plain static site, no build step.

```bash
python3 serve.py 5178
```

Basemap © CARTO, © OpenStreetMap contributors. Rendering by MapLibre GL JS.
