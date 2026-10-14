'use strict';
// fetesa-cf.js — Sesión persistente de Chrome para fetesa.com.ni
//
// El cf_clearance está vinculado a la firma TLS del browser (JA3).
// Si curl (JA3 diferente) intenta usarlo, CF lo rechaza.
// Solución: usar el mismo Chrome para hacer los fetches via page.evaluate().
//
// Arquitectura:
//   1. Lanzar Chrome y cargar fetesa.com.ni (resuelve CF JS challenge)
//   2. Reusar esa pestaña para fetch() internos (mismo origen, sin CORS)
//   3. Cerrar Chrome después de N minutos de inactividad (liberar RAM)

const fs   = require('fs');
const path = require('path');

// ── Rutas Chrome (mismo orden que wsp-clientes) ─────────────────────────────
const CHROME_PATHS = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];
function findChrome() {
  return CHROME_PATHS.find(p => fs.existsSync(p)) || null;
}

// ── Args Chrome probados en el VPS (de wsp-clientes) ───────────────────────
const CHROME_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--no-zygote', '--no-first-run', '--disable-extensions',
  '--disable-background-networking', '--disable-breakpad',
  '--disable-component-update', '--disable-domain-reliability',
  '--disable-sync', '--disable-translate', '--metrics-recording-only',
  '--mute-audio', '--no-default-browser-check',
  '--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess',
];

// ── Obtener puppeteer ───────────────────────────────────────────────────────
function getPuppeteer() {
  try { return require('puppeteer'); } catch(_) {}
  try { return require('puppeteer-core'); } catch(_) {}
  const wspPath = path.resolve(__dirname, '../PitayaBot/wsp-clientes/node_modules/puppeteer');
  try { return require(wspPath); } catch(_) {}
  throw new Error('puppeteer no encontrado. Ejecuta: npm install puppeteer');
}

// ── Sesión persistente ──────────────────────────────────────────────────────
const IDLE_CLOSE_MS  = 8 * 60 * 1000;  // cerrar Chrome tras 8 min sin uso
const SESSION_TTL_MS = 45 * 60 * 1000; // refrescar sesión cada 45 min

let _browser     = null;
let _page        = null;
let _sessionAt   = 0;    // cuándo se obtuvo cf_clearance
let _lastUseAt   = 0;    // último uso
let _idleTimer   = null;
let _starting    = false;
let _startQueue  = [];

// Cerrar Chrome por inactividad
function scheduleIdleClose() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(async () => {
    console.log('[fetesa-cf] 💤 Inactividad — cerrando Chrome para liberar RAM');
    await closeSession();
  }, IDLE_CLOSE_MS);
}

async function closeSession() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  _page    = null;
  _sessionAt = 0;
  if (_browser) {
    try { await _browser.close(); } catch(_) {}
    _browser = null;
    console.log('[fetesa-cf] 🔒 Chrome cerrado.');
  }
}

// Lanzar Chrome y resolver CF challenge
async function startSession() {
  const puppeteer = getPuppeteer();
  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error('Chrome/Chromium no encontrado. Rutas: ' + CHROME_PATHS.join(', '));
  }

  console.log(`[fetesa-cf] 🌐 Lanzando Chrome (${executablePath})...`);
  await closeSession(); // limpiar si había algo

  _browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: CHROME_ARGS,
    timeout: 30000,
  });

  _page = await _browser.newPage();
  await _page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  // Cargar homepage para resolver el JS challenge
  console.log('[fetesa-cf] 🔄 Cargando fetesa.com.ni...');
  try {
    await _page.goto('https://fetesa.com.ni/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
  } catch(e) {
    console.log(`[fetesa-cf] ⚠️ goto warn: ${e.message} — continuando...`);
  }

  // Esperar cf_clearance (hasta 20s)
  console.log('[fetesa-cf] ⏳ Esperando CF challenge...');
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const cookies = await _page.cookies('https://fetesa.com.ni').catch(() => []);
    const ok = cookies.some(c => c.name === 'cf_clearance');
    if (ok) {
      console.log(`[fetesa-cf] ✅ cf_clearance obtenido (${i + 1}s)`);
      break;
    }
    if (i % 5 === 4) console.log(`[fetesa-cf] ... esperando (${i + 1}s)`);
  }

  _sessionAt = Date.now();
  _lastUseAt = Date.now();
  scheduleIdleClose();
  console.log('[fetesa-cf] ✅ Sesión lista');
}

// Asegurar que la sesión esté activa y fresca
async function ensureSession() {
  const sessionExpired = !_sessionAt || (Date.now() - _sessionAt) > SESSION_TTL_MS;
  const pageAlive = _page && !_page.isClosed();

  if (pageAlive && !sessionExpired) return; // sesión OK

  // Si ya hay un inicio en curso, encolar
  if (_starting) {
    return new Promise((resolve, reject) => _startQueue.push({ resolve, reject }));
  }

  _starting = true;
  try {
    await startSession();
    _startQueue.forEach(p => p.resolve());
  } catch(e) {
    _startQueue.forEach(p => p.reject(e));
    throw e;
  } finally {
    _starting = false;
    _startQueue = [];
  }
}

// ── Fetch API usando Chrome interno (mismo origen = sin CORS) ───────────────
async function fetesaFetch(apiUrl) {
  await ensureSession();
  _lastUseAt = Date.now();
  scheduleIdleClose(); // resetear timer de inactividad

  // page.evaluate hace fetch() desde el contexto de Chrome (fetesa.com.ni)
  // → mismo origen, misma firma TLS, cookies CF incluidas automáticamente
  const result = await _page.evaluate(async (url) => {
    try {
      const r = await fetch(url, {
        headers: {
          'Accept': 'application/json, */*;q=0.8',
          'Accept-Language': 'es-NI,es;q=0.9',
        },
        credentials: 'include', // incluir cookies CF
      });
      const xTotal      = r.headers.get('x-wp-total')      || '';
      const xTotalPages = r.headers.get('x-wp-totalpages') || '';
      const text        = await r.text();
      return { ok: r.ok, status: r.status, text, xTotal, xTotalPages, error: null };
    } catch(e) {
      return { ok: false, status: 0, text: '', xTotal: '', xTotalPages: '', error: e.message };
    }
  }, apiUrl);

  // Si CF bloqueó (respuesta HTML), refrescar sesión y reintentar una vez
  if (result.text && result.text.trimStart().startsWith('<') && !result.error) {
    console.log('[fetesa-cf] ⚠️ Respuesta HTML — refrescando sesión CF...');
    _sessionAt = 0; // forzar re-init
    await ensureSession();
    return _page.evaluate(async (url) => {
      try {
        const r = await fetch(url, {
          headers: { 'Accept': 'application/json, */*;q=0.8' },
          credentials: 'include',
        });
        const xTotal      = r.headers.get('x-wp-total')      || '';
        const xTotalPages = r.headers.get('x-wp-totalpages') || '';
        const text        = await r.text();
        return { ok: r.ok, status: r.status, text, xTotal, xTotalPages, error: null };
      } catch(e) {
        return { ok: false, status: 0, text: '', xTotal: '', xTotalPages: '', error: e.message };
      }
    }, apiUrl);
  }

  return result;
}

// Calentar sesión en background (llamar al inicio del servidor)
async function warmUp() {
  try {
    await ensureSession();
    console.log('[fetesa-cf] 🔥 Sesión precalentada');
  } catch(e) {
    console.log(`[fetesa-cf] ⚠️ Warmup falló: ${e.message}`);
  }
}

module.exports = { fetesaFetch, warmUp, closeSession };
