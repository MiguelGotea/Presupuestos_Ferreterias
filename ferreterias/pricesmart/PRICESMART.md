# Módulo PriceSmart Nicaragua

## Método de integración: catálogo estático desde las categorías públicas

PriceSmart no tiene una API pública equivalente a la Store API de WooCommerce. El sitio funciona con servicios internos de **Commercetools** y **Bloomreach Discovery**; los datos de catálogo se entregan al navegador junto con la configuración interna de cada canal. No es una interfaz estable ni autorizada para ser consultada directamente desde el VPS.

Se replica por ello el patrón de **Fetesa**:

```
PC local → Puppeteer → productos.json → Git push → deploy → páginas estáticas
```

El descargador abre el menú público de categorías, recorre sus páginas y elimina productos repetidos entre categorías. La fuente de promociones sigue siendo [Ahorros del Fabricante](https://www.pricesmart.com/es-ni/ahorros-del-fabricante), la cual se combina con el catálogo general. En cada tarjeta pública se extraen:

- identificador y enlace del producto;
- nombre, imagen y disponibilidad;
- precio vigente (`price`);
- precio anterior (`listPrice`), cuando PriceSmart lo publique;
- etiqueta de promoción.

La página de descuentos muestra exclusivamente los artículos de esa campaña oficial. Si `listPrice > price`, calcula porcentaje y ahorro; si el sitio no publica el precio anterior (como puede ocurrir en una campaña vigente), muestra la promoción sin inventar un descuento.

## Actualización

Desde la raíz del proyecto:

```powershell
node ferreterias/pricesmart/scraper.js
powershell -File .scripts\gitpush.ps1
```

El descargador recorre automáticamente las categorías y sus páginas públicas, combina las promociones y reemplaza `data/productos.json`. Debe ejecutarse en un equipo local antes de publicar, igual que Fetesa. Una descarga completa puede tardar varios minutos.

Si PriceSmart no responde, cada página tiene un límite de 3 minutos y hasta 5 reintentos. El avance se guarda en `data/catalog-progress.json`; vuelve a ejecutar el mismo comando para reanudar exactamente en la página que falló. El descargador no omite páginas con errores, para no producir un catálogo incompleto.

## Rutas

- `/ferreterias/pricesmart/presupuestos/` — búsqueda y presupuesto con el catálogo publicado.
- `/ferreterias/pricesmart/descuentos/` — productos de la campaña Ahorros del Fabricante, con porcentaje cuando PriceSmart publica el precio anterior.
