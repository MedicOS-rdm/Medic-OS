import jwt from "jsonwebtoken";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

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

export function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      clinic_id: user.clinic_id,
      clinic_name: user.clinic_name,
    },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.query.token || null;
  if (!token) return res.status(401).json({ error: "No autenticado" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
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
