'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const allowedFiles = new Set(['index.html', 'parcels.json', 'data-audit.json']);

app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/', (_req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});
app.get('/:file', (req, res, next) => {
  const file = req.params.file;
  if (!allowedFiles.has(file)) return next();
  const fullPath = path.join(ROOT, file);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return res.status(404).json({
      error: file === 'parcels.json'
        ? 'Map data has not been generated yet. Run npm run build-data.'
        : 'Requested file not found.'
    });
  }
  res.sendFile(fullPath);
});
app.use((_req, res) => res.status(404).send('Not found'));

app.listen(PORT, '0.0.0.0', () => {
  console.log('Flowering map server listening on port ' + PORT);
  if (!fs.existsSync(path.join(ROOT, 'parcels.json'))) {
    console.warn('parcels.json is missing. Run "npm run build-data" before using the map.');
  }
});
