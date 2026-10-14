// fetesa-cf.js — Resuelve el Cloudflare JS Challenge de fetesa.com.ni
// usando Puppeteer (headless Chrome). Cachea cf_clearance ~50 min.
//
// Usa el mismo setup de Chrome/Puppeteer que ya funciona en este VPS
// (copiado de wsp-clientes/src/whatsapp/client.js).
//
// REQUISITOS (ya instalados en el VPS por wsp-clientes):
//   puppeteer ^21.0.0  (en node_modules del proyecto, o global)
//   /usr/bin/google-chrome-stable  o  /usr/bin/chromium

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Detectar Chrome (mismo orden que wsp-clientes) ─────────────────────────
const CHROME_PATHS = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

function findChromePath() {
  return CHROME_PATHS.find(p => fs.existsSync(p)) || null;
}

// ── Args de Chrome probados y funcionales en el VPS (de wsp-clientes) ──────
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  // Prevenir throttling que causa timeouts en background
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--no-zygote',
  '--no-first-run',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-breakpad',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess',
];

// ── Cache de cf_clearance ───────────────────────────────────────────────────
let _cfCookies   = null;  // string completo "name=val; name2=val2"
let _cfExpiry    = 0;
let _refreshing  = false;
let _refreshQueue = [];

// ── Obtener puppeteer (del proyecto o del wsp-clientes vecino) ──────────────
function getPuppeteer() {
  // 1. Del propio proyecto (si se instaló)
  try { return require('puppeteer'); } catch(_) {}
  try { return require('puppeteer-core'); } catch(_) {}

  // 2. Del node_modules de wsp-clientes (mismo VPS)
  const wspPuppeteer = path.resolve(__dirname, '../PitayaBot/wsp-clientes/node_modules/puppeteer');
  try { return require(wspPuppeteer); } catch(_) {}

  throw new Error(
    'puppeteer no encontrado. Ejecuta en el directorio del proyecto:\n' +
    '  npm install puppeteer\n' +
    'O está disponible en PitayaBot/wsp-clientes si agregas el path correcto.'
  );
}

// ── Lanzar Chrome y obtener cookies de Cloudflare ──────────────────────────
async function refreshCfCookies() {
  const puppeteer = getPuppeteer();
  const executablePath = findChromePath();

  if (!executablePath) {
    throw new Error(
      'Chrome/Chromium no encontrado en el sistema.\n' +
      'Rutas buscadas: ' + CHROME_PATHS.join(', ')
    );
  }

  console.log(`[fetesa-cf] 🌐 Lanzando Chrome (${executablePath}) para resolver CF challenge...`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: CHROME_ARGS,
    timeout: 30000,
  });

  try {
    const page = await browser.newPage();

    // UA idéntico al que usa wsp-clientes para consistencia
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Cargar homepage para resolver el JS challenge de Cloudflare.
    // ⚠️ NO usar 'networkidle2' — el JS Challenge hace muchos requests y
    //    supera el timeout. Usamos 'domcontentloaded' + espera manual.
    console.log('[fetesa-cf] 🔄 Cargando fetesa.com.ni...');
    try {
      await page.goto('https://fetesa.com.ni/', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
    } catch (navErr) {
      // Incluso si hay timeout en la navegación, el CF challenge puede
      // haber establecido cookies ya. Continuamos y verificamos.
      console.log(`[fetesa-cf] ⚠️ Navigation warn: ${navErr.message} — verificando cookies igualmente...`);
    }

    // Esperar hasta 20 segundos a que CF resuelva el challenge y setee cf_clearance
    console.log('[fetesa-cf] ⏳ Esperando resolución del CF challenge...');
    let allCookies = [];
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      allCookies = await page.cookies('https://fetesa.com.ni').catch(() => []);
      const hasClearance = allCookies.some(c => c.name === 'cf_clearance');
      if (hasClearance) {
        console.log(`[fetesa-cf] ✅ cf_clearance obtenido en ${i + 1}s`);
        break;
      }
      if (i % 5 === 4) console.log(`[fetesa-cf] ... esperando CF (${i + 1}s)`);
    }

    if (!allCookies.length) {
      throw new Error('No se obtuvieron cookies de fetesa.com.ni');
    }

    // Construir string de cookies para el header Cookie: de curl
    const cookieStr = allCookies
      .filter(c => c.name && c.value)
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    const hasClearance = allCookies.some(c => c.name === 'cf_clearance');
    const ttl = hasClearance ? 50 * 60 * 1000 : 5 * 60 * 1000; // 50 min / 5 min sin clearance

    _cfCookies = cookieStr;
    _cfExpiry  = Date.now() + ttl;

    console.log(`[fetesa-cf] ✅ Cookies guardadas. cf_clearance: ${hasClearance ? 'SÍ' : 'NO'}. TTL: ${ttl / 60000} min`);
    return cookieStr;

  } finally {
    await browser.close();
    console.log('[fetesa-cf] 🔒 Chrome cerrado.');
  }
}

// ── API pública ─────────────────────────────────────────────────────────────

/**
 * Obtiene el string de cookies CF válidas (del cache o renovando con Chrome).
 * Las peticiones concurrentes se encolan y comparten el mismo refresh.
 */
async function getCfCookie() {
  // Cache válido
  if (_cfCookies && Date.now() < _cfExpiry) return _cfCookies;

  // Ya hay un refresh en curso — encolar
  if (_refreshing) {
    return new Promise((resolve, reject) => _refreshQueue.push({ resolve, reject }));
  }

  _refreshing = true;
  try {
    const cookies = await refreshCfCookies();
    _refreshQueue.forEach(p => p.resolve(cookies));
    return cookies;
  } catch(e) {
    _refreshQueue.forEach(p => p.reject(e));
    throw e;
  } finally {
    _refreshing = false;
    _refreshQueue = [];
  }
}

/** Fuerza renovación en la próxima petición */
function invalidateCfCache() {
  _cfCookies = null;
  _cfExpiry  = 0;
  console.log('[fetesa-cf] 🔄 Cache CF invalidado — próxima petición abrirá Chrome.');
}

module.exports = { getCfCookie, invalidateCfCache };
