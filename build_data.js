const fs = require('fs');
const path = require('path');
const shapefile = require('shapefile');
const XLSX = require('xlsx');

function parseFloweringMonths(floriStr) {
    if (!floriStr || typeof floriStr !== 'string') return [];
    const matches = floriStr.toLowerCase().match(/m\d+/g);
    if (!matches) return [];
    return [...new Set(matches.map(m => parseInt(m.replace('m', ''), 10)))].sort((a, b) => a - b);
}

async function buildStaticData() {
    try {
        console.log("Reading Excel database...");
        const excelPath = path.join(__dirname, 'data', 'AFEjybsa-eozZ9QAQQKEiMoqJPc_3_base_Eucalyptus4.xlsx');
        const workbook = XLSX.readFile(excelPath);
        const floriSheet = XLSX.utils.sheet_to_json(workbook.Sheets['flori'] || workbook.Sheets[workbook.SheetNames[0]]);
        
        const floriMap = new Map();
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

        console.log("Reading Shapefile...");
        const shpPath = path.join(__dirname, 'data', 'Localisation1.shp');
        const dbfPath = path.join(__dirname, 'data', 'Localisation1.dbf');
        
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
                    superficie: feature.properties.superficie,
                    speciesRaw: floweringData.espece,
                    dominantSpecies: floweringData.domin,
                    floweringPeriod: floweringData.floriRaw,
                    floweringMonths: floweringData.months,
                };
                
                features.push(feature);
            }
            result = await source.read();
        }

        const geoJSON = { type: "FeatureCollection", features: features };
        
        // Ensure public directory exists
        const publicDir = path.join(__dirname, 'public');
        if (!fs.existsSync(publicDir)){
            fs.mkdirSync(publicDir);
        }

        const outputPath = path.join(publicDir, 'parcels.json');
        fs.writeFileSync(outputPath, JSON.stringify(geoJSON));
        
        console.log(`Success! Compiled ${features.length} parcels into ${outputPath}`);
    } catch (error) {
        console.error("Build failed:", error);
    }
}

buildStaticData();
