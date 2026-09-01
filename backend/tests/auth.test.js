import { test } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqualString } from "../src/auth.js";

// A-05 de la auditoría: comparación de secretos en tiempo constante.
test("timingSafeEqualString: iguales -> true", () => {
  assert.equal(timingSafeEqualString("s3cr3t-admin", "s3cr3t-admin"), true);
});

test("timingSafeEqualString: distintos (misma longitud) -> false", () => {
  assert.equal(timingSafeEqualString("s3cr3t-admin", "otro-secreto"), false);
});

test("timingSafeEqualString: longitudes distintas -> false (sin lanzar)", () => {
  assert.equal(timingSafeEqualString("corto", "un-secreto-mucho-más-largo"), false);
});

test("timingSafeEqualString: valores vacíos/indefinidos no truenan", () => {
  assert.equal(timingSafeEqualString(undefined, undefined), true);
  assert.equal(timingSafeEqualString("algo", undefined), false);
});
