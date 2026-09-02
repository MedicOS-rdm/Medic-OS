import { Router } from "express";
import { db, logAudit, newQrToken, withTransaction } from "../db.js";
import { requireRole } from "../auth.js";
import { newShareToken, newShareExpiry } from "./prescriptions.js";
import {
  validateVitals,
  computeBmi,
  findAllergyConflicts,
  findDuplicateMedications,
  validatePrescriptionItems,
  isValidOverrideReason,
  MIN_OVERRIDE_REASON_LENGTH,
  validateMinimumClinicalContent,
  isValidIsoDate,
} from "../validators.js";

export const consultationsRouter = Router();

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

// GRAVE de la auditoría ("privacidad y control de acceso a documentos
// clínicos"): ninguna de estas rutas exigía rol de médico — cualquier
// cuenta autenticada de la clínica (incluida secretaría) podía crear,
// corregir o anular una nota clínica y, de paso, generar recetas
// automáticamente. Redactar una nota clínica es un acto médico.
consultationsRouter.post("/consultations", requireRole("medico"), async (req, res) => {
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

  // GRAVE de la auditoría ("la nota clínica completa puede guardarse
  // prácticamente vacía"): exige un mínimo médico-legalmente razonable
  // ANTES de tocar la base de datos.
  const contentError = validateMinimumClinicalContent({ chief_complaint, diagnosis_code, diagnosis_label, plan });
  if (contentError) return res.status(400).json({ error: contentError });

  // GRAVE de la auditoría ("las fechas se validan solo por formato y
  // pueden aceptar fechas calendario imposibles"): follow_up_date no tenía
  // ninguna validación de formato ni de calendario.
  if (follow_up_date && !isValidIsoDate(follow_up_date)) {
    return res.status(400).json({ error: "La fecha de seguimiento no es una fecha calendario válida." });
  }

  const patient = await db.prepare(`SELECT id, allergies FROM patients WHERE id = ? AND clinic_id = ?`).get(patient_id, req.user.clinic_id);
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

  // CRÍTICO 1 de la auditoría ("la receta automática puede quedar emitida
  // sin confirmación previa de alergia"): antes, la alerta de alergia se
  // calculaba DENTRO de la transacción, después de insertar la receta, y
  // solo se avisaba al frontend una vez que el documento ya existía. Ahora
  // el conflicto se detecta ANTES de escribir absolutamente nada: si hay
  // conflicto y el médico no confirmó explícitamente con un motivo clínico,
  // se corta aquí con 409 y no se guarda ni la receta ni la nota — así
  // nunca puede quedar un medicamento potencialmente alergénico ya
  // formalmente prescrito antes de que el médico lo confirme a conciencia.
  let allergyWarnings = [];
  let duplicateWarnings = [];
  let itemsForRx = null;
  if (Array.isArray(treatment_meds) && treatment_meds.length > 0) {
    const itemsError = validatePrescriptionItems(treatment_meds);
    if (itemsError) return res.status(400).json({ error: itemsError });

    itemsForRx = treatment_meds.map(({ generic_name, commercial_name, presentation, dose, route, quantity, frequency, duration, indication }) => ({
      generic_name,
      commercial_name: commercial_name ?? "",
      presentation: presentation ?? "",
      dose: dose ?? "",
      route: route ?? "",
      quantity: quantity ?? "",
      frequency: frequency ?? "",
      duration: duration ?? "",
      indication: indication ?? "",
    }));

    allergyWarnings = findAllergyConflicts(patient.allergies, itemsForRx);
    if (allergyWarnings.length > 0 && !req.body.confirm_allergy_override) {
      return res.status(409).json({
        error: "El paciente tiene registrada una alergia que coincide con uno de estos medicamentos. La receta no se generó.",
        allergy_conflicts: allergyWarnings,
      });
    }
    if (allergyWarnings.length > 0 && !isValidOverrideReason(req.body.override_reason)) {
      return res.status(400).json({
        error: `Para continuar pese a la alerta de alergia, indica el motivo clínico (mínimo ${MIN_OVERRIDE_REASON_LENGTH} caracteres).`,
        allergy_conflicts: allergyWarnings,
      });
    }

    duplicateWarnings = findDuplicateMedications(itemsForRx);
  }

  // CRÍTICO POTENCIAL de la auditoría: este flujo escribe hasta TRES cosas
  // relacionadas (la nota, el cambio de estado de la cita, y la receta
  // autogenerada si el médico cargó medicamentos) — antes cada una era una
  // operación suelta; si el proceso fallaba a la mitad (ej. se caía la
  // conexión justo después de crear la nota), la cita podía quedar sin
  // marcarse "finalizada" o la receta nunca se generaba, sin que quedara
  // registro de que algo se cortó a la mitad. Ahora las tres corren en una
  // sola transacción.
  const { consultationId, generatedPrescriptionId } = await withTransaction(async (tx) => {
    const result = await tx
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

    await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "create", entity: "consultation", entityId: result.lastInsertRowid, tx });

    if (appointment_id) {
      await tx
        .prepare(`UPDATE appointments SET status = 'finalizada', updated_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
        .run(appointment_id);
    }

    // Si el médico cargó medicamentos en "P · Tratamiento", generamos la
    // receta automáticamente con esos mismos medicamentos, ligada a esta
    // consulta — así no hay que volver a escribirlos en "Nueva receta".
    // Alergias, campos obligatorios y duplicidad YA se validaron y, si
    // hacía falta, se confirmaron ANTES de esta transacción (ver arriba) —
    // aquí solo queda persistir.
    let generatedPrescriptionId = null;
    if (itemsForRx) {
      const items = itemsForRx;

      if (allergyWarnings.length > 0) {
        // CRÍTICO 1 de la auditoría: el override nunca es solo una bandera
        // booleana — queda registrado en la auditoría junto con el
        // conflicto detectado y el motivo clínico dado por el médico.
        await logAudit({
          clinicId: req.user.clinic_id,
          actor: req.user.username,
          action: "allergy_override",
          entity: "consultation",
          entityId: result.lastInsertRowid,
          detail: { allergy_conflicts: allergyWarnings, reason: req.body.override_reason },
          tx,
        });
      }

      const doctor = await tx.prepare(`SELECT * FROM doctor_profile WHERE clinic_id = ?`).get(req.user.clinic_id);
      const qr_token = newQrToken();
      // Corregido: esta receta autogenerada se quedaba SIN share_token
      // (a diferencia de una receta creada desde "Nueva receta"), lo que
      // rompía en silencio el enlace de WhatsApp / descarga pública para
      // este caso concreto — el enlace se armaba con un token nulo.
      const share_token = newShareToken();
      const share_expires_at = newShareExpiry();
      const rxResult = await tx
        .prepare(
          `INSERT INTO prescriptions
            (clinic_id, patient_id, consultation_id, qr_token, share_token, share_expires_at, items_json, instructions,
             doctor_name, doctor_specialty, doctor_license, clinic_name, clinic_address, clinic_phone)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          req.user.clinic_id,
          patient_id,
          result.lastInsertRowid,
          qr_token,
          share_token,
          share_expires_at,
          JSON.stringify(items),
          non_pharmacological_treatment ? `Tratamiento no farmacológico: ${non_pharmacological_treatment}` : null,
          doctor?.full_name ?? null,
          doctor?.specialty ?? null,
          doctor?.professional_license ?? null,
          doctor?.clinic_name ?? null,
          doctor?.clinic_address ?? null,
          doctor?.clinic_phone ?? null
        );
      await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "create", entity: "prescription", entityId: rxResult.lastInsertRowid, tx });
      generatedPrescriptionId = rxResult.lastInsertRowid;
    }

    return { consultationId: result.lastInsertRowid, generatedPrescriptionId };
  });

  const consultation = await db.prepare(`SELECT * FROM consultations WHERE id = ?`).get(consultationId);
  res.status(201).json({
    ...hydrateConsultation(consultation),
    generated_prescription_id: generatedPrescriptionId,
    // Estas alertas ya fueron confirmadas (si hacía falta) ANTES de guardar
    // — se regresan solo para que el frontend las siga mostrando como
    // constancia informativa, nunca como un aviso "después del hecho".
    allergy_warnings: allergyWarnings,
    duplicate_warnings: duplicateWarnings,
  });
});

