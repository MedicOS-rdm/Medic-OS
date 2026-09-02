// Pruebas automatizadas reales, sin dependencias externas (usan el
// test runner incluido en Node, `node:test` — no requieren instalar
// jest/mocha). Ejecutar con: npm test (ver package.json).
//
// CRÍTICO de la auditoría: "No se identificaron pruebas automatizadas ni
// scripts de test". Este archivo cubre la lógica de validación clínica y
// de agenda que la auditoría señaló como riesgosa por falta de rangos y
// de protección contra solapamiento.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidIsoDate,
  validateVitals,
  computeBmi,
  daysBetweenInclusive,
  rangesOverlap,
  validatePrescriptionItem,
  validatePrescriptionItems,
  findDuplicateMedications,
  isValidOverrideReason,
  validateMinimumClinicalContent,
  isValidAdministrationRoute,
  findAllergyConflicts,
} from "../src/validators.js";

test("isValidIsoDate acepta AAAA-MM-DD y rechaza otros formatos", () => {
  assert.equal(isValidIsoDate("2026-08-30"), true);
  assert.equal(isValidIsoDate("30/08/2026"), false);
  assert.equal(isValidIsoDate("2026-8-30"), false);
  assert.equal(isValidIsoDate(""), false);
  assert.equal(isValidIsoDate(undefined), false);
});

// GRAVE de la auditoría ("las fechas se validan solo por formato y pueden
// aceptar fechas calendario imposibles"): antes de la corrección,
// "2026-02-31" pasaba porque `new Date(...)` la normalizaba en silencio a
// "2026-03-03" en vez de rechazarla.
test("isValidIsoDate rechaza fechas calendario imposibles aunque el formato sea correcto", () => {
  assert.equal(isValidIsoDate("2026-02-31"), false); // febrero no tiene día 31
  assert.equal(isValidIsoDate("2026-04-31"), false); // abril tiene 30 días
  assert.equal(isValidIsoDate("2026-13-01"), false); // mes 13 no existe
  assert.equal(isValidIsoDate("2026-00-10"), false); // mes 0 no existe
  assert.equal(isValidIsoDate("2026-06-00"), false); // día 0 no existe
});

test("isValidIsoDate acepta el 29 de febrero solo en años bisiestos", () => {
  assert.equal(isValidIsoDate("2024-02-29"), true); // 2024 es bisiesto
  assert.equal(isValidIsoDate("2026-02-29"), false); // 2026 no es bisiesto
});

test("validateVitals acepta signos vitales dentro de rango", () => {
  assert.equal(validateVitals({ heart_rate: 80, temperature_c: 36.5, weight_kg: 70, height_cm: 170, blood_pressure: "120/80" }), null);
});

test("validateVitals rechaza una frecuencia cardiaca imposible (A-07)", () => {
  const error = validateVitals({ heart_rate: 900 });
  assert.match(error, /frecuencia cardiaca/);
});

test("validateVitals rechaza una temperatura imposible", () => {
  const error = validateVitals({ temperature_c: 90 });
  assert.match(error, /temperatura/);
});

test("validateVitals rechaza presión arterial mal formada", () => {
  const error = validateVitals({ blood_pressure: "alta" });
  assert.match(error, /presión arterial/);
});

test("validateVitals ignora campos vacíos u omitidos (son opcionales)", () => {
  assert.equal(validateVitals({}), null);
  assert.equal(validateVitals({ heart_rate: "" }), null);
});

test("computeBmi calcula correctamente y redondea a 1 decimal", () => {
  // 70 kg, 1.70 m -> 24.2
  assert.equal(computeBmi(70, 170), 24.2);
});

test("computeBmi regresa null si falta peso o talla", () => {
  assert.equal(computeBmi(null, 170), null);
  assert.equal(computeBmi(70, null), null);
});

test("daysBetweenInclusive cuenta ambos extremos", () => {
  assert.equal(daysBetweenInclusive("2026-08-30", "2026-08-30"), 1);
  assert.equal(daysBetweenInclusive("2026-08-30", "2026-09-01"), 3);
});

