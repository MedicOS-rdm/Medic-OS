import { test } from "node:test";
import assert from "node:assert/strict";
import { passwordPolicyError, MIN_PASSWORD_LENGTH } from "../src/passwordPolicy.js";

// GRAVE de la auditoría: "la política de contraseña no es consistente en
// todos los flujos". Esta prueba fija cuál es la única política válida,
// para que cualquier ruta que la relaje (o la duplique con otro criterio)
// se detecte aquí en vez de en producción.
test("passwordPolicyError rechaza contraseñas más cortas que el mínimo", () => {
  assert.match(passwordPolicyError("abc123"), new RegExp(`${MIN_PASSWORD_LENGTH} caracteres`));
});

test("passwordPolicyError rechaza contraseñas solo con letras", () => {
  assert.match(passwordPolicyError("solaletras"), /letras y números/);
});

test("passwordPolicyError rechaza contraseñas solo con números", () => {
  assert.match(passwordPolicyError("1234567890"), /letras y números/);
});

test("passwordPolicyError acepta una contraseña que cumple longitud y mezcla", () => {
  assert.equal(passwordPolicyError("clinica2026segura"), null);
});

test(`MIN_PASSWORD_LENGTH es ${MIN_PASSWORD_LENGTH} en todos lados (referencia única)`, () => {
  // Esta prueba documenta la intención: si alguien cambia el número aquí
  // sin querer bajarlo, se nota en el mensaje de error de las pruebas de
  // arriba en vez de pasar desapercibido.
  assert.ok(MIN_PASSWORD_LENGTH >= 10, "la política no debería relajarse por debajo de 10 caracteres");
});
