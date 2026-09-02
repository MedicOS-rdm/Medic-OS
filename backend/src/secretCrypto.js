// GRAVE de la auditoría: "las credenciales de Twilio/SMTP se guardan en
// texto plano en la base de datos" — cualquiera con acceso de lectura a
// la base (un respaldo filtrado, un operador con más permisos de los que
// debería tener) podía leerlas directamente y usarlas para enviar
// mensajes o correos suplantando al consultorio. Ahora se cifran con
// AES-256-GCM antes de guardarse y se descifran solo en el momento de
// usarlas (para mandar el WhatsApp o el correo) — nunca se vuelven a
// mandar en texto plano hacia el navegador (ver routes/reminders.js y
// routes/notificationSettings.js, que ya enmascaraban el valor en las
// respuestas; ahora además el valor guardado en disco tampoco es legible
// directamente).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keyPath = path.join(__dirname, "..", ".secret_encryption_key");

// Igual que con JWT_SECRET (ver auth.js): si no defines APP_ENCRYPTION_KEY
// como variable de entorno, se genera una clave local una sola vez y se
// reutiliza. Advertencia real: en un host con disco efímero (como Render
// sin un volumen persistente), esa clave generada localmente NO sobrevive
// un redeploy — los secretos cifrados con la clave anterior quedarían
// ilegibles y habría que volver a escribir el token de Twilio / la
// contraseña SMTP desde la configuración. Para producción, definir
// APP_ENCRYPTION_KEY (32 bytes en base64: `openssl rand -base64 32`) evita
// ese problema por completo.
function loadOrCreateKey() {
  if (process.env.APP_ENCRYPTION_KEY) {
    const key = Buffer.from(process.env.APP_ENCRYPTION_KEY, "base64");
    if (key.length === 32) return key;
    // GRAVE de la auditoría ("preparación para producción regulada"): si
    // APP_ENCRYPTION_KEY viene definida pero no decodifica a exactamente
    // 32 bytes en base64 (por ejemplo, un valor generado automáticamente
    // por la plataforma de hosting con otro formato), antes se descartaba
    // por completo y se generaba una clave LOCAL en disco — justo el
    // problema que esta variable existe para evitar en hosts con disco
    // efímero (la clave "de emergencia" no sobrevive un redeploy). Ahora,
    // en vez de descartarla, se deriva una clave de 32 bytes válida a
    // partir del valor recibido (con SHA-256) — así cualquier valor no
    // vacío de APP_ENCRYPTION_KEY sigue siendo estable entre redeploys,
    // sin depender de que tenga el formato exacto.
    console.warn(
      "[secretCrypto] APP_ENCRYPTION_KEY no decodifica a 32 bytes en base64; derivando una clave estable a partir de su valor (en vez de generar una local efímera)."
    );
    return crypto.createHash("sha256").update(process.env.APP_ENCRYPTION_KEY).digest();
  }
  if (fs.existsSync(keyPath)) return Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64");
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString("base64"));
  return key;
}

const KEY = loadOrCreateKey();
const ALGO = "aes-256-gcm";
const PREFIX = "enc1:"; // permite reconocer valores ya cifrados vs. texto plano heredado de antes de este cambio

export function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptSecret(stored) {
  if (!stored) return stored;
  if (!stored.startsWith(PREFIX)) return stored; // valor heredado sin cifrar (de antes de este cambio) — se sigue leyendo tal cual
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch (err) {
    console.error("[secretCrypto] No se pudo descifrar un secreto guardado (¿cambió APP_ENCRYPTION_KEY?):", err.message);
    return "";
  }
}
