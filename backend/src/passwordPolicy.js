import crypto from "node:crypto";

// Política de contraseñas compartida por login/registro (auth.js,
// admin.js, users.js). Antes el mínimo era 6 caracteres sin ningún otro
// requisito — insuficiente para cuentas con acceso a expedientes clínicos
// (A-06 de la auditoría). Se sube a 10 caracteres y se exige mezclar
// letras y números, sin llegar a reglas tan estrictas que inviten a
// anotar la contraseña en un papel.
export const MIN_PASSWORD_LENGTH = 10;

export function passwordPolicyError(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "La contraseña debe combinar letras y números.";
  }
  return null;
}

// GRAVE de la auditoría: "restablecimiento de contraseñas con
// Math.random()" — Math.random() no es un generador criptográficamente
// seguro (es predecible si se conoce o se puede inferir el estado interno
// del motor JS) y, además, Math.random().toString(36).slice(-8) no
// garantiza una longitud fija (la cantidad de dígitos después del punto
// varía según el valor aleatorio obtenido). Este generador usa
// crypto.randomBytes (CSPRNG del sistema operativo) y arma la contraseña
// letra por letra desde un alfabeto fijo, así que SIEMPRE tiene
// exactamente `length` caracteres y, por construcción (se intercalan
// letras y dígitos), siempre cumple la política de arriba.
const LETTERS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"; // sin i/l/o/0/1 para evitar confusión visual
const DIGITS = "23456789";

export function generateSecurePassword(length = 14) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    // Alternar el alfabeto por posición garantiza mezcla de letras y
    // números sin importar qué toque al azar (cumple la política siempre,
    // no "con alta probabilidad").
    const alphabet = i % 3 === 0 ? DIGITS : LETTERS;
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}
