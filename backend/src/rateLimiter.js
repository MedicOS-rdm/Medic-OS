// Limitador de tasa simple, en memoria, sin depender de un paquete nuevo
// (A-04 de la auditoría: no había ninguna defensa contra fuerza bruta en
// login ni en endpoints sensibles).
//
// Limitación consciente: al vivir en memoria del proceso, el conteo se
// reinicia si el servidor se reinicia, y en un despliegue con más de una
// instancia cada una llevaría su propio conteo (no es un límite
// perfectamente distribuido). Para el tamaño de esta aplicación (un
// proceso Node por despliegue en Render) es una mejora real y suficiente
// sobre "ningún límite"; si en el futuro se corre más de una instancia,
// conviene mover esto a un almacén compartido (ej. Redis).
const buckets = new Map(); // key -> { count, resetAt }

function keyFor(req, prefix) {
  // req.ip ya refleja la IP real del cliente detrás del proxy de Render
  // gracias a `app.set("trust proxy", 1)` en server.js.
  return `${prefix}:${req.ip}`;
}

// Limpieza periódica para no acumular memoria indefinidamente con IPs que
// ya no vuelven a pegarle al endpoint.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

// windowMs: ventana de tiempo; max: intentos permitidos dentro de la
// ventana antes de responder 429. Cada intento fallido cuenta; los
// exitosos también consumen cupo (así un atacante no puede "gastar"
// requests exitosos gratis), pero la ventana es lo bastante amplia para
// uso normal.
export function rateLimit({ windowMs, max, message }) {
  return (req, res, next) => {
    const key = keyFor(req, req.baseUrl + req.path);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: message || "Demasiados intentos. Intenta de nuevo más tarde." });
    }
    next();
  };
}

// Preajustes usados en varias rutas.
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Demasiados intentos de inicio de sesión. Espera unos minutos e inténtalo de nuevo.",
});

export const adminRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Demasiadas solicitudes al panel de administración. Espera unos minutos.",
});

export const webhookRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: "Demasiadas solicitudes.",
});

// GRAVE de la auditoría ("privacidad y compartición de documentos"): las
// rutas públicas de verificación por QR (/api/verify) y de descarga del
// PDF compartido (/api/share) no tenían ningún límite de tasa — nada
// impedía automatizar miles de intentos por minuto para "pescar" tokens
// válidos al azar, ni frenaba un scraping masivo de documentos aunque el
// token en sí sea largo y aleatorio. Se limita por IP igual que el resto
// de endpoints públicos sensibles.
export const publicDocumentRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 40,
  message: "Demasiadas solicitudes a este enlace. Espera unos minutos.",
});
