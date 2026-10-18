const express = require('express');
const path = require('path');
const fs = require('fs');
const shapefile = require('shapefile');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let processedGeoJSON = { type: "FeatureCollection", features: [] };

function parseFloweringMonths(floriStr) {
    if (!floriStr || typeof floriStr !== 'string') return [];
    const matches = floriStr.toLowerCase().match(/m\d+/g);
    if (!matches) return [];
    return [...new Set(matches.map(m => parseInt(m.replace('m', ''), 10)))].sort((a, b) => a - b);
}

async function loadAndProcessData() {
    try {
        const excelPath = path.join(__dirname, 'data', 'AFEjybsa-eozZ9QAQQKEiMoqJPc_3_base_Eucalyptus4.xlsx');
        if (!fs.existsSync(excelPath)) {
            throw new Error(`Excel database not found at path: ${excelPath}`);
        }

        const workbook = XLSX.readFile(excelPath);
        const floriSheet = XLSX.utils.sheet_to_json(workbook.Sheets['flori'] || workbook.Sheets[workbook.SheetNames[0]]);
        
        const floriMap = {};
        floriSheet.forEach(row => {
            const parcelId = String(row['ID parcelle'] || row['ID_parcelle'] || '').trim();
            if (parcelId) {
                floriMap.set(parcelId, {
                    espece: String(row['espece'] || '').trim(),
                    domin: String(row['domin'] || '').trim(),
                    floriRaw: String(row['flori'] || '').trim(),
                    months: parseFloweringMonths(row['flori'])
                });
            }
        });

        const shpPath = path.join(__dirname, 'data', 'Localisation1.shp');
        const dbfPath = path.join(__dirname, 'data', 'Localisation1.dbf');
        
        if (!fs.existsSync(shpPath) || !fs.existsSync(dbfPath)) {
            throw new Error(`Shapefile components (.shp/.dbf) missing in data directory.`);
        }

        const source = await shapefile.open(shpPath, dbfPath);
        const features = [];
        let result = await source.read();
        
        while (!result.done) {
            const feature = result.value;
            if (feature.geometry) {
                const rawId2 = feature.properties.ID2;
                const parcelId = rawId2 ? String(rawId2).trim() : '';
                
                const floweringData = floriMap.get(parcelId) || {
                    espece: 'Unknown',
                    domin: 'Unknown',
                    floriRaw: '',
                    months: []
                };

                feature.properties = {
                    parcelId: parcelId,
                    id1: feature.properties.ID_1,
                    superficie: feature.properties.superficie,
                    speciesRaw: floweringData.espece,
                    dominantSpecies: floweringData.domin,
                    floweringPeriod: floweringData.floriRaw,
                    floweringMonths: floweringData.months,
                    status: floweringData.months.length > 0 ? 'Available' : 'Unavailable'
                };
                
                features.push(feature);
            }
            result = await source.read();
        }

        processedGeoJSON = { type: "FeatureCollection", features: features };
        console.log(`[Data Pipeline] Successfully loaded ${features.length} spatial parcels.`);
    } catch (error) {
        console.error("[Fatal Error] Data processing pipeline failed:", error.message);
        process.exit(1);
    }
}

app.get('/api/parcels', (req, res) => {
    const { date, species } = req.query;
    let filteredFeatures = processedGeoJSON.features;

    if (species && species !== 'all') {
        const targetSpecies = species.toLowerCase().trim();
        filteredFeatures = filteredFeatures.filter(f => {
            const rawSpecies = (f.properties.speciesRaw || '').toLowerCase();
            const domSpecies = (f.properties.dominantSpecies || '').toLowerCase();
            const tokens = rawSpecies.split(/[\/\s]+/).map(t => t.trim());
            return tokens.includes(targetSpecies) || domSpecies.includes(targetSpecies);
        });
    }

    let targetMonth = null;
    if (date) {
        const parts = date.split('-');
        if (parts.length === 3) {
            targetMonth = parseInt(parts[1], 10);
        }
    }

    const enhancedFeatures = filteredFeatures.map(f => {
        const months = f.properties.floweringMonths || [];
        const isFlowering = targetMonth !== null && months.includes(targetMonth);
        return {
            ...f,
            properties: {
                ...f.properties,
                isFlowering: isFlowering,
                displayStatus: isFlowering ? 'Expected to be flowering' : 'Not flowering / Outside period'
            }
        };
    });

    res.json({
        type: "FeatureCollection",
        count: enhancedFeatures.length,
        features: enhancedFeatures
    });
});

app.get('/api/species', (req, res) => {
    const speciesSet = new Set();
    processedGeoJSON.features.forEach(f => {
        if (f.properties.speciesRaw) {
            f.properties.speciesRaw.split(/[\/\s]+/).forEach(s => {
                const cleaned = s.trim();
                if (cleaned && cleaned.toLowerCase() !== 'e') speciesSet.add(cleaned);
            });
        }
    });
    res.json(Array.from(speciesSet).sort());
});

loadAndProcessData().then(() => {
    app.listen(PORT, () => {
        console.log(`Server operational at http://localhost:${PORT}`);
    });
});