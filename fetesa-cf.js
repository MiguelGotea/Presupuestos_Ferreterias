// fetesa-cf.js — Resuelve el Cloudflare JS Challenge de fetesa.com.ni
// usando Puppeteer (headless Chrome real). Cachea cf_clearance ~50 min.
//
// INSTALAR (en el servidor):
//   npm install puppeteer-core
//   apt-get install -y chromium-browser   # Ubuntu/Debian
//   (o: snap install chromium)
//
// El cookie cf_clearance es válido ~1 hora y está vinculado a la IP del VPS,
// por lo que curl en el mismo servidor puede reutilizarlo.

const { execSync, spawn } = require('child_process');
const path = require('path');

// ── Estado del cache ────────────────────────────────────────────────────────
let _cfClearance   = null;
let _cfExpiry      = 0;
let _refreshing    = false;
let _refreshQueue  = [];

// ── Detectar ruta de Chrome/Chromium ───────────────────────────────────────
function findChromePath() {
  const candidates = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ];
  for (const p of candidates) {
    try { execSync(`test -x "${p}"`, { stdio: 'ignore' }); return p; } catch(_) {}
  }
  return null;
}

// ── Obtener cookie cf_clearance via Puppeteer ───────────────────────────────
async function refreshCfClearance() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch(e) {
    throw new Error('puppeteer-core no instalado. Ejecuta: npm install puppeteer-core');
  }

  const executablePath = findChromePath();
  if (!executablePath) {
    throw new Error('Chromium no encontrado. Ejecuta: apt-get install -y chromium-browser');
  }

  console.log('[fetesa-cf] Lanzando Chrome para resolver CF challenge...');
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',          // menos RAM en VPS de 1GB
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
    ],
    timeout: 30000,
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    // Cargar la página principal para resolver el JS challenge
    await page.goto('https://fetesa.com.ni/', {
      waitUntil: 'networkidle2',
      timeout: 25000,
    });

    // Esperar a que cf_clearance aparezca (puede tardar hasta 10s)
    let cookies = [];
    for (let i = 0; i < 10; i++) {
      cookies = await page.cookies('https://fetesa.com.ni');
      const cf = cookies.find(c => c.name === 'cf_clearance');
      if (cf) {
        _cfClearance = cf.value;
        _cfExpiry = Date.now() + 50 * 60 * 1000; // 50 minutos
        console.log('[fetesa-cf] cf_clearance obtenido, válido hasta', new Date(_cfExpiry).toISOString());
        return _cfClearance;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    // Si no hay cf_clearance, puede que el sitio no require challenge para algunas IPs
    // Intentar igual con las cookies que tengamos
    const allCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    if (allCookies) {
      _cfClearance = allCookies; // guardar lo que tengamos
      _cfExpiry = Date.now() + 10 * 60 * 1000; // 10 minutos
      console.log('[fetesa-cf] Sin cf_clearance específico, usando cookies disponibles');
      return _cfClearance;
    }

    throw new Error('No se pudo obtener cf_clearance después de 10 segundos');
  } finally {
    await browser.close();
  }
}

// ── API pública: obtener cookie con cache ───────────────────────────────────
async function getCfCookie() {
  // Si el cache es válido, devolverlo
  if (_cfClearance && Date.now() < _cfExpiry) return _cfClearance;

  // Si ya se está refrescando, esperar en la cola
  if (_refreshing) {
    return new Promise((resolve, reject) => {
      _refreshQueue.push({ resolve, reject });
    });
  }

  _refreshing = true;
  try {
    const cookie = await refreshCfClearance();
    _refreshQueue.forEach(p => p.resolve(cookie));
    return cookie;
  } catch(e) {
    _refreshQueue.forEach(p => p.reject(e));
    throw e;
  } finally {
    _refreshing = false;
    _refreshQueue = [];
  }
}

// ── Invalidar cache (forzar refresh) ──────────────────────────────────────
function invalidateCfCache() {
  _cfClearance = null;
  _cfExpiry = 0;
}

module.exports = { getCfCookie, invalidateCfCache };