test("daysBetweenInclusive regresa null si la fecha final es anterior a la inicial", () => {
  assert.equal(daysBetweenInclusive("2026-09-01", "2026-08-30"), null);
});

// CRÍTICO POTENCIAL de la auditoría: solapamiento de agenda. Estas
// pruebas fijan el razonamiento matemático; la aplicación real (a prueba
// de condiciones de carrera) vive en el EXCLUDE constraint de la base de
// datos — ver db.js y routes/appointments.js.
test("rangesOverlap detecta un traslape parcial", () => {
  const startA = new Date("2026-08-30T09:00:00Z").getTime();
  const endA = new Date("2026-08-30T09:20:00Z").getTime();
  const startB = new Date("2026-08-30T09:10:00Z").getTime();
  const endB = new Date("2026-08-30T09:30:00Z").getTime();
  assert.equal(rangesOverlap(startA, endA, startB, endB), true);
});

test("rangesOverlap no marca traslape cuando las citas son consecutivas (back-to-back)", () => {
  const startA = new Date("2026-08-30T09:00:00Z").getTime();
  const endA = new Date("2026-08-30T09:20:00Z").getTime();
  const startB = new Date("2026-08-30T09:20:00Z").getTime(); // empieza justo cuando termina la anterior
  const endB = new Date("2026-08-30T09:40:00Z").getTime();
  assert.equal(rangesOverlap(startA, endA, startB, endB), false);
});

test("rangesOverlap detecta cuando una cita contiene completamente a otra", () => {
  const startA = new Date("2026-08-30T09:00:00Z").getTime();
  const endA = new Date("2026-08-30T10:00:00Z").getTime();
  const startB = new Date("2026-08-30T09:15:00Z").getTime();
  const endB = new Date("2026-08-30T09:30:00Z").getTime();
  assert.equal(rangesOverlap(startA, endA, startB, endB), true);
});

test("rangesOverlap no marca traslape para horarios en días distintos", () => {
  const startA = new Date("2026-08-30T09:00:00Z").getTime();
  const endA = new Date("2026-08-30T09:20:00Z").getTime();
  const startB = new Date("2026-08-31T09:00:00Z").getTime();
  const endB = new Date("2026-08-31T09:20:00Z").getTime();
  assert.equal(rangesOverlap(startA, endA, startB, endB), false);
});

// ---------- CRÍTICO de la auditoría: "Prescripción demasiado permisiva" ----------
// Antes el backend solo exigía generic_name; estas pruebas fijan que
// ahora dosis, vía, frecuencia y duración/cantidad son obligatorias.

test("isValidAdministrationRoute acepta solo vías del catálogo conocido", () => {
  assert.equal(isValidAdministrationRoute("oral"), true);
  assert.equal(isValidAdministrationRoute("Oral"), true); // no distingue mayúsculas/tildes
  assert.equal(isValidAdministrationRoute("intravenosa"), true);
  assert.equal(isValidAdministrationRoute(""), false);
  assert.equal(isValidAdministrationRoute(undefined), false);
  assert.equal(isValidAdministrationRoute("por telepatía"), false);
});

test("validatePrescriptionItem exige generic_name, dosis, vía, frecuencia y (duración o cantidad)", () => {
  const complete = { generic_name: "Paracetamol", dose: "500 mg", route: "oral", frequency: "Cada 8 horas", duration: "5 días" };
  assert.equal(validatePrescriptionItem(complete), null);

  assert.match(validatePrescriptionItem({ ...complete, generic_name: "" }), /nombre genérico/);
  assert.match(validatePrescriptionItem({ ...complete, dose: "" }), /dosis/);
  assert.match(validatePrescriptionItem({ ...complete, route: "" }), /vía de administración/);
  assert.match(validatePrescriptionItem({ ...complete, frequency: "" }), /frecuencia/);
  assert.match(validatePrescriptionItem({ ...complete, duration: "", quantity: "" }), /duración del tratamiento o la cantidad/);
});

