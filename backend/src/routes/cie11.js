import { Router } from "express";
import { db, dbCapabilities } from "../db.js";

export const cie11Router = Router();

// GET /api/cie11?q=diabet -> hasta 10 coincidencias por código o descripción.
// Consulta el catálogo CIE-10 en español (11,000+ códigos, ver
// backend/data/cie10-es.json y la siembra en backend/src/db.js) — todo
// local, sin llamadas a APIs externas en cada búsqueda.
//
// Dos mejoras sobre una simple LIKE:
// 1) Insensible a tildes si el servidor de Postgres lo permite (así
//    "infeccion" encuentra "Infección").
// 2) Coincidencia por palabras: "infeccion respiratoria" exige que
//    AMBAS palabras aparezcan en la descripción, no que estén pegadas
//    en ese orden exacto.
cie11Router.get("/", async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json([]);

  const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 6); // hasta 6 palabras, por seguridad
  const field = dbCapabilities.unaccent ? "unaccent(label)" : "label";
  const codeField = dbCapabilities.unaccent ? "unaccent(code)" : "code";
  const wrap = (w) => (dbCapabilities.unaccent ? `unaccent(?)` : "?");

  // Cada palabra debe aparecer en el nombre, O toda la consulta completa
  // debe aparecer en el código (para búsquedas tipo "J20.9").
  const labelConditions = words.map(() => `${field} ILIKE ${wrap()}`).join(" AND ");
  const sql = `
    SELECT code, label FROM cie11_catalog
    WHERE (${labelConditions}) OR ${codeField} ILIKE ${wrap()}
    ORDER BY length(label), label
    LIMIT 10
  `;
  const params = [...words.map((w) => `%${w}%`), `%${q.trim()}%`];

  const rows = await db.prepare(sql).all(...params);
  res.json(rows);
});
