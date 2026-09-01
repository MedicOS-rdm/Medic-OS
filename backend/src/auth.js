import jwt from "jsonwebtoken";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const secretPath = path.join(__dirname, "..", ".jwt_secret");

// Genera (una sola vez) y reutiliza un secreto local para firmar los
// tokens, así las sesiones no se invalidan cada vez que reinicias el
// servidor en desarrollo. En producción, definir JWT_SECRET como variable
// de entorno fija (si no, cada despliegue en un host con disco efímero
// como Render genera un secreto nuevo y cierra la sesión de todos).
function loadOrCreateSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, "utf8").trim();
  const secret = crypto.randomBytes(48).toString("hex");
  fs.writeFileSync(secretPath, secret);
  return secret;
}

const JWT_SECRET = loadOrCreateSecret();

// ---------- Sesión vía cookie httpOnly (A-01, A-02) ----------
// Antes, el frontend guardaba el JWT en localStorage y lo mandaba también
// por query string (?token=...) para los enlaces de PDF — ambas cosas
// hacían que un XSS, el historial del navegador, logs de proxy o el header
// Referer pudieran filtrar una sesión completa de 12 horas. Ahora el JWT
// vive en una cookie httpOnly (JavaScript en el navegador no puede leerla,
// así que un XSS ya no puede robarla) y el backend deja de aceptar el
// token por query string por completo. SameSite=Lax además evita que un
// sitio externo pueda usar la cookie para disparar acciones de escritura
// (POST/PUT/DELETE) contra esta API.
export const AUTH_COOKIE_NAME = "medicos_session";
const COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // igual que expiresIn del JWT

export function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME, { path: "/" });
}

export function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      clinic_id: user.clinic_id,
      clinic_name: user.clinic_name,
      session_version: user.session_version ?? 0,
    },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  // Orden: cookie httpOnly (uso normal desde el navegador) primero, luego
  // Authorization: Bearer (para scripts/integraciones que no manejan
  // cookies). YA NO se acepta el token por query string bajo ninguna
  // circunstancia — quedaba expuesto en historial, logs de acceso y
  // encabezado Referer.
  const token = (req.cookies && req.cookies[AUTH_COOKIE_NAME]) || (header.startsWith("Bearer ") ? header.slice(7) : null);
  if (!token) return res.status(401).json({ error: "No autenticado" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Revocación de sesión (GRAVE de la auditoría): si la contraseña de
    // este usuario cambió después de que se emitió este token,
    // session_version ya no coincide y el token deja de servir de
    // inmediato, sin esperar a que expiren las 12 horas.
    const row = await db.prepare(`SELECT session_version FROM users WHERE id = ?`).get(payload.id);
    if (!row || row.session_version !== (payload.session_version ?? 0)) {
      return res.status(401).json({ error: "Sesión inválida o expirada" });
    }
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Sesión inválida o expirada" });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "No autenticado" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "No tienes permiso para esta acción" });
    }
    next();
  };
}

// Comparación en tiempo constante para secretos (ADMIN_SECRET, tokens de
// documento) — evita que una diferencia de tiempo entre intentos permita
// adivinar el secreto carácter por carácter (A-05).
export function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length) {
    // Igual se ejecuta una comparación de longitud fija para no filtrar
    // por timing si las longitudes difieren.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

