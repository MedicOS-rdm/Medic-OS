// Prueba de integración real contra Postgres (CRÍTICO POTENCIAL de la
// auditoría: "el proyecto dispone de infraestructura transaccional... los
// flujos... pueden quedar parcialmente ejecutados"). A diferencia de las
// demás pruebas de esta carpeta, ESTA sí necesita una base de datos de
// verdad — no tiene sentido simular Postgres para probar que Postgres
// hace rollback correctamente. Por eso se salta automáticamente si no hay
// TEST_DATABASE_URL configurada (para no romper `npm test` en máquinas
// sin Postgres a mano); en CI, define TEST_DATABASE_URL apuntando a una
// base de pruebas desechable (nunca la de producción) para que corra.
import { test } from "node:test";
import assert from "node:assert/strict";

const canRun = Boolean(process.env.TEST_DATABASE_URL);

test(
  "withTransaction: aplica todo si no hay error",
  { skip: !canRun && "TEST_DATABASE_URL no está definida — prueba de integración omitida" },
  async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const { db, withTransaction } = await import("../src/db.js");
    await db.exec(`CREATE TEMP TABLE IF NOT EXISTS _tx_test (id SERIAL PRIMARY KEY, name TEXT)`);

    await withTransaction(async (tx) => {
      await tx.prepare(`INSERT INTO _tx_test (name) VALUES (?)`).run("uno");
      await tx.prepare(`INSERT INTO _tx_test (name) VALUES (?)`).run("dos");
    });

    const rows = await db.prepare(`SELECT * FROM _tx_test ORDER BY id`).all();
    assert.equal(rows.length, 2);
    await db.exec(`DROP TABLE _tx_test`);
  }
);

test(
  "withTransaction: revierte TODO si un paso intermedio falla",
  { skip: !canRun && "TEST_DATABASE_URL no está definida — prueba de integración omitida" },
  async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const { db, withTransaction } = await import("../src/db.js");
    await db.exec(`CREATE TEMP TABLE IF NOT EXISTS _tx_test2 (id SERIAL PRIMARY KEY, name TEXT)`);

    await assert.rejects(
      withTransaction(async (tx) => {
        await tx.prepare(`INSERT INTO _tx_test2 (name) VALUES (?)`).run("se-debe-revertir");
        // Columna inexistente a propósito: simula el paso intermedio que falla.
        await tx.prepare(`INSERT INTO _tx_test2 (columna_que_no_existe) VALUES (?)`).run("boom");
      })
    );

    const rows = await db.prepare(`SELECT * FROM _tx_test2`).all();
    assert.equal(rows.length, 0, "el insert anterior al fallo NO debió quedar guardado");
    await db.exec(`DROP TABLE _tx_test2`);
  }
);
