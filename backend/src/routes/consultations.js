import { Router } from "express";
import { db, logAudit, newQrToken } from "../db.js";

export const consultationsRouter = Router();

function computeBmi(weight_kg, height_cm) {
  if (!weight_kg || !height_cm) return null;
  const heightM = height_cm / 100;
  if (heightM <= 0) return null;
  return Math.round((weight_kg / (heightM * heightM)) * 10) / 10;
}

// A-07 de la auditoría: no había ninguna validación de rango para los
// signos vitales — se podía guardar una temperatura de 90°C o una
// frecuencia cardiaca de 900 lpm sin que el sistema lo notara (typo del
// médico al escribir rápido, o un valor mal pegado). Estos rangos son
// deliberadamente amplios (cubren casos clínicos extremos reales, no solo
// "lo normal") — la intención es atrapar errores de tipeo evidentes, no
// hacer juicios clínicos.
const VITAL_RANGES = {
  heart_rate: { min: 20, max: 300, label: "la frecuencia cardiaca (lpm)" },
  temperature_c: { min: 25, max: 45, label: "la temperatura (°C)" },
  weight_kg: { min: 0.3, max: 400, label: "el peso (kg)" },
  height_cm: { min: 15, max: 250, label: "la talla (cm)" },
};
const BLOOD_PRESSURE_RE = /^\d{2,3}\/\d{2,3}$/;

function validateVitals(body) {
  for (const [field, range] of Object.entries(VITAL_RANGES)) {
    const value = body[field];
    if (value === undefined || value === null || value === "") continue;
    const num = Number(value);
    if (Number.isNaN(num) || num < range.min || num > range.max) {
      return `Revisa ${range.label}: el valor ingresado no parece válido.`;
    }
  }
  if (body.blood_pressure && !BLOOD_PRESSURE_RE.test(String(body.blood_pressure).trim())) {
    return 'La presión arterial debe tener el formato "120/80".';
  }
  return null;
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

  // A-08 de la auditoría: la cita referenciada debe ser DE ESTE PACIENTE,
  // no solo de esta clínica — antes se podía, por error del frontend o
  // manipulando la petición, anotar la consulta sobre la cita de otro
  // paciente de la misma clínica.
  if (appointment_id) {
    const appt = await db
      .prepare(`SELECT id FROM appointments WHERE id = ? AND clinic_id = ? AND patient_id = ?`)
      .get(appointment_id, req.user.clinic_id, patient_id);
    if (!appt) return res.status(400).json({ error: "La cita no existe o no corresponde a este paciente" });
  }

  const vitalsError = validateVitals(req.body);
  if (vitalsError) return res.status(400).json({ error: vitalsError });

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

// PUT /api/consultations/:id -> C-04 de la auditoría: igual que
// recetas/certificados, ya no sobrescribe la nota original. Crea una nota
// NUEVA con la corrección y conserva la original marcada como
// "corregida" — una nota clínica ya guardada es parte del expediente
// médico-legal del paciente y no debería poder reescribirse en silencio.
consultationsRouter.put("/consultations/:id", async (req, res) => {
  const existing = await db
    .prepare(`SELECT * FROM consultations WHERE id = ? AND clinic_id = ?`)
    .get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Nota no encontrada" });
  if (existing.status === "anulado") {
    return res.status(409).json({ error: "Esta nota fue anulada y no se puede corregir. Crea una nueva." });
  }
  if (existing.status === "corregido") {
    return res.status(409).json({ error: "Esta nota ya fue reemplazada por una corrección posterior." });
  }

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

  const vitalsError = validateVitals(req.body);
  if (vitalsError) return res.status(400).json({ error: vitalsError });

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
         patient_education, warning_signs, follow_up_interval, follow_up_date, plan,
         corrected_from_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      existing.clinic_id,
      existing.patient_id,
      existing.appointment_id,
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
      existing.id
    );

  await db
    .prepare(
      `UPDATE consultations SET status = 'corregido', superseded_by_id = ?,
        updated_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ?`
    )
    .run(result.lastInsertRowid, existing.id);

  await logAudit({
    clinicId: req.user.clinic_id,
    actor: req.user.username,
    action: "correct",
    entity: "consultation",
    entityId: existing.id,
    detail: { new_id: result.lastInsertRowid },
  });
  res.json(hydrateConsultation(await db.prepare(`SELECT * FROM consultations WHERE id = ?`).get(result.lastInsertRowid)));
});

// DELETE /api/consultations/:id -> C-04: anula (con motivo obligatorio) en
// vez de borrar físicamente. No borra en cascada la receta/certificado que
// pudieran estar ligados a ella (quedan sueltos, con consultation_id NULL,
// gracias al ON DELETE SET NULL de la base de datos) — aunque ya no debería
// llegar a pasar seguido, porque anular ya no borra la fila.
consultationsRouter.delete("/consultations/:id", async (req, res) => {
  const existing = await db
    .prepare(`SELECT * FROM consultations WHERE id = ? AND clinic_id = ?`)
    .get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Nota no encontrada" });
  if (existing.status === "anulado") return res.status(409).json({ error: "Esta nota ya estaba anulada" });

  const reason = String(req.body?.reason || "").trim();
  if (reason.length < 5) {
    return res.status(400).json({ error: "Indica el motivo de la anulación (mínimo 5 caracteres)" });
  }

  await db
    .prepare(
      `UPDATE consultations SET status = 'anulado', void_reason = ?, voided_by = ?,
        voided_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ?`
    )
    .run(reason, req.user.username, req.params.id);

  await logAudit({
    clinicId: req.user.clinic_id,
    actor: req.user.username,
    action: "void",
    entity: "consultation",
    entityId: req.params.id,
    detail: { reason },
  });
  res.json(hydrateConsultation(await db.prepare(`SELECT * FROM consultations WHERE id = ?`).get(req.params.id)));
});
