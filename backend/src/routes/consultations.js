import { Router } from "express";
import { db, logAudit, newQrToken } from "../db.js";

export const consultationsRouter = Router();

function computeBmi(weight_kg, height_cm) {
  if (!weight_kg || !height_cm) return null;
  const heightM = height_cm / 100;
  if (heightM <= 0) return null;
  return Math.round((weight_kg / (heightM * heightM)) * 10) / 10;
}

// Campos JSON: guardamos como texto y parseamos al leer. Si llega algo
// inválido (o vacío), lo tratamos como "sin datos" en vez de tronar.
function toJson(value) {
  if (value === undefined || value === null) return null;
  const str = JSON.stringify(value);
  return str === "[]" || str === "{}" ? null : str;
}
function fromJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function hydrateConsultation(row) {
  if (!row) return row;
  return {
    ...row,
    physical_exam: fromJson(row.physical_exam_json, null),
    additional_diagnoses: fromJson(row.additional_diagnoses_json, []),
    treatment_meds: fromJson(row.treatment_meds_json, []),
    studies_lab: fromJson(row.studies_lab_json, []),
    studies_imaging: fromJson(row.studies_imaging_json, []),
  };
}

consultationsRouter.get("/patients/:patientId/consultations", async (req, res) => {
  const patient = await db.prepare(`SELECT id FROM patients WHERE id = ? AND clinic_id = ?`).get(req.params.patientId, req.user.clinic_id);
  if (!patient) return res.status(404).json({ error: "Paciente no encontrado" });

  const rows = await db
    .prepare(`SELECT * FROM consultations WHERE patient_id = ? AND clinic_id = ? ORDER BY created_at DESC`)
    .all(req.params.patientId, req.user.clinic_id);
  res.json(rows.map(hydrateConsultation));
});

