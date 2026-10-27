# 🦅 El Halcón — Ferretería

## Método de integración: API pública WooCommerce Store v1

El sitio `elhalcon.com.ni` corre **WooCommerce** y expone la **Store API v1** de forma pública (sin autenticación), a diferencia de la REST API `/wc/v3/` que requiere claves.

### Endpoint principal
```
https://elhalcon.com.ni/wp-json/wc/store/v1/products
```

| Parámetro | Descripción |
|-----------|-------------|
| `search`  | Texto libre para buscar por nombre |
| `per_page`| Resultados por página (máx. ~100) |
| `page`    | Número de página |
| `on_sale` | `true` → solo productos en oferta |

### Precios
Los precios vienen como **enteros en centavos** (NIO).  
`19829` → C$198.29 (dividir entre 100).

### Paginación
El servidor responde con headers HTTP:
- `X-WP-Total` → total de productos
- `X-WP-TotalPages` → total de páginas

### Proxy en server.js
Las peticiones del front-end van a `/api/elhalcon/...` y el `server.js` las reenvía a `elhalcon.com.ni` pasando también los headers de paginación.

---

## Archivos del módulo

```
ferreterias/elhalcon/
├── presupuestos/
│   ├── index.html   — Interfaz de búsqueda y presupuesto
│   ├── style.css    — Estilos (azul marino El Halcón)
│   └── app.js       — Lógica: búsqueda, modal, presupuesto
└── descuentos/
    ├── index.html   — Interfaz de ofertas
    ├── style.css    — Estilos
    └── app.js       — Carga todos los on_sale paginando
```

### URLs locales (server.js en puerto 3002)
- Presupuestos: http://localhost:3002/ferreterias/elhalcon/presupuestos/
- Descuentos:   http://localhost:3002/ferreterias/elhalcon/descuentos/

---

## Diferencias vs SINSA

| | SINSA | El Halcón |
|---|---|---|
| Plataforma | VTEX | WooCommerce |
| API | Intelligent Search VTEX | WooCommerce Store v1 |
| Auth | Pública | Pública |
| Precios | Valor real (C$) | Centavos (÷100) |
| Paginación | `recordsFiltered` en body | `X-WP-Total` en headers |
| Actualización | En tiempo real | En tiempo real ✅ |

## Diferencias vs FETESA

| | FETESA | El Halcón |
|---|---|---|
| Actualización | Manual (scraper + JSON) | **Automática via API** |
| Requiere server | Sí (para JSON) | Sí (proxy CORS) |
| Datos en vivo | No | **Sí** |

