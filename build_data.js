'use strict';

const fs = require('fs');
const path = require('path');
const shapefile = require('shapefile');
const XLSX = require('xlsx');

const ROOT = __dirname;
const EXCEL_PATH = path.join(ROOT, 'base de données.xlsx');
const SHAPE_PATH = path.join(ROOT, 'Localisation1.shp');
const DBF_PATH = path.join(ROOT, 'Localisation1.dbf');
const OUTPUT_PATH = path.join(ROOT, 'parcels.json');
const EARTH_RADIUS_M = 6371008.8;

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeId(value) {
  // Normalize harmless formatting differences, but retain punctuation that may
  // be meaningful in parcel identifiers.
  return clean(value).normalize('NFKC').replace(/\s+/g, '').toLocaleUpperCase();
}

function normalizedHeaderMap(row) {
  const map = new Map();
  for (const key of Object.keys(row || {})) {
    map.set(key.toLocaleLowerCase().replace(/[\s_-]+/g, ''), key);
  }
  return map;
}

function getCell(row, aliases) {
  const headers = normalizedHeaderMap(row);
  for (const alias of aliases) {
    const actual = headers.get(alias.toLocaleLowerCase().replace(/[\s_-]+/g, ''));
    if (actual !== undefined && row[actual] != null && clean(row[actual]) !== '') {
      return row[actual];
    }
  }
  return '';
}

function parseFloweringMonths(value) {
  const raw = clean(value);
  if (!raw) return [];
  const found = new Set();
  // Accept M1, M01, M1-M3 and similar source notation; never emit invalid months.
  for (const match of raw.toLocaleUpperCase().matchAll(/M\s*0?(\d{1,2})/g)) {
    const month = Number(match[1]);
    if (month >= 1 && month <= 12) found.add(month);
  }
  return [...found].sort((a, b) => a - b);
}

function parseSpecies(value) {
  // Do not split on whitespace: species names commonly contain spaces.
  return [...new Set(clean(value).split(/[\/;,|]+/).map(s => s.trim()).filter(Boolean))];
}

function ringAreaSquareMeters(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    if (![lon1, lat1, lon2, lat2].every(Number.isFinite)) continue;
    const deltaLon = (lon2 - lon1) * Math.PI / 180;
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    sum += deltaLon * (2 + Math.sin(lat1Rad) + Math.sin(lat2Rad));
  }
  return Math.abs(sum * EARTH_RADIUS_M * EARTH_RADIUS_M / 2);
}

function polygonAreaSquareMeters(rings) {
  if (!Array.isArray(rings) || !rings.length) return 0;
  const outer = ringAreaSquareMeters(rings[0]);
  const holes = rings.slice(1).reduce((total, ring) => total + ringAreaSquareMeters(ring), 0);
  return Math.max(0, outer - holes);
}

function geometryAreaSquareMeters(geometry) {
  if (!geometry) return 0;
  if (geometry.type === 'Polygon') return polygonAreaSquareMeters(geometry.coordinates);
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.reduce((total, polygon) => total + polygonAreaSquareMeters(polygon), 0);
  }
  return 0;
}

function findWorkbookSheet(workbook) {
  const exact = workbook.SheetNames.find(name => name.toLocaleLowerCase().trim() === 'flori');
  return workbook.Sheets[exact || workbook.SheetNames[0]];
}