consultationsRouter.post("/consultations", async (req, res) => {
  const {
    patient_id,
    appointment_id,
    // S
    chief_complaint,
    present_illness,
    relevant_history,
    subjective,
    // O
    blood_pressure,
    heart_rate,
    temperature_c,
    weight_kg,
    height_cm,
    physical_exam,
    clinical_findings,
    // A
    diagnosis_code,
    diagnosis_label,
    clinical_assessment,
    additional_diagnoses,
    // P
    treatment_meds,
    non_pharmacological_treatment,
    studies_lab,
    studies_imaging,
    patient_education,
    warning_signs,
    follow_up_interval,
    follow_up_date,
    plan,
  } = req.body;

  if (!patient_id) return res.status(400).json({ error: "patient_id es obligatorio" });

  const patient = await db.prepare(`SELECT id FROM patients WHERE id = ? AND clinic_id = ?`).get(patient_id, req.user.clinic_id);
  if (!patient) return res.status(400).json({ error: "El paciente no existe" });

  if (appointment_id) {
    const appt = await db.prepare(`SELECT id FROM appointments WHERE id = ? AND clinic_id = ?`).get(appointment_id, req.user.clinic_id);
    if (!appt) return res.status(400).json({ error: "La cita no existe en esta clínica" });
  }

  const bmi = computeBmi(weight_kg, height_cm);

  const result = await db
    .prepare(
      `INSERT INTO consultations
        (clinic_id, patient_id, appointment_id,
         chief_complaint, present_illness, relevant_history, subjective,
         blood_pressure, heart_rate, temperature_c, weight_kg, height_cm, bmi,
         physical_exam_json, clinical_findings,
         diagnosis_code, diagnosis_label, clinical_assessment, additional_diagnoses_json,
         treatment_meds_json, non_pharmacological_treatment, studies_lab_json, studies_imaging_json,
         patient_education, warning_signs, follow_up_interval, follow_up_date, plan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.clinic_id,
      patient_id,
      appointment_id ?? null,
      chief_complaint ?? null,
      present_illness ?? null,
      relevant_history ?? null,
      subjective ?? null,
      blood_pressure ?? null,
      heart_rate ?? null,
      temperature_c ?? null,
      weight_kg ?? null,
      height_cm ?? null,
      bmi,
      toJson(physical_exam),
      clinical_findings ?? null,
      diagnosis_code ?? null,
      diagnosis_label ?? null,
      clinical_assessment ?? null,
      toJson(additional_diagnoses),
      toJson(treatment_meds),
      non_pharmacological_treatment ?? null,
      toJson(studies_lab),
      toJson(studies_imaging),
      patient_education ?? null,
      warning_signs ?? null,
      follow_up_interval ?? null,
      follow_up_date ?? null,
      plan ?? null
    );

  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "create", entity: "consultation", entityId: result.lastInsertRowid });

  if (appointment_id) {
    await db
      .prepare(`UPDATE appointments SET status = 'finalizada', updated_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
      .run(appointment_id);
  }

  const consultation = await db.prepare(`SELECT * FROM consultations WHERE id = ?`).get(result.lastInsertRowid);

  // Si el médico cargó medicamentos en "P · Tratamiento", generamos la
  // receta automáticamente con esos mismos medicamentos, ligada a esta
  // consulta — así no hay que volver a escribirlos en "Nueva receta".
  let generatedPrescriptionId = null;
  if (Array.isArray(treatment_meds) && treatment_meds.length > 0) {
    const items = treatment_meds.map(({ generic_name, commercial_name, presentation, dose, frequency, duration }) => ({
      generic_name,
      commercial_name: commercial_name ?? "",
      presentation: presentation ?? "",
      dose: dose ?? "",
      frequency: frequency ?? "",
      duration: duration ?? "",
    }));

    const doctor = await db.prepare(`SELECT * FROM doctor_profile WHERE clinic_id = ?`).get(req.user.clinic_id);
    const qr_token = newQrToken();
    const rxResult = await db
      .prepare(
        `INSERT INTO prescriptions
          (clinic_id, patient_id, consultation_id, qr_token, items_json, instructions,
           doctor_name, doctor_specialty, doctor_license, clinic_name, clinic_address, clinic_phone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.user.clinic_id,
        patient_id,
        consultation.id,
        qr_token,
        JSON.stringify(items),
        non_pharmacological_treatment ? `Tratamiento no farmacológico: ${non_pharmacological_treatment}` : null,
        doctor?.full_name ?? null,
        doctor?.specialty ?? null,
        doctor?.professional_license ?? null,
        doctor?.clinic_name ?? null,
        doctor?.clinic_address ?? null,
        doctor?.clinic_phone ?? null
      );
    generatedPrescriptionId = rxResult.lastInsertRowid;
  }

  res.status(201).json({ ...hydrateConsultation(consultation), generated_prescription_id: generatedPrescriptionId });
});

// PUT /api/consultations/:id -> editar una nota ya guardada (por si se escribió con un error)
consultationsRouter.put("/consultations/:id", async (req, res) => {
  const existing = await db
    .prepare(`SELECT * FROM consultations WHERE id = ? AND clinic_id = ?`)
    .get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Nota no encontrada" });

  const {
    chief_complaint,
    present_illness,
    relevant_history,
    subjective,
    blood_pressure,
    heart_rate,
    temperature_c,
    weight_kg,
    height_cm,
    physical_exam,
    clinical_findings,
    diagnosis_code,
    diagnosis_label,
    clinical_assessment,
    additional_diagnoses,
    treatment_meds,
    non_pharmacological_treatment,
    studies_lab,
    studies_imaging,
    patient_education,
    warning_signs,
    follow_up_interval,
    follow_up_date,
    plan,
  } = req.body;

  const bmi = computeBmi(weight_kg, height_cm);

  await db
    .prepare(
      `UPDATE consultations SET
        chief_complaint = ?, present_illness = ?, relevant_history = ?, subjective = ?,
        blood_pressure = ?, heart_rate = ?, temperature_c = ?, weight_kg = ?, height_cm = ?, bmi = ?,
        physical_exam_json = ?, clinical_findings = ?,
        diagnosis_code = ?, diagnosis_label = ?, clinical_assessment = ?, additional_diagnoses_json = ?,
        treatment_meds_json = ?, non_pharmacological_treatment = ?, studies_lab_json = ?, studies_imaging_json = ?,
        patient_education = ?, warning_signs = ?, follow_up_interval = ?, follow_up_date = ?, plan = ?,
        updated_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ?`
    )
    .run(
      chief_complaint ?? null,
      present_illness ?? null,
      relevant_history ?? null,
      subjective ?? null,
      blood_pressure ?? null,
      heart_rate ?? null,
      temperature_c ?? null,
      weight_kg ?? null,
      height_cm ?? null,
      bmi,
      toJson(physical_exam),
      clinical_findings ?? null,
      diagnosis_code ?? null,
      diagnosis_label ?? null,
      clinical_assessment ?? null,
      toJson(additional_diagnoses),
      toJson(treatment_meds),
      non_pharmacological_treatment ?? null,
      toJson(studies_lab),
      toJson(studies_imaging),
      patient_education ?? null,
      warning_signs ?? null,
      follow_up_interval ?? null,
      follow_up_date ?? null,
      plan ?? null,
      req.params.id
    );

  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "update", entity: "consultation", entityId: req.params.id });
  res.json(hydrateConsultation(await db.prepare(`SELECT * FROM consultations WHERE id = ?`).get(req.params.id)));
});

// DELETE /api/consultations/:id -> borra una nota de evolución por si se
// registró por error. No borra en cascada la receta/certificado que
// pudieran estar ligados a ella (quedan sueltos, con consultation_id NULL,
// gracias al ON DELETE SET NULL de la base de datos).
consultationsRouter.delete("/consultations/:id", async (req, res) => {
  const existing = await db
    .prepare(`SELECT * FROM consultations WHERE id = ? AND clinic_id = ?`)
    .get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Nota no encontrada" });

  await db.prepare(`DELETE FROM consultations WHERE id = ?`).run(req.params.id);
  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "delete", entity: "consultation", entityId: req.params.id });
  res.json({ ok: true });
});
