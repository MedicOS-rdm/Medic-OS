import "dotenv/config";
import "express-async-errors"; // permite que errores en handlers async lleguen al middleware de error sin try/catch manual en cada ruta
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { initDb } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { adminRateLimit } from "./rateLimiter.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { verifyRouter } from "./routes/verify.js";
import { usersRouter } from "./routes/users.js";
import { patientsRouter } from "./routes/patients.js";
import { appointmentsRouter } from "./routes/appointments.js";
import { consultationsRouter } from "./routes/consultations.js";
import { cie11Router } from "./routes/cie11.js";
import { medicationsRouter } from "./routes/medications.js";
import { doctorProfileRouter } from "./routes/doctorProfile.js";
import { prescriptionsRouter } from "./routes/prescriptions.js";
import { certificatesRouter } from "./routes/certificates.js";
import { shareRouter } from "./routes/share.js";
import { notificationSettingsRouter } from "./routes/notificationSettings.js";
import { remindersRouter, remindersWebhookRouter } from "./routes/reminders.js";
import { checkAndSendDueReminders } from "./reminders.js";

const app = express();
const PORT = process.env.PORT || 4000;

// Render (y la mayoría de PaaS) terminan TLS en un proxy y reenvían la
// petición por HTTP interno agregando X-Forwarded-*. Sin esto, req.protocol
// siempre da "http" y req.ip da la IP del proxy en vez de la del cliente
// real — lo primero rompe la validación de firma de Twilio (que firma la
// URL https:// pública) y lo segundo inutiliza el rate limiting por IP.
app.set("trust proxy", 1);

// CORS restringido en vez del wildcard por defecto (M-07): el frontend
// siempre se sirve desde el MISMO origen que la API (un solo servicio en
// producción; el proxy de Vite en desarrollo), así que no hace falta
// permitir orígenes cruzados para que la app funcione. Si se define
// FRONTEND_ORIGIN (por si algún día el frontend vive en otro dominio), se
// permite ese origen puntual con credenciales; si no, no se habilita CORS
// de navegador para /api en absoluto (llamadas desde otros sitios web
// quedan bloqueadas por el navegador; clientes no-navegador como Twilio o
// scripts propios no se ven afectados, CORS solo lo aplican los navegadores).
const allowedOrigin = process.env.FRONTEND_ORIGIN || null;
if (allowedOrigin) {
  app.use(cors({ origin: allowedOrigin, credentials: true }));
}

// Límite elevado (por defecto Express solo permite 100 KB) para poder
// subir el logo del consultorio como base64 dentro del JSON — el propio
// endpoint de logo valida además que el archivo original no pase de 2 MB.
app.use(express.json({ limit: "3mb" }));
app.use(express.urlencoded({ extended: false })); // Twilio manda application/x-www-form-urlencoded

// Parser mínimo de cookies (sin agregar el paquete cookie-parser): solo
// necesitamos leer la cookie httpOnly de sesión (ver auth.js). Rellena
// req.cookies como un objeto plano { nombre: valor }, igual que hace
// cookie-parser para el caso sin firma.
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (name) req.cookies[name] = decodeURIComponent(value);
    }
  }
  next();
});

// Cabeceras de seguridad básicas en todas las respuestas (mitigación
// menor pero gratuita: X-Content-Type-Options, política de iframes, y un
// CSP razonable para una app que ya no depende de scripts/estilos
// inline de terceros).
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});

// Log simple de acceso (usuario si ya se autenticó, IP y ruta) — la
// bitácora de auditoría fina por entidad vive en la tabla audit_log.
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} desde ${req.ip}`);
  next();
});

// ---------- Rutas públicas (sin sesión de médico/secretaria) ----------
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRateLimit, adminRouter); // protegida por ADMIN_SECRET (rate-limited), no por login normal
app.use("/api/verify", verifyRouter); // lo escanea el QR de la receta
app.use("/api/share", shareRouter); // PDF público de UNA receta/certificado (lo descarga WhatsApp)
app.use("/api/reminders", remindersWebhookRouter); // lo llama Twilio (respuestas 1/2)

// ---------- A partir de aquí, todo requiere sesión de médico/secretaria ----------
app.use("/api", requireAuth);

// Agenda y pacientes: ambos roles (secretaria y médico), siempre acotado a
// la clínica del usuario logueado. El filtrado de campos clínicos para la
// secretaria ocurre dentro de patientsRouter.
app.use("/api/patients", patientsRouter);
app.use("/api/appointments", appointmentsRouter);
app.use("/api", remindersRouter); // configuración + envío manual de recordatorios

// Perfil del médico: lectura para ambos roles, escritura solo médico
// (se controla dentro de doctorProfileRouter). Una fila por clínica.
app.use("/api/doctor-profile", doctorProfileRouter);

// Exclusivo del médico: expediente clínico, recetas.
app.use("/api/prescriptions", requireRole("medico"), prescriptionsRouter);
app.use("/api/certificates", requireRole("medico"), certificatesRouter);
app.use("/api", requireRole("medico"), consultationsRouter);
app.use("/api", requireRole("medico"), notificationSettingsRouter); // envío automático de recetas/certificados

// Catálogos compartidos (CIE-10, medicamentos): solo médico, pero NO están
// acotados por clínica porque son datos de referencia, no de pacientes.
app.use("/api/cie11", requireRole("medico"), cie11Router);
app.use("/api/medications", requireRole("medico"), medicationsRouter);

// Gestión de cuentas de secretaria: exclusivo del médico, dentro de su propia clínica.
app.use("/api/users", requireRole("medico"), usersRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor" });
});

// ---------- Servir el frontend compilado (despliegue de un solo servicio) ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDist = path.join(__dirname, "..", "..", "frontend", "dist");
if (fs.existsSync(frontendDist)) {
  // admin.html cambia poco a poco pero es crítico que SIEMPRE se sirva la
  // versión más reciente (nunca una copia vieja cacheada por el navegador),
  // así que la servimos explícitamente con "no cache" antes del estático.
  app.get("/admin.html", (_req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(frontendDist, "admin.html"));
  });
  app.use(express.static(frontendDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

// initDb() crea las tablas (si no existen) y siembra los catálogos antes
// de aceptar tráfico. Si la base de datos no está disponible (ej.
// DATABASE_URL mal configurada), el proceso falla rápido con un mensaje
// claro en vez de arrancar a medias.
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API de Agenda escuchando en http://localhost:${PORT}`);
    });

    // Revisa cada 15 minutos si hay citas (en cualquier clínica con
    // recordatorios activados) que ya entraron en su ventana de
    // recordatorio y las envía. Limitación del MVP: solo funciona
    // mientras este proceso esté vivo; en producción conviene un
    // cron/worker aparte.
    setInterval(() => {
      checkAndSendDueReminders().catch((err) => console.error("Error en checkAndSendDueReminders:", err));
    }, 15 * 60 * 1000);
    setTimeout(() => {
      checkAndSendDueReminders().catch((err) => console.error("Error en checkAndSendDueReminders:", err));
    }, 5000);
  })
  .catch((err) => {
    console.error("No se pudo inicializar la base de datos:", err);
    process.exit(1);
  });