async function buildStaticData() {
  for (const file of [EXCEL_PATH, SHAPE_PATH, DBF_PATH]) {
    if (!fs.existsSync(file)) throw new Error('Required input file is missing: ' + path.basename(file));
  }

  console.log('Reading Excel database:', path.basename(EXCEL_PATH));
  const workbook = XLSX.readFile(EXCEL_PATH, { cellDates: false });
  const sheet = findWorkbookSheet(workbook);
  if (!sheet) throw new Error('The workbook contains no readable worksheet.');

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) throw new Error('The selected Excel worksheet is empty.');

  const floweringById = new Map();
  const duplicateExcelIds = new Set();
  let rowsWithoutId = 0;

  for (const row of rows) {
    const rawId = getCell(row, ['ID parcelle', 'ID_parcelle', 'ID2', 'parcelId', 'parcel_id', 'id']);
    const key = normalizeId(rawId);
    if (!key) { rowsWithoutId++; continue; }
    if (floweringById.has(key)) duplicateExcelIds.add(key);

    const species = clean(getCell(row, ['espece', 'espèce', 'species', 'plant type']));
    const dominant = clean(getCell(row, ['domin', 'dominante', 'dominantSpecies', 'dominant species']));
    const floweringRaw = clean(getCell(row, ['flori', 'floraison', 'floweringPeriod', 'flowering period']));
    floweringById.set(key, {
      speciesRaw: species,
      speciesList: parseSpecies(species),
      dominantSpecies: dominant,
      floweringPeriod: floweringRaw,
      floweringMonths: parseFloweringMonths(floweringRaw)
    });
  }

  if (!floweringById.size) {
    throw new Error('No parcel IDs were found in the Excel worksheet. Check the ID column heading.');
  }

  console.log('Reading shapefile...');
  const source = await shapefile.open(SHAPE_PATH, DBF_PATH);
  const features = [];
  const shapeIds = new Set();
  const unmatchedShapeIds = new Set();
  const matchedIds = new Set();
  let recordsWithoutId = 0;
  let sourceAreaZero = 0;
  let calculatedAreas = 0;
  let result = await source.read();

  while (!result.done) {
    const feature = result.value;
    if (feature.geometry) {
      const original = feature.properties || {};
      const parcelId = clean(original.ID2 ?? original.id2 ?? original.ID_1 ?? original.Id);
      const key = normalizeId(parcelId);
      if (!key) recordsWithoutId++;
      else shapeIds.add(key);

      const joined = key ? floweringById.get(key) : null;
      if (joined) matchedIds.add(key);
      else if (key) unmatchedShapeIds.add(key);

      const rawArea = Number(String(original.superficie ?? '').replace(',', '.'));
      let superficie = Number.isFinite(rawArea) && rawArea > 0 ? rawArea : null;
      let superficieSource = superficie == null ? 'unavailable' : 'source';
      if (superficie == null) {
        sourceAreaZero++;
        const calculated = geometryAreaSquareMeters(feature.geometry);
        if (Number.isFinite(calculated) && calculated > 0) {
          superficie = Math.round(calculated * 100) / 100;
          superficieSource = 'geometry';
          calculatedAreas++;
        }
      }

      feature.properties = {
        parcelId,
        superficie,
        superficieSource,
        speciesRaw: joined?.speciesRaw || '',
        speciesList: joined?.speciesList || [],
        dominantSpecies: joined?.dominantSpecies || '',
        floweringPeriod: joined?.floweringPeriod || '',
        floweringMonths: joined?.floweringMonths || [],
        hasFloweringRecord: Boolean(joined)
      };
      features.push(feature);
    }
    result = await source.read();
  }

  if (!features.length) throw new Error('The shapefile did not contain any features with geometry.');

  const unmatchedExcelIds = [...floweringById.keys()].filter(key => !shapeIds.has(key));
  const geoJSON = {
    type: 'FeatureCollection',
    properties: {
      generatedAt: new Date().toISOString(),
      sourceWorksheet: workbook.SheetNames.find(name => workbook.Sheets[name] === sheet) || workbook.SheetNames[0],
      featureCount: features.length,
      uniqueShapefileParcelIds: shapeIds.size,
      matchedParcelIds: matchedIds.size,
      unmatchedShapefileParcelIds: unmatchedShapeIds.size,
      unmatchedExcelParcelIds: unmatchedExcelIds.length,
      duplicateExcelParcelIds: duplicateExcelIds.size,
      recordsWithoutParcelId: recordsWithoutId,
      sourceAreaMissingOrZero: sourceAreaZero,
      geometryAreasCalculated: calculatedAreas,
      notes: [
        'Areas with superficieSource="geometry" are estimates calculated from WGS84 polygon geometry.',
        'Repeated parcel IDs can represent multiple map features; feature count and unique parcel count are different.'
      ]
    },
    features
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(geoJSON));
  const auditPath = path.join(ROOT, 'data-audit.json');
  fs.writeFileSync(auditPath, JSON.stringify({
    ...geoJSON.properties,
    unmatchedShapefileParcelIds: [...unmatchedShapeIds],
    unmatchedExcelParcelIds,
    duplicateExcelParcelIds: [...duplicateExcelIds]
  }, null, 2));

  console.log('Build successful:', features.length, 'map features');
  console.log('Unique shapefile parcel IDs:', shapeIds.size);
  console.log('Excel/shapefile ID matches:', matchedIds.size);
  console.log('Unmatched shapefile IDs:', unmatchedShapeIds.size);
  console.log('Unmatched Excel IDs:', unmatchedExcelIds.length);
  console.log('Duplicate Excel IDs:', duplicateExcelIds.size);
  console.log('Missing/zero source areas:', sourceAreaZero, '; geometry areas calculated:', calculatedAreas);
  console.log('Wrote:', path.basename(OUTPUT_PATH), 'and', path.basename(auditPath));
}

buildStaticData().catch(error => {
  console.error('Build failed:', error.stack || error.message || error);
  process.exitCode = 1;
});
