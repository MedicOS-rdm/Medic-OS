// Validadores puros (sin dependencias de base de datos ni de Express),
// reunidos aquí para poder probarlos con pruebas automatizadas reales
// (CRÍTICO de la auditoría: "no se identificaron pruebas automatizadas").
// Antes vivían duplicados/dispersos dentro de las rutas; centralizarlos
// también evita que certificates.js/consultations.js diverjan con el
// tiempo sobre qué formato de fecha o qué rango de un signo vital es
// válido.

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// CORREGIDO (GRAVE de la auditoría): la versión anterior solo comprobaba el
// formato y usaba `new Date(...)`, que NORMALIZA fechas imposibles en vez de
// rechazarlas (ej. "2026-02-31" se convertía silenciosamente en "2026-03-03").
// Ahora se valida cada componente (año, mes, día) contra un calendario real:
// se arma la fecha y se comparan sus componentes YA NORMALIZADOS contra los
// que se pidieron originalmente — si no coinciden, es que la fecha pedida no
// existía en el calendario.
export function isValidIsoDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(d.getTime())) return false;
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
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

// Corrección funcional (rol "enfermera"): rangos clínicos para marcar un
// signo vital como ALTERADO (no confundir con VITAL_RANGES, que solo
// verifica que el dato ingresado sea físicamente plausible). Estos son
// umbrales generales de adulto — no ajustan por edad pediátrica ni
// condición previa del paciente; son una alerta visual de apoyo, nunca un
// diagnóstico ni un sustituto del criterio clínico del médico.
export function vitalsAlerts({ blood_pressure, heart_rate, temperature_c } = {}) {
  const alerts = [];
  if (heart_rate !== undefined && heart_rate !== null && heart_rate !== "") {
    const hr = Number(heart_rate);
    if (!Number.isNaN(hr) && (hr < 60 || hr > 100)) {
      alerts.push({ field: "heart_rate", message: hr < 60 ? "Frecuencia cardiaca baja (bradicardia)" : "Frecuencia cardiaca alta (taquicardia)" });
    }
  }
  if (temperature_c !== undefined && temperature_c !== null && temperature_c !== "") {
    const temp = Number(temperature_c);
    if (!Number.isNaN(temp) && (temp < 35.5 || temp > 37.5)) {
      alerts.push({ field: "temperature_c", message: temp > 37.5 ? "Temperatura elevada (fiebre)" : "Temperatura baja (hipotermia)" });
    }
  }
  if (blood_pressure && BLOOD_PRESSURE_RE.test(String(blood_pressure).trim())) {
    const [sys, dia] = String(blood_pressure).trim().split("/").map(Number);
    if (sys >= 140 || dia >= 90) {
      alerts.push({ field: "blood_pressure", message: "Presión arterial elevada (hipertensión)" });
    } else if (sys < 90 || dia < 60) {
      alerts.push({ field: "blood_pressure", message: "Presión arterial baja (hipotensión)" });
    }
  }
  return alerts;
}

// GRAVE de la auditoría ("las fechas se validan solo por formato y pueden
// aceptar fechas calendario imposibles"): centralizado aquí para que
// tanto el alta interna de pacientes (patients.js) como la reserva
// pública (publicBooking.js) validen la fecha de nacimiento exactamente
// igual, en vez de duplicar (y arriesgarse a desincronizar) la misma
// regla en dos archivos.
export function validateBirthDate(birth_date) {
  if (birth_date === undefined || birth_date === null || birth_date === "") return null;
  if (!isValidIsoDate(birth_date)) {
    return "birth_date no es una fecha calendario válida (formato AAAA-MM-DD).";
  }
  const today = new Date().toISOString().slice(0, 10);
  if (birth_date > today) {
    return "birth_date no puede ser una fecha futura.";
  }
  if (birth_date < "1900-01-01") {
    return "birth_date no es una fecha de nacimiento razonable.";
  }
  return null;
}

// Nueva página pública de reservas: horario semanal que configura el
// médico (0=domingo … 6=sábado, uno o más rangos ["HH:MM","HH:MM"] por
// día). Se valida aquí para poder probarlo aislado y para compartirlo
// entre doctorProfile.js (quien lo guarda) y publicBooking.js (quien lo
// usa para calcular turnos disponibles).
const WEEKDAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"];
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validateBookingSchedule(schedule) {
  if (schedule === null || schedule === undefined) return null; // sin horario configurado aún
  if (typeof schedule !== "object" || Array.isArray(schedule)) {
    return "El horario debe ser un objeto con un arreglo de rangos por cada día de la semana.";
  }
  for (const key of Object.keys(schedule)) {
    if (!WEEKDAY_KEYS.includes(key)) {
      return `Día de la semana inválido: "${key}" (usa 0=domingo … 6=sábado).`;
    }
    const ranges = schedule[key];
    if (!Array.isArray(ranges)) return `El horario del día ${key} debe ser un arreglo de rangos.`;
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2 || !HHMM_RE.test(range[0]) || !HHMM_RE.test(range[1])) {
        return `Uno de los rangos horarios del día ${key} no tiene el formato ["HH:MM","HH:MM"].`;
      }
      if (range[0] >= range[1]) {
        return `En el día ${key}, la hora de inicio (${range[0]}) debe ser antes que la de fin (${range[1]}).`;
      }
    }
  }
  return null;
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

