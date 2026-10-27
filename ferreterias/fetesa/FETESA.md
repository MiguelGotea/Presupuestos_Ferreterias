# Módulo Fetesa — Guía de Operación

> Catálogo estático descargado localmente y publicado vía Git al VPS.

---

## ¿Cómo funciona?

Fetesa bloquea IPs de servidores cloud (DigitalOcean, AWS, etc.) mediante Cloudflare Turnstile, por lo que **no se puede hacer scraping desde el VPS**. La solución es:

```
PC Local  →  Scraper (Puppeteer)  →  productos.json  →  Git Push  →  GitHub Actions  →  VPS
```

1. El scraper corre en **tu PC** y descarga el catálogo completo de `fetesa.com.ni/tienda/`
2. Guarda todo en `ferreterias/fetesa/data/productos.json`
3. Haces un push normal con `gitpush.ps1`
4. GitHub Actions despliega automáticamente al VPS en ~30 segundos
5. Las páginas web leen el JSON estático — no hacen ninguna llamada en tiempo real a Fetesa

---

## Procedimiento de Actualización

### Paso 1 — Descargar el catálogo

Abre una terminal en la raíz del proyecto y ejecuta:

```powershell
node ferreterias/fetesa/scraper.js
```

- Recorre **todas las páginas** de `fetesa.com.ni/tienda/` sin límite
- Guarda los productos en `ferreterias/fetesa/data/productos.json`
- Puedes dejarlo corriendo en segundo plano por horas sin problema
- Si hay un error de red en alguna página, reintenta automáticamente 3 veces antes de saltar

**Ejemplo de salida esperada:**
```
══════════════════════════════════════════════
  🏗️  Fetesa Scraper — Descarga de catálogo
══════════════════════════════════════════════
  Modo completo: /tienda/ con paginación

  📂 Tienda completa (fetesa.com.ni/tienda/)
    🌐 https://fetesa.com.ni/tienda/
    📦 p1: 12 prods (acum 12)
    🌐 https://fetesa.com.ni/tienda/page/2/
    📦 p2: 12 prods (acum 24)
    ...
══════════════════════════════════════════════
  ✅ 1188 productos únicos
  🏷️  234 con descuento
  📄 ferreterias/fetesa/data/productos.json
══════════════════════════════════════════════
```

### Paso 2 — Publicar al VPS

```powershell
powershell -File .scripts\gitpush.ps1
```

- Hace commit + push a GitHub
- GitHub Actions despliega al VPS automáticamente (~30 seg)
- No es necesario hacer nada más en el servidor

---

## Modo búsqueda (opcional)

Para probar un término específico sin descargar todo:

```powershell
# Busca "pintura" en máximo 5 páginas
node ferreterias/fetesa/scraper.js pintura 5

# Busca "martillo" sin límite de páginas
node ferreterias/fetesa/scraper.js martillo
```

> [!NOTE]
> El modo búsqueda **reemplaza** el `productos.json` completo con solo los resultados de esa búsqueda. Úsalo solo para pruebas.

---

## Páginas publicadas

| URL | Descripción |
|-----|-------------|
| `/ferreterias/fetesa/presupuestos/` | Catálogo completo con buscador y cotizador |
| `/ferreterias/fetesa/descuentos/` | Solo productos con `listPrice > price` |

---

## Estructura de archivos

```
ferreterias/fetesa/
├── scraper.js              ← Ejecutable local de descarga
├── FETESA.md               ← Este archivo
├── data/
│   └── productos.json      ← Base de datos (se sube al repo)
├── presupuestos/
│   ├── index.html
│   ├── app.js
│   └── style.css
└── descuentos/
    ├── index.html
    ├── app.js
    └── style.css
```

---

## Formato del JSON

```json
{
  "generatedAt": "2026-10-27T14:01:36.702Z",
  "totalProducts": 1188,
  "withDiscount": 234,
  "products": [
    {
      "id":        "abanico-56-industrial-...",
      "name":      "ABANICO 56\" INDUSTRIAL REBEL III",
      "slug":      "abanico-56-industrial-...",
      "link":      "https://fetesa.com.ni/producto/...",
      "sku":       "72748",
      "cat":       "Ventilación",
      "price":     1250.00,
      "listPrice": 1500.00,
      "image":     "https://fetesa.com.ni/wp-content/...",
      "available": true
    }
  ]
}
```

- `listPrice > price` → producto tiene descuento activo
- `listPrice === 0` → no hay precio de lista, solo precio actual

---

## Consideraciones

> [!IMPORTANT]
> El scraper **debe correr desde tu PC local**, nunca desde el VPS. Fetesa bloquea IPs de datacenter.

> [!TIP]
> El catálogo de Fetesa tiene 100+ páginas (12 productos por página). Una descarga completa toma entre 20 y 40 minutos dependiendo de la velocidad de la conexión.

> [!WARNING]
> No abras `fetesa.com.ni` en el navegador mientras el scraper está corriendo — puede interferir con la sesión de Puppeteer.