test("validatePrescriptionItem acepta cantidad total en vez de duración", () => {
  const item = { generic_name: "Amoxicilina", dose: "500 mg", route: "oral", frequency: "Cada 8 horas", quantity: "21 cápsulas" };
  assert.equal(validatePrescriptionItem(item), null);
});

test("validatePrescriptionItems rechaza lista vacía y listas demasiado largas", () => {
  assert.match(validatePrescriptionItems([]), /al menos un medicamento/);
  assert.match(validatePrescriptionItems(null), /al menos un medicamento/);
  const tooMany = Array.from({ length: 31 }, () => ({
    generic_name: "Paracetamol",
    dose: "500 mg",
    route: "oral",
    frequency: "Cada 8 horas",
    duration: "5 días",
  }));
  assert.match(validatePrescriptionItems(tooMany), /no puede tener más de 30/);
});

test("findDuplicateMedications detecta el mismo principio activo repetido", () => {
  const items = [{ generic_name: "Ibuprofeno" }, { generic_name: "ibuprofeno" }, { generic_name: "Paracetamol" }];
  const duplicates = findDuplicateMedications(items);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].generic_name, "ibuprofeno");
});

test("findDuplicateMedications no marca nada si no hay repetidos", () => {
  const items = [{ generic_name: "Ibuprofeno" }, { generic_name: "Paracetamol" }];
  assert.equal(findDuplicateMedications(items).length, 0);
});

// ---------- CRÍTICO de la auditoría: override de alergia trazable ----------

test("isValidOverrideReason exige un motivo con contenido real, no vacío ni trivial", () => {
  assert.equal(isValidOverrideReason("Paciente refiere que la alergia fue leve y ya resuelta"), true);
  assert.equal(isValidOverrideReason(""), false);
  assert.equal(isValidOverrideReason("ok"), false); // muy corto para ser un motivo real
  assert.equal(isValidOverrideReason(undefined), false);
  assert.equal(isValidOverrideReason("   "), false); // solo espacios
});

test("findAllergyConflicts detecta coincidencia entre el registro de alergias y un medicamento", () => {
  const conflicts = findAllergyConflicts("Penicilina", [{ generic_name: "Penicilina G" }, { generic_name: "Paracetamol" }]);
  assert.ok(conflicts.length >= 1);
  assert.equal(conflicts[0].medication, "Penicilina G");
});

test("findAllergyConflicts no encuentra nada si ningún medicamento coincide con el texto de alergias", () => {
  const conflicts = findAllergyConflicts("Penicilina", [{ generic_name: "Amoxicilina" }]);
  assert.equal(conflicts.length, 0);
});

// ---------- GRAVE de la auditoría: contenido clínico mínimo ----------

test("validateMinimumClinicalContent exige motivo de consulta, diagnóstico y plan", () => {
  assert.equal(
    validateMinimumClinicalContent({ chief_complaint: "Cefalea", diagnosis_code: "R51", plan: "Analgesia y control" }),
    null
  );
  assert.match(validateMinimumClinicalContent({ chief_complaint: "", diagnosis_code: "R51", plan: "x" }), /motivo de consulta/);
  assert.match(
    validateMinimumClinicalContent({ chief_complaint: "Cefalea", diagnosis_code: "", diagnosis_label: "", plan: "x" }),
    /diagnóstico/
  );
  assert.match(
    validateMinimumClinicalContent({ chief_complaint: "Cefalea", diagnosis_label: "Cefalea tensional", plan: "" }),
    /plan de manejo/
  );
});

test("validateMinimumClinicalContent acepta un diagnóstico solo por descripción (sin código)", () => {
  assert.equal(
    validateMinimumClinicalContent({ chief_complaint: "Cefalea", diagnosis_label: "Cefalea tensional", plan: "Analgesia" }),
    null
  );
});