// CRÍTICO de la auditoría ("Prescripción demasiado permisiva"): antes el
// backend solo exigía generic_name; dosis, vía, frecuencia y duración eran
// opcionales, por lo que podía emitirse una receta clínicamente incompleta
// (ej. un medicamento sin frecuencia). Ahora cada línea de una receta —tanto
// la creada manualmente en "Nueva receta" como la autogenerada desde el
// tratamiento de una consulta— exige el conjunto mínimo de datos para ser
// clínicamente utilizable de forma segura.
const ADMINISTRATION_ROUTES = new Set([
  "oral",
  "sublingual",
  "topica",
  "inhalada",
  "nasal",
  "oftalmica",
  "otica",
  "rectal",
  "vaginal",
  "intramuscular",
  "intravenosa",
  "subcutanea",
  "otra",
]);

export function isValidAdministrationRoute(route) {
  return ADMINISTRATION_ROUTES.has(normalize(route));
}

export function validatePrescriptionItem(item) {
  if (!item || typeof item !== "object") return "Cada medicamento debe ser un elemento válido.";
  if (typeof item.generic_name !== "string" || !item.generic_name.trim()) {
    return "Cada medicamento necesita un nombre genérico.";
  }
  const label = item.generic_name.trim();
  if (typeof item.dose !== "string" || !item.dose.trim()) {
    return `Falta la dosis por toma de ${label}.`;
  }
  if (!isValidAdministrationRoute(item.route)) {
    return `Falta o no es válida la vía de administración de ${label}.`;
  }
  if (typeof item.frequency !== "string" || !item.frequency.trim()) {
    return `Falta la frecuencia de ${label}.`;
  }
  const hasDuration = typeof item.duration === "string" && item.duration.trim();
  const hasQuantity = typeof item.quantity === "string" && item.quantity.trim();
  if (!hasDuration && !hasQuantity) {
    return `Falta la duración del tratamiento o la cantidad total a dispensar de ${label}.`;
  }
  return null;
}

export function validatePrescriptionItems(items) {
  if (!Array.isArray(items) || items.length === 0) return "Agrega al menos un medicamento.";
  if (items.length > 30) return "Una receta no puede tener más de 30 medicamentos.";
  for (const item of items) {
    const err = validatePrescriptionItem(item);
    if (err) return err;
  }
  return null;
}

// CRÍTICO de la auditoría ("no existe una barrera de seguridad
// farmacológica real"): esto NO es un motor de interacciones, contraindicaciones
// ni ajuste por edad/peso/función renal-hepática — eso requiere integrar una
// fuente farmacológica oficial licenciada y vigente, algo que está fuera del
// alcance de esta corrección de código. Lo que sí se agrega, honestamente
// acotado, es una detección de DUPLICIDAD TERAPÉUTICA simple (mismo
// principio activo repetido en la misma receta), como aviso, para que el
// catálogo local de ejemplo deje de dar una falsa sensación de seguridad.
export function findDuplicateMedications(items) {
  const seen = new Set();
  const duplicates = [];
  for (const item of items || []) {
    const key = normalize(item?.generic_name);
    if (!key) continue;
    if (seen.has(key)) {
      duplicates.push({ generic_name: item.generic_name });
    } else {
      seen.add(key);
    }
  }
  return duplicates;
}

// CRÍTICO de la auditoría ("el override nunca debe ser una bandera booleana
// sin trazabilidad"): cuando el médico decide continuar pese a una alerta de
// alergia, exigimos una razón clínica explícita y con contenido real, para
// que quede registrada en la bitácora de auditoría junto con el conflicto
// detectado — nunca solo un `true` suelto.
export const MIN_OVERRIDE_REASON_LENGTH = 10;
export function isValidOverrideReason(reason) {
  return typeof reason === "string" && reason.trim().length >= MIN_OVERRIDE_REASON_LENGTH;
}

// GRAVE de la auditoría ("la nota clínica completa puede guardarse
// prácticamente vacía"): exige un mínimo de contenido médico-legalmente
// razonable. No todos los campos del SOAP se exigen (algunos dependen del
// tipo de atención), pero motivo de consulta, algún diagnóstico (código o
// descripción) y un plan son el mínimo para que la nota tenga utilidad
// clínica real.
export function validateMinimumClinicalContent({ chief_complaint, diagnosis_code, diagnosis_label, plan }) {
  if (!chief_complaint || !String(chief_complaint).trim()) {
    return "El motivo de consulta es obligatorio.";
  }
  if ((!diagnosis_code || !String(diagnosis_code).trim()) && (!diagnosis_label || !String(diagnosis_label).trim())) {
    return "Registra al menos un diagnóstico (código CIE-10 o, en su defecto, una descripción).";
  }
  if (!plan || !String(plan).trim()) {
    return "El plan de manejo/tratamiento es obligatorio.";
  }
  return null;
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
