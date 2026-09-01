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
} from "../src/validators.js";

test("isValidIsoDate acepta AAAA-MM-DD y rechaza otros formatos", () => {
  assert.equal(isValidIsoDate("2026-08-30"), true);
  assert.equal(isValidIsoDate("30/08/2026"), false);
  assert.equal(isValidIsoDate("2026-8-30"), false);
  assert.equal(isValidIsoDate(""), false);
  assert.equal(isValidIsoDate(undefined), false);
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
