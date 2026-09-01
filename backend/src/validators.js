// Validadores puros (sin dependencias de base de datos ni de Express),
// reunidos aquí para poder probarlos con pruebas automatizadas reales
// (CRÍTICO de la auditoría: "no se identificaron pruebas automatizadas").
// Antes vivían duplicados/dispersos dentro de las rutas; centralizarlos
// también evita que certificates.js/consultations.js diverjan con el
// tiempo sobre qué formato de fecha o qué rango de un signo vital es
// válido.

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime());
}

// A-07 de la auditoría: rangos deliberadamente amplios (cubren casos
// clínicos extremos reales, no solo "lo normal") — la intención es
// atrapar errores de tipeo evidentes, no hacer juicios clínicos.
export const VITAL_RANGES = {
  heart_rate: { min: 20, max: 300, label: "la frecuencia cardiaca (lpm)" },
  temperature_c: { min: 25, max: 45, label: "la temperatura (°C)" },
  weight_kg: { min: 0.3, max: 400, label: "el peso (kg)" },
  height_cm: { min: 15, max: 250, label: "la talla (cm)" },
};
export const BLOOD_PRESSURE_RE = /^\d{2,3}\/\d{2,3}$/;

export function validateVitals(body) {
  for (const [field, range] of Object.entries(VITAL_RANGES)) {
    const value = body[field];
    if (value === undefined || value === null || value === "") continue;
    const num = Number(value);
    if (Number.isNaN(num) || num < range.min || num > range.max) {
      return `Revisa ${range.label}: el valor ingresado no parece válido.`;
    }
  }
  if (body.blood_pressure && !BLOOD_PRESSURE_RE.test(String(body.blood_pressure).trim())) {
    return 'La presión arterial debe tener el formato "120/80".';
  }
  return null;
}

export function computeBmi(weight_kg, height_cm) {
  if (!weight_kg || !height_cm) return null;
  const heightM = height_cm / 100;
  if (heightM <= 0) return null;
  return Math.round((weight_kg / (heightM * heightM)) * 10) / 10;
}

// Días entre dos fechas AAAA-MM-DD, ambas inclusive (para certificados:
// del 1 al 3 de un mes son 3 días, no 2).
export function daysBetweenInclusive(dateFrom, dateTo) {
  const from = new Date(`${dateFrom}T00:00:00Z`);
  const to = new Date(`${dateTo}T00:00:00Z`);
  const diffMs = to.getTime() - from.getTime();
  const days = Math.round(diffMs / (24 * 60 * 60 * 1000)) + 1;
  return days >= 1 ? days : null;
}

// GRAVE de la auditoría: "no hay alerta automática de alergias al emitir
// una receta". Comparación simple por texto (normalizando tildes/mayúsculas)
// entre lo que el paciente tiene anotado en "Alergias" y los medicamentos
// de la receta — es una alerta de confirmación para que el médico la vea
// a tiempo, NO un sistema de interacciones farmacológicas ni un bloqueo
// automático (el médico puede confirmar y seguir si, a su criterio
// clínico, corresponde).
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // quita tildes/diacríticos
}

export function findAllergyConflicts(allergiesText, items) {
  const allergyTokens = normalize(allergiesText)
    .split(/[,;\n]|(?:\by\b)/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3); // ignora fragmentos demasiado cortos (ruido, no palabras)

  if (allergyTokens.length === 0) return [];

  const conflicts = [];
  for (const item of items) {
    const medNames = [normalize(item.generic_name), normalize(item.commercial_name)].filter(Boolean);
    for (const allergy of allergyTokens) {
      const hit = medNames.some((med) => med.includes(allergy) || allergy.includes(med));
      if (hit) {
        conflicts.push({ allergy, medication: item.generic_name || item.commercial_name });
      }
    }
  }
  return conflicts;
}
// auditoría): dos intervalos semiabiertos [start, end) se traslapan si y
// solo si cada uno empieza antes de que el otro termine. La aplicación
// real de esta regla vive en SQL (routes/appointments.js + el EXCLUDE
// constraint de db.js, que sí son a prueba de condiciones de carrera);
// esta función existe para poder probar el RAZONAMIENTO con pruebas
// automatizadas simples, sin necesitar una base de datos.
export function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

export function addMinutes(isoLikeStart, minutes) {
  const start = new Date(isoLikeStart);
  return new Date(start.getTime() + minutes * 60000);
}
