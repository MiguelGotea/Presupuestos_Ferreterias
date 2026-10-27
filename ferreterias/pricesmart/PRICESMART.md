# Módulo PriceSmart Nicaragua

## Método de integración: catálogo estático desde la página pública de promociones

PriceSmart no tiene una API pública equivalente a la Store API de WooCommerce. El sitio funciona con servicios internos de **Commercetools** y **Bloomreach Discovery**; los datos de catálogo se entregan al navegador junto con la configuración interna de cada canal. No es una interfaz estable ni autorizada para ser consultada directamente desde el VPS.

Se replica por ello el patrón de **Fetesa**:

```
PC local → Puppeteer → productos.json → Git push → deploy → páginas estáticas
```

La fuente es [Ahorros del Fabricante](https://www.pricesmart.com/es-ni/ahorros-del-fabricante). En cada tarjeta pública se extraen:

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

El descargador recorre automáticamente las páginas disponibles de la fuente y reemplaza `data/productos.json`. Debe ejecutarse en un equipo local antes de publicar, igual que Fetesa.

## Rutas

- `/ferreterias/pricesmart/presupuestos/` — búsqueda y presupuesto con el catálogo publicado.
- `/ferreterias/pricesmart/descuentos/` — solamente productos con precio anterior mayor al actual.
