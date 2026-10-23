'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DIST_DIR = path.join(ROOT, 'dist');
const EXTERNAL_SHIFT_HTML = 'C:\\Users\\mrhai\\.gemini\\antigravity\\scratch\\shift-pay-app\\index.html';

const MODULE_MAP = {
  'portableDb': 'src/db/portableDb.js',
  'database': 'src/db/database.js',
  'shiftSyncService': 'src/services/shiftSyncService.js',
  'survivalEngine': 'src/services/survivalEngine.js',
  'esunParser': 'src/services/esunParser.js',
  'reconciliationEngine': 'src/services/reconciliationEngine.js',
  'impulseControlService': 'src/services/impulseControlService.js',
  'accountingPatchService': 'src/services/accountingPatchService.js',
  'gmailImapService': 'src/services/gmailImapService.js',
  'api': 'src/routes/api.js',
  'browserEntry': 'src/browserEntry.js'
};

function buildBrowserEngineBundle() {
  const entries = [];
  for (const [key, relPath] of Object.entries(MODULE_MAP)) {
    const code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    entries.push(`  ${JSON.stringify(key)}: function(module, exports, require) {\n${code}\n  }`);
  }

  const bundle = `(function() {
  var modules = {
${entries.join(',\n')}
  };
  var cache = {};
  function resolveKey(req) {
    if (req.startsWith('node:')) return null;
    var base = req.split('/').pop().replace(/\\.js$/, '');
    return modules[base] ? base : null;
  }
  function customRequire(req) {
    var key = resolveKey(req);
    if (!key) throw new Error('Module not available in browser: ' + req);
    if (cache[key]) return cache[key].exports;
    var mod = { exports: {} };
    cache[key] = mod;
    modules[key](mod, mod.exports, customRequire);
    return mod.exports;
  }
  customRequire('browserEntry');
})();
`;

  const outPath = path.join(PUBLIC_DIR, 'js', 'browserEngine.js');
  fs.writeFileSync(outPath, bundle, 'utf8');
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

buildBrowserEngineBundle();
if (fs.existsSync(EXTERNAL_SHIFT_HTML)) {
  fs.copyFileSync(EXTERNAL_SHIFT_HTML, path.join(PUBLIC_DIR, 'shift-pay.html'));
}
copyRecursive(PUBLIC_DIR, DIST_DIR);
console.log('✅ Build complete: browserEngine.js bundled, shift-pay.html synced & public/ synced to dist/.');

