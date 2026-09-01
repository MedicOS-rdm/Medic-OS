import { Router } from "express";
import { db, logAudit, withTransaction, VALID_STATUSES } from "../db.js";

export const appointmentsRouter = Router();

// Código de error de Postgres para "exclusion_violation" — es lo que
// devuelve si el EXCLUDE constraint de la base de datos (ver db.js,
// appointments_no_overlap) frena un solapamiento que se hubiera colado
// pasando la validación de aplicación (la única forma real de dos
// solicitudes simultáneas: ambas pueden pasar el chequeo de abajo "al
// mismo tiempo", pero solo una logra el INSERT en la base).
const PG_EXCLUSION_VIOLATION = "23P01";

// CRÍTICO POTENCIAL de la auditoría: validación de disponibilidad antes
// de insertar/reagendar. Esto por sí solo NO es suficiente bajo
// concurrencia real (por eso también existe el EXCLUDE constraint en la
// base de datos) — pero sí da un mensaje de error claro en el caso común
// (sin condición de carrera), en vez de que el usuario solo vea un error
// genérico de base de datos.
async function findOverlap(clinicId, startTime, durationMinutes, excludeId) {
  const rows = await db
    .prepare(
      `SELECT id FROM appointments
       WHERE clinic_id = ? AND status <> 'cancelada' AND id <> ?
         AND start_time::timestamp < (?::timestamp + (?::text || ' minutes')::interval)
         AND (start_time::timestamp + (duration_minutes || ' minutes')::interval) > ?::timestamp
       LIMIT 1`
    )
    .get(clinicId, excludeId ?? -1, startTime, String(durationMinutes), startTime);
  return rows || null;
}

appointmentsRouter.get("/", async (req, res) => {
  const { date } = req.query;
  let rows;
  if (date) {
    rows = await db
      .prepare(
        `SELECT a.*, p.first_name, p.last_name, p.phone, p.allergies
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         WHERE a.clinic_id = ? AND a.start_time::date = ?::date
         ORDER BY a.start_time`
      )
      .all(req.user.clinic_id, date);
  } else {
    rows = await db
      .prepare(
        `SELECT a.*, p.first_name, p.last_name, p.phone, p.allergies
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         WHERE a.clinic_id = ?
         ORDER BY a.start_time`
      )
      .all(req.user.clinic_id);
  }
  if (req.user.role !== "medico") {
    rows = rows.map(({ allergies, ...rest }) => rest);
  }
  res.json(rows);
});

appointmentsRouter.post("/", async (req, res) => {
  const { patient_id, start_time, duration_minutes, visit_type, reason, notes } = req.body;

  if (!patient_id || !start_time) {
    return res.status(400).json({ error: "patient_id y start_time son obligatorios" });
  }

  const patient = await db.prepare(`SELECT id FROM patients WHERE id = ? AND clinic_id = ? AND status = 'activo'`).get(patient_id, req.user.clinic_id);
  if (!patient) return res.status(400).json({ error: "El paciente no existe o está archivado" });

  const duration = duration_minutes ?? (visit_type === "primera_vez" ? 45 : 20);
  if (!Number.isFinite(duration) || duration < 5 || duration > 480) {
    return res.status(400).json({ error: "La duración de la cita no es válida (5 a 480 minutos)" });
  }

  const overlap = await findOverlap(req.user.clinic_id, start_time, duration, null);
  if (overlap) {
    return res.status(409).json({ error: "Ese horario se traslapa con otra cita ya agendada. Elige otro horario." });
  }

  try {
    const apptId = await withTransaction(async (tx) => {
      const result = await tx
        .prepare(
          `INSERT INTO appointments
            (clinic_id, patient_id, start_time, duration_minutes, visit_type, reason, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(req.user.clinic_id, patient_id, start_time, duration, visit_type ?? "subsecuente", reason ?? null, notes ?? null);
      await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "create", entity: "appointment", entityId: result.lastInsertRowid, tx });
      return result.lastInsertRowid;
    });
    res.status(201).json(await db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(apptId));
  } catch (err) {
    // Red de seguridad para la carrera que el chequeo de arriba no puede
    // cerrar del todo: si dos solicitudes pasaron la validación casi al
    // mismo tiempo, la base de datos (EXCLUDE constraint) frena a la
    // segunda con este código de error — se traduce a un 409 legible en
    // vez de un 500 genérico.
    if (err.code === PG_EXCLUSION_VIOLATION) {
      return res.status(409).json({ error: "Ese horario se traslapa con otra cita ya agendada. Elige otro horario." });
    }
    throw err;
  }
});

appointmentsRouter.patch("/:id/status", async (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status inválido. Usa uno de: ${VALID_STATUSES.join(", ")}` });
  }

  const existing = await db.prepare(`SELECT * FROM appointments WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Cita no encontrada" });

  await withTransaction(async (tx) => {
    await tx
      .prepare(`UPDATE appointments SET status = ?, updated_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
      .run(status, req.params.id);
    await logAudit({
      clinicId: req.user.clinic_id,
      actor: req.user.username,
      action: "status_change",
      entity: "appointment",
      entityId: req.params.id,
      detail: { from: existing.status, to: status },
      tx,
    });
  });

  res.json(await db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(req.params.id));
});

