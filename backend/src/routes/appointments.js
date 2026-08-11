import { Router } from "express";
import { db, logAudit, VALID_STATUSES } from "../db.js";

export const appointmentsRouter = Router();

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

  const patient = await db.prepare(`SELECT id FROM patients WHERE id = ? AND clinic_id = ?`).get(patient_id, req.user.clinic_id);
  if (!patient) return res.status(400).json({ error: "El paciente no existe" });

  const duration = duration_minutes ?? (visit_type === "primera_vez" ? 45 : 20);

  const result = await db
    .prepare(
      `INSERT INTO appointments
        (clinic_id, patient_id, start_time, duration_minutes, visit_type, reason, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.clinic_id, patient_id, start_time, duration, visit_type ?? "subsecuente", reason ?? null, notes ?? null);

  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "create", entity: "appointment", entityId: result.lastInsertRowid });
  const appt = await db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(result.lastInsertRowid);
  res.status(201).json(appt);
});

appointmentsRouter.patch("/:id/status", async (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status inválido. Usa uno de: ${VALID_STATUSES.join(", ")}` });
  }

  const existing = await db.prepare(`SELECT * FROM appointments WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Cita no encontrada" });

  await db
    .prepare(`UPDATE appointments SET status = ?, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
    .run(status, req.params.id);

  await logAudit({
    clinicId: req.user.clinic_id,
    actor: req.user.username,
    action: "status_change",
    entity: "appointment",
    entityId: req.params.id,
    detail: { from: existing.status, to: status },
  });

  res.json(await db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(req.params.id));
});

appointmentsRouter.put("/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM appointments WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Cita no encontrada" });

  const merged = { ...existing, ...req.body };
  await db
    .prepare(
      `UPDATE appointments SET
        start_time = ?, duration_minutes = ?, visit_type = ?, reason = ?, notes = ?,
        updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ?`
    )
    .run(merged.start_time, merged.duration_minutes, merged.visit_type, merged.reason, merged.notes, req.params.id);

  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "update", entity: "appointment", entityId: req.params.id });
  res.json(await db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(req.params.id));
});

appointmentsRouter.delete("/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM appointments WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Cita no encontrada" });

  await db.prepare(`DELETE FROM appointments WHERE id = ?`).run(req.params.id);
  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "delete", entity: "appointment", entityId: req.params.id });
  res.status(204).end();
});