// PUT /api/consultations/:id -> C-04 de la auditoría: igual que
// recetas/certificados, ya no sobrescribe la nota original. Crea una nota
// NUEVA con la corrección y conserva la original marcada como
// "corregida" — una nota clínica ya guardada es parte del expediente
// médico-legal del paciente y no debería poder reescribirse en silencio.
consultationsRouter.put("/consultations/:id", requireRole("medico"), async (req, res) => {
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

  const contentError = validateMinimumClinicalContent({ chief_complaint, diagnosis_code, diagnosis_label, plan });
  if (contentError) return res.status(400).json({ error: contentError });

  if (follow_up_date && !isValidIsoDate(follow_up_date)) {
    return res.status(400).json({ error: "La fecha de seguimiento no es una fecha calendario válida." });
  }

  if (Array.isArray(treatment_meds) && treatment_meds.length > 0) {
    const itemsError = validatePrescriptionItems(treatment_meds);
    if (itemsError) return res.status(400).json({ error: itemsError });
  }

  const vitalsError = validateVitals(req.body);
  if (vitalsError) return res.status(400).json({ error: vitalsError });

  const bmi = computeBmi(weight_kg, height_cm);

  const result = await withTransaction(async (tx) => {
    const inserted = await tx
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

    await tx
      .prepare(
        `UPDATE consultations SET status = 'corregido', superseded_by_id = ?,
          updated_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id = ?`
      )
      .run(inserted.lastInsertRowid, existing.id);

    await logAudit({
      clinicId: req.user.clinic_id,
      actor: req.user.username,
      action: "correct",
      entity: "consultation",
      entityId: existing.id,
      detail: { new_id: inserted.lastInsertRowid },
      tx,
    });
    return inserted.lastInsertRowid;
  });
  res.json(hydrateConsultation(await db.prepare(`SELECT * FROM consultations WHERE id = ?`).get(result)));
});

// DELETE /api/consultations/:id -> C-04: anula (con motivo obligatorio) en
// vez de borrar físicamente. No borra en cascada la receta/certificado que
// pudieran estar ligados a ella (quedan sueltos, con consultation_id NULL,
// gracias al ON DELETE SET NULL de la base de datos) — aunque ya no debería
// llegar a pasar seguido, porque anular ya no borra la fila.
consultationsRouter.delete("/consultations/:id", requireRole("medico"), async (req, res) => {
  const existing = await db
    .prepare(`SELECT * FROM consultations WHERE id = ? AND clinic_id = ?`)
    .get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Nota no encontrada" });
  if (existing.status === "anulado") return res.status(409).json({ error: "Esta nota ya estaba anulada" });

  const reason = String(req.body?.reason || "").trim();
  if (reason.length < 5) {
    return res.status(400).json({ error: "Indica el motivo de la anulación (mínimo 5 caracteres)" });
  }

  await withTransaction(async (tx) => {
    await tx
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
      tx,
    });
  });
  res.json(hydrateConsultation(await db.prepare(`SELECT * FROM consultations WHERE id = ?`).get(req.params.id)));
});
