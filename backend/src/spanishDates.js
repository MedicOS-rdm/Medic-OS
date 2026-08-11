// Conversión de números a palabras en español, usada para escribir las
// fechas en letras dentro del certificado médico (ej. "QUINCE DE JULIO
// DEL DOS MIL VEINTISÉIS"), tal como se ve en los formatos reales de
// referencia.

const ONE_TO_29 = [
  "cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez",
  "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve", "veinte",
  "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve",
];
const TENS = ["", "", "veinte", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const HUNDREDS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];

function twoDigitWords(n) {
  if (n <= 29) return ONE_TO_29[n];
  const t = Math.floor(n / 10);
  const u = n % 10;
  return u === 0 ? TENS[t] : `${TENS[t]} y ${ONE_TO_29[u]}`;
}

function threeDigitWords(n) {
  if (n === 100) return "cien";
  const h = Math.floor(n / 100);
  const rest = n % 100;
  let out = h > 0 ? HUNDREDS[h] : "";
  if (rest > 0) out += (out ? " " : "") + twoDigitWords(rest);
  return out || "cero";
}

export function numberToSpanishWords(n) {
  if (n === 0) return "cero";
  if (n < 1000) return threeDigitWords(n);
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  let out = thousands === 1 ? "mil" : `${threeDigitWords(thousands)} mil`;
  if (rest > 0) out += ` ${threeDigitWords(rest)}`;
  return out;
}

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

// "2026-07-15" -> "QUINCE DE JULIO DEL DOS MIL VEINTISÉIS"
export function spellDateSpanish(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const dayWords = twoDigitWords(day);
  const monthName = MONTHS[month - 1] || "";
  const yearWords = numberToSpanishWords(year);
  return `${dayWords} DE ${monthName} DEL ${yearWords}`.toUpperCase();
}

// "2026-07-15" -> "15/07/2026"
export function formatDateSlashes(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}
