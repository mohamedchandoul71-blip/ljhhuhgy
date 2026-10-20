# Cactus & Eucalyptus Flowering Map

An interactive Leaflet map that joins parcel geometries from `Localisation1.shp` with flowering information from `base de données.xlsx`.

## Requirements

- Node.js 18 or newer
- The Excel workbook and complete shapefile set
- Internet access for Leaflet and OpenStreetMap assets

## Run locally

From the repository directory:

```bash
npm install
npm run build-data
npm start
```

Open **http://localhost:3000**. Do not open `index.html` directly using a `file://` URL; the map loads generated GeoJSON over HTTP.

## Input files

Keep these files in the repository root:

- `base de données.xlsx`
- `Localisation1.shp`
- `Localisation1.shx`
- `Localisation1.dbf`
- `Localisation1.prj` (recommended)
- Other shapefile sidecar files, if supplied

The builder reads the `flori` worksheet if present, otherwise the first worksheet. It recognizes common variants of parcel-ID, species, dominant-species, and flowering-period headings. If your workbook uses different column headings, update the aliases in `build_data.js`.

## Generated outputs

- `parcels.json`: GeoJSON used by the browser map
- `data-audit.json`: join diagnostics, including unmatched IDs and duplicate spreadsheet IDs

The build command exits with a non-zero code when required files are missing or processing fails.

## Map behavior and limitations

- The date filter uses the **month** of the selected date.
- Species names are split only on common list separators (slash, comma, semicolon, or pipe), not on spaces.
- The radius filter measures distance from the selected map point to each feature's bounding-box centre. It is approximate; it does not test whether a polygon intersects the circle.
- Different map features can share one parcel ID, so feature count and unique parcel count are different.
- If a positive source area is unavailable, the builder estimates area from polygon geometry and marks `superficieSource` as `geometry`. Validate these estimates against official area data before relying on them.
- Flowering status is an expected period from the spreadsheet, not a live observation.

## Deployment

Use a Node.js host and run `npm install`, `npm run build-data`, then `npm start`. The generated `parcels.json` must be in the same directory as `app.js`. The Express server only exposes the map, generated data, audit report, and health endpoint; it does not serve the source workbook or shapefile files.

## Data quality

Review `data-audit.json` after each build. Pay particular attention to unmatched parcel IDs, duplicate Excel IDs, missing area values, and geometry-derived area estimates. A successful build confirms the files could be processed; it does not prove that every source-data join is semantically correct.