// PUT /api/appointments/:id -> reagendar. Igual que al crear, se valida
// disponibilidad (excluyendo la cita propia de la comprobación).
appointmentsRouter.put("/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM appointments WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Cita no encontrada" });

  const merged = { ...existing, ...req.body };
  if (!Number.isFinite(Number(merged.duration_minutes)) || merged.duration_minutes < 5 || merged.duration_minutes > 480) {
    return res.status(400).json({ error: "La duración de la cita no es válida (5 a 480 minutos)" });
  }

  const overlap = await findOverlap(req.user.clinic_id, merged.start_time, merged.duration_minutes, existing.id);
  if (overlap) {
    return res.status(409).json({ error: "Ese horario se traslapa con otra cita ya agendada. Elige otro horario." });
  }

  try {
    await withTransaction(async (tx) => {
      await tx
        .prepare(
          `UPDATE appointments SET
            start_time = ?, duration_minutes = ?, visit_type = ?, reason = ?, notes = ?,
            updated_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS')
           WHERE id = ?`
        )
        .run(merged.start_time, merged.duration_minutes, merged.visit_type, merged.reason, merged.notes, req.params.id);
      await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "update", entity: "appointment", entityId: req.params.id, tx });
    });
  } catch (err) {
    if (err.code === PG_EXCLUSION_VIOLATION) {
      return res.status(409).json({ error: "Ese horario se traslapa con otra cita ya agendada. Elige otro horario." });
    }
    throw err;
  }
  res.json(await db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(req.params.id));
});

// DELETE /api/appointments/:id -> CRÍTICO de la auditoría: ya no borra la
// cita físicamente (podía tener recordatorios y ser parte de la
// trazabilidad de una atención). Ahora cancela, con motivo obligatorio,
// y el registro se conserva.
appointmentsRouter.delete("/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM appointments WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Cita no encontrada" });
  if (existing.status === "cancelada") return res.status(409).json({ error: "Esta cita ya estaba cancelada" });

  const reason = String(req.body?.reason || "").trim();
  if (reason.length < 5) {
    return res.status(400).json({ error: "Indica el motivo de la cancelación (mínimo 5 caracteres)" });
  }

  await withTransaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE appointments SET status = 'cancelada', cancel_reason = ?,
          updated_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id = ?`
      )
      .run(reason, req.params.id);
    await logAudit({
      clinicId: req.user.clinic_id,
      actor: req.user.username,
      action: "cancel",
      entity: "appointment",
      entityId: req.params.id,
      detail: { reason },
      tx,
    });
  });
  res.json(await db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(req.params.id));
});
