# IBX TOD — Housing Explorer

A 3D map of housing capacity around the 19 proposed [Interborough Express](https://en.wikipedia.org/wiki/Interborough_Express) stations, built from the New York Building Congress / New York Building Foundation 2025 report *Housing and the Interborough Express: Tackling New York City's Housing Crisis One Stop at a Time*.

- **3D columns** per station: grey base = homes there today, coloured stack = new homes under the selected rezoning scenario, split by the land they come from (commercial, manufacturing, low- and high-density residential).
- **Five scenarios** from the report, with corridor totals against the 70,925-home TOD target.
- **Address search** (NYC Planning GeoSearch) shows which half-mile station walksheds an address falls inside.
- **Station detail**: land-use mix, quick-win and equity scores, and a cross-scenario comparison.

## Data

Station land use, lot area, typology, scores and scenario totals are transcribed from the report; station points and the route come from the study's GIS. The report gives scenario totals only for the whole corridor, so per-station figures are an allocation of those totals by rezoned land area — see "How these numbers are built" in the app.

## Run locally

Plain static site, no build step.

```bash
python3 serve.py 5178
```

Basemap © CARTO, © OpenStreetMap contributors. Rendering by MapLibre GL JS.
