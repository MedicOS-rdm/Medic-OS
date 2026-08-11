import { Router } from "express";
import { db, logAudit } from "../db.js";
import { requireRole } from "../auth.js";

export const patientsRouter = Router();

const CLINICAL_FIELDS = ["allergies", "chronic_conditions", "notes"];

function redactForRole(patient, role) {
  if (role === "medico") return patient;
  const copy = { ...patient };
  for (const f of CLINICAL_FIELDS) delete copy[f];
  return copy;
}

async function nextClinicalHistoryNumber(clinicId) {
  const rows = await db
    .prepare(`SELECT clinical_history_number FROM patients WHERE clinic_id = ? AND clinical_history_number IS NOT NULL`)
    .all(clinicId);
  let max = 0;
  for (const r of rows) {
    const n = parseInt(r.clinical_history_number, 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return String(max + 1).padStart(4, "0");
}

// GET /api/patients/next-history-number -> vista previa (no reserva el número)
patientsRouter.get("/next-history-number", async (req, res) => {
  res.json({ suggestion: await nextClinicalHistoryNumber(req.user.clinic_id) });
});

// GET /api/patients?q=texto  -> lista / búsqueda, SIEMPRE dentro de la clínica del usuario
patientsRouter.get("/", async (req, res) => {
  const { q } = req.query;
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = await db
      .prepare(
        `SELECT * FROM patients
         WHERE clinic_id = ? AND (first_name LIKE ? OR last_name LIKE ? OR phone LIKE ?)
         ORDER BY last_name, first_name`
      )
      .all(req.user.clinic_id, like, like, like);
  } else {
    rows = await db.prepare(`SELECT * FROM patients WHERE clinic_id = ? ORDER BY last_name, first_name`).all(req.user.clinic_id);
  }
  res.json(rows.map((p) => redactForRole(p, req.user.role)));
});

patientsRouter.get("/:id", async (req, res) => {
  const patient = await db.prepare(`SELECT * FROM patients WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!patient) return res.status(404).json({ error: "Paciente no encontrado" });
  res.json(redactForRole(patient, req.user.role));
});

patientsRouter.post("/", async (req, res) => {
  const body = { ...req.body };
  if (req.user.role !== "medico") {
    for (const f of CLINICAL_FIELDS) delete body[f];
  }
  const {
    first_name,
    last_name,
    birth_date,
    gender,
    phone,
    email,
    emergency_contact_name,
    emergency_contact_phone,
    blood_type,
    allergies,
    chronic_conditions,
    notes,
    id_number,
    address,
    workplace,
    job_title,
    clinical_history_number,
  } = body;

  if (!first_name || !last_name) {
    return res.status(400).json({ error: "first_name y last_name son obligatorios" });
  }

  const finalHistoryNumber =
    clinical_history_number && String(clinical_history_number).trim()
      ? String(clinical_history_number).trim()
      : await nextClinicalHistoryNumber(req.user.clinic_id);

  const result = await db
    .prepare(
      `INSERT INTO patients
        (clinic_id, first_name, last_name, birth_date, gender, phone, email,
         emergency_contact_name, emergency_contact_phone, blood_type,
         allergies, chronic_conditions, notes,
         id_number, address, workplace, job_title, clinical_history_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.clinic_id,
      first_name,
      last_name,
      birth_date ?? null,
      gender ?? null,
      phone ?? null,
      email ?? null,
      emergency_contact_name ?? null,
      emergency_contact_phone ?? null,
      blood_type ?? null,
      allergies ?? null,
      chronic_conditions ?? null,
      notes ?? null,
      id_number ?? null,
      address ?? null,
      workplace ?? null,
      job_title ?? null,
      finalHistoryNumber
    );

  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "create", entity: "patient", entityId: result.lastInsertRowid });
  const patient = await db.prepare(`SELECT * FROM patients WHERE id = ?`).get(result.lastInsertRowid);
  res.status(201).json(redactForRole(patient, req.user.role));
});

patientsRouter.put("/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM patients WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Paciente no encontrado" });

  const body = { ...req.body };
  if (req.user.role !== "medico") {
    for (const f of CLINICAL_FIELDS) delete body[f];
  }

  const merged = { ...existing, ...body };
  await db
    .prepare(
      `UPDATE patients SET
        first_name = ?, last_name = ?, birth_date = ?, gender = ?, phone = ?,
        email = ?, emergency_contact_name = ?, emergency_contact_phone = ?,
        blood_type = ?, allergies = ?, chronic_conditions = ?, notes = ?,
        id_number = ?, address = ?, workplace = ?, job_title = ?, clinical_history_number = ?,
        updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ? AND clinic_id = ?`
    )
    .run(
      merged.first_name,
      merged.last_name,
      merged.birth_date,
      merged.gender,
      merged.phone,
      merged.email,
      merged.emergency_contact_name,
      merged.emergency_contact_phone,
      merged.blood_type,
      merged.allergies,
      merged.chronic_conditions,
      merged.notes,
      merged.id_number,
      merged.address,
      merged.workplace,
      merged.job_title,
      merged.clinical_history_number,
      req.params.id,
      req.user.clinic_id
    );

  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "update", entity: "patient", entityId: req.params.id });
  const updated = await db.prepare(`SELECT * FROM patients WHERE id = ?`).get(req.params.id);
  res.json(redactForRole(updated, req.user.role));
});

patientsRouter.delete("/:id", requireRole("medico"), async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM patients WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Paciente no encontrado" });

  await db.prepare(`DELETE FROM patients WHERE id = ?`).run(req.params.id);
  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "delete", entity: "patient", entityId: req.params.id });
  res.status(204).end();
});
