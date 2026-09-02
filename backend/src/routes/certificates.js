import { Router } from "express";
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, logAudit, newQrToken, withTransaction } from "../db.js";
import { requireRole } from "../auth.js";
import { spellDateSpanish, formatDateSlashes } from "../spanishDates.js";
import { notifyDocumentIssued } from "../notifications.js";
import { ISO_DATE_RE, isValidIsoDate, daysBetweenInclusive } from "../validators.js";

export const certificatesRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Logo de MedicOs (la aplicación), no confundir con el logo del consultorio
// (que cada clínica sube desde "Perfil del médico"). Se carga una sola vez
// al arrancar el proceso.
const APP_LOGO_PATH = path.join(__dirname, "..", "assets", "app-logo.png");
const appLogoBuffer = fs.existsSync(APP_LOGO_PATH) ? fs.readFileSync(APP_LOGO_PATH) : null;

// Azul institucional de MedicOs (mismo tono que --accent en el frontend),
// usado para los títulos del certificado.
const BRAND_BLUE = "#0460d3";

const TYPE_LABELS = {
  enfermedad: "Enfermedad",
  aislamiento: "Aislamiento",
  teletrabajo: "Teletrabajo",
};

// Cuánto dura vigente el enlace público (WhatsApp) antes de expirar solo
// (C-03) — se puede además revocar manualmente en cualquier momento antes
// desde la ficha del paciente.
const SHARE_LINK_VALID_DAYS = 30;
function newShareExpiry() {
  return new Date(Date.now() + SHARE_LINK_VALID_DAYS * 24 * 60 * 60 * 1000).toISOString();
}


async function getDoctorProfile(clinicId) {
  return (
    (await db.prepare(`SELECT * FROM doctor_profile WHERE clinic_id = ?`).get(clinicId)) || {
      full_name: "",
      personal_id: "",
      professional_license: "",
      specialty: "",
      email: "",
      city: "",
      clinic_name: "",
      clinic_address: "",
      clinic_phone: "",
    }
  );
}

// (daysBetweenInclusive vive en ../validators.js, compartida y probada por tests)

// Convierte un "data URI" (ej. "data:image/png;base64,....") guardado en
// doctor_profile.logo_base64 a un Buffer que pdfkit pueda dibujar. Si no
// hay logo o el formato no es válido, regresa null en vez de tronar.
function parseLogoBuffer(dataUri) {
  if (!dataUri || typeof dataUri !== "string") return null;
  const match = dataUri.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  if (!match) return null;
  try {
    return Buffer.from(match[2], "base64");
  } catch {
    return null;
  }
}

// GRAVE de la auditoría ("un certificado médico-legal puede emitirse sin
// un diagnóstico codificado válido"): valida el código contra el catálogo
// CIE-10/11 vigente en la base y toma la descripción oficial de ahí, en
// vez de confiar en el texto libre que mande el frontend (que podría no
// corresponder al código, o quedar desactualizado si el catálogo cambia).
async function resolveDiagnosis(diagnosis_code) {
  if (!diagnosis_code || !String(diagnosis_code).trim()) {
    return { error: "diagnosis_code es obligatorio: selecciona un diagnóstico del catálogo CIE-10." };
  }
  const row = await db.prepare(`SELECT code, label FROM cie11_catalog WHERE code = ?`).get(diagnosis_code.trim());
  if (!row) {
    return { error: "El código CIE-10 indicado no existe en el catálogo vigente." };
  }
  return { code: row.code, label: row.label };
}

// GRAVE de la auditoría ("privacidad y control de acceso"): igual que
// con recetas, emitir/corregir/anular un certificado médico-legal es
// un acto médico y requería exigir el rol de médico explícitamente.
certificatesRouter.post("/", requireRole("medico"), async (req, res) => {
  const {
    patient_id,
    consultation_id,
    diagnosis_code,
    diagnosis_label,
    clinical_picture,
    presents_symptoms,
    certificate_type,
    description,
    date_from,
    date_to,
    days_granted,
  } = req.body;

  if (!patient_id) return res.status(400).json({ error: "patient_id es obligatorio" });
  if (!date_from || !date_to) return res.status(400).json({ error: "date_from y date_to son obligatorios" });
  if (!isValidIsoDate(date_from) || !isValidIsoDate(date_to)) {
    return res.status(400).json({ error: "date_from y date_to deben ser fechas calendario válidas en formato AAAA-MM-DD" });
  }
  if (!TYPE_LABELS[certificate_type]) {
    return res.status(400).json({ error: "certificate_type debe ser enfermedad, aislamiento o teletrabajo" });
  }
  const diagnosis = await resolveDiagnosis(diagnosis_code);
  if (diagnosis.error) return res.status(400).json({ error: diagnosis.error });

  const patient = await db.prepare(`SELECT * FROM patients WHERE id = ? AND clinic_id = ?`).get(patient_id, req.user.clinic_id);
  if (!patient) return res.status(400).json({ error: "El paciente no existe" });

  // A-08 de la auditoría: si el certificado se genera desde una consulta
  // puntual, esa consulta debe pertenecer al MISMO paciente — si no, algo
  // en el frontend está mal armado (o alguien manipuló la petición) y
  // terminaríamos anotando el certificado sobre la consulta de otra
  // persona.
  if (consultation_id) {
    const consultation = await db
      .prepare(`SELECT id FROM consultations WHERE id = ? AND patient_id = ? AND clinic_id = ?`)
      .get(consultation_id, patient_id, req.user.clinic_id);
    if (!consultation) {
      return res.status(400).json({ error: "consultation_id no corresponde a este paciente" });
    }
  }

  const autoDays = daysBetweenInclusive(date_from, date_to);
  const finalDays = days_granted ?? autoDays;
  if (!finalDays || finalDays < 1 || finalDays > 365) {
    return res.status(400).json({ error: "El rango de fechas o los días concedidos no son válidos" });
  }

  const doctor = await getDoctorProfile(req.user.clinic_id);
  const share_token = newQrToken();
  const share_expires_at = newShareExpiry();

  const result = await db
    .prepare(
      `INSERT INTO certificates
        (clinic_id, patient_id, consultation_id,
         diagnosis_code, diagnosis_label, clinical_picture, presents_symptoms, certificate_type,
         description, days_granted, date_from, date_to,
         patient_full_name, patient_address, patient_phone, patient_email,
         patient_institution, patient_job_title, patient_id_number, patient_clinical_history_number,
         doctor_name, doctor_personal_id, doctor_license, doctor_specialty, doctor_email,
         clinic_name, clinic_address, clinic_phone, issue_place, share_token, share_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.clinic_id,
      patient_id,
      consultation_id ?? null,
      diagnosis.code,
      diagnosis.label,
      clinical_picture ?? null,
      presents_symptoms === false ? 0 : 1,
      certificate_type,
      description ?? null,
      finalDays,
      date_from,
      date_to,
      `${patient.first_name} ${patient.last_name}`,
      patient.address ?? null,
      patient.phone ?? null,
      patient.email ?? null,
      patient.workplace ?? null,
      patient.job_title ?? null,
      patient.id_number ?? null,
      patient.clinical_history_number ?? null,
      doctor.full_name,
      doctor.personal_id,
      doctor.professional_license,
      doctor.specialty,
      doctor.email,
      doctor.clinic_name,
      doctor.clinic_address,
      doctor.clinic_phone,
      doctor.city,
      share_token,
      share_expires_at
    );

  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "create", entity: "certificate", entityId: result.lastInsertRowid });

  const certificate = await db.prepare(`SELECT * FROM certificates WHERE id = ?`).get(result.lastInsertRowid);

  // Envío automático por WhatsApp/correo, si el médico lo activó en
  // "Notificaciones automáticas". No bloquea la respuesta al usuario: si
  // el envío falla (credenciales no configuradas, etc.), el certificado
  // ya quedó creado igual — solo se registra el error en el log.
  notifyDocumentIssued({
    clinicId: req.user.clinic_id,
    kind: "certificate",
    id: certificate.id,
    patientPhone: patient.phone,
    patientEmail: patient.email,
    patientName: `${patient.first_name} ${patient.last_name}`,
  }).catch((err) => console.error("Error enviando notificación de certificado:", err));

  res.status(201).json(certificate);
});

certificatesRouter.get("/patient/:patientId", async (req, res) => {
  const rows = await db
    .prepare(`SELECT * FROM certificates WHERE patient_id = ? AND clinic_id = ? ORDER BY created_at DESC`)
    .all(req.params.patientId, req.user.clinic_id);
  res.json(rows);
});

certificatesRouter.get("/:id", async (req, res) => {
  const cert = await db.prepare(`SELECT * FROM certificates WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!cert) return res.status(404).json({ error: "Certificado no encontrado" });
  res.json(cert);
});

// PUT /api/certificates/:id -> C-04 de la auditoría: antes esta ruta
// SOBRESCRIBÍA el certificado original en su lugar. Un documento
// médico-legal ya entregado/firmado no debería poder reescribirse en
// silencio (ni por error ni con mala intención: nada quedaba de la
// versión original que el paciente ya podría tener en su poder). Ahora
// "editar" crea una fila NUEVA con los cambios (una corrección) y el
// documento original se conserva intacto, solo marcado como
// "corregido" con un enlace hacia la versión vigente. La respuesta del
// PDF de la versión vieja seguirá funcionando (para que quien ya la tenía
// pueda verificar que fue reemplazada), pero con un aviso visible.
certificatesRouter.put("/:id", requireRole("medico"), async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM certificates WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Certificado no encontrado" });
  if (existing.status === "anulado") {
    return res.status(409).json({ error: "Este certificado fue anulado y no se puede corregir. Emite uno nuevo." });
  }
  if (existing.status === "corregido") {
    return res.status(409).json({ error: "Este certificado ya fue reemplazado por una corrección posterior." });
  }

  const {
    diagnosis_code,
    diagnosis_label,
    clinical_picture,
    presents_symptoms,
    certificate_type,
    description,
    date_from,
    date_to,
    days_granted,
  } = req.body;

  if (!date_from || !date_to) return res.status(400).json({ error: "date_from y date_to son obligatorios" });
  if (!isValidIsoDate(date_from) || !isValidIsoDate(date_to)) {
    return res.status(400).json({ error: "date_from y date_to deben ser fechas calendario válidas en formato AAAA-MM-DD" });
  }
  if (!TYPE_LABELS[certificate_type]) {
    return res.status(400).json({ error: "certificate_type debe ser enfermedad, aislamiento o teletrabajo" });
  }
  const diagnosis = await resolveDiagnosis(diagnosis_code);
  if (diagnosis.error) return res.status(400).json({ error: diagnosis.error });

  const autoDays = daysBetweenInclusive(date_from, date_to);
  const finalDays = days_granted ?? autoDays;
  if (!finalDays || finalDays < 1 || finalDays > 365) {
    return res.status(400).json({ error: "El rango de fechas o los días concedidos no son válidos" });
  }

  // La corrección hereda el snapshot de paciente/médico/clínica del
  // original (esos datos no cambiaron, solo el motivo/fechas), y recibe
  // su propio share_token con caducidad propia.
  const share_token = newQrToken();
  const share_expires_at = newShareExpiry();

  // CRÍTICO POTENCIAL de la auditoría: crear la corrección + marcar el
  // original como "corregido" son DOS escrituras relacionadas; si el
  // proceso fallara entre la una y la otra, quedarían dos certificados
  // "emitido" vigentes para el mismo caso (uno de ellos ya desactualizado
  // sin que nadie lo supiera). Ambas ahora corren en una sola transacción:
  // o se aplican las dos, o ninguna.
  const newId = await withTransaction(async (tx) => {
    const result = await tx
      .prepare(
        `INSERT INTO certificates
          (clinic_id, patient_id, consultation_id,
           diagnosis_code, diagnosis_label, clinical_picture, presents_symptoms, certificate_type,
           description, days_granted, date_from, date_to,
           patient_full_name, patient_address, patient_phone, patient_email,
           patient_institution, patient_job_title, patient_id_number, patient_clinical_history_number,
           doctor_name, doctor_personal_id, doctor_license, doctor_specialty, doctor_email,
           clinic_name, clinic_address, clinic_phone, issue_place, share_token, share_expires_at,
           corrected_from_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        existing.clinic_id,
        existing.patient_id,
        existing.consultation_id,
        diagnosis.code,
        diagnosis.label,
        clinical_picture ?? null,
        presents_symptoms === false ? 0 : 1,
        certificate_type,
        description ?? null,
        finalDays,
        date_from,
        date_to,
        existing.patient_full_name,
        existing.patient_address,
        existing.patient_phone,
        existing.patient_email,
        existing.patient_institution,
        existing.patient_job_title,
        existing.patient_id_number,
        existing.patient_clinical_history_number,
        existing.doctor_name,
        existing.doctor_personal_id,
        existing.doctor_license,
        existing.doctor_specialty,
        existing.doctor_email,
        existing.clinic_name,
        existing.clinic_address,
        existing.clinic_phone,
        existing.issue_place,
        share_token,
        share_expires_at,
        existing.id
      );

    await tx
      .prepare(
        `UPDATE certificates SET status = 'corregido', superseded_by_id = ?,
          updated_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id = ?`
      )
      .run(result.lastInsertRowid, existing.id);

    await logAudit({
      clinicId: req.user.clinic_id,
      actor: req.user.username,
      action: "correct",
      entity: "certificate",
      entityId: existing.id,
      detail: { new_id: result.lastInsertRowid },
      tx,
    });

    return result.lastInsertRowid;
  });

  res.json(await db.prepare(`SELECT * FROM certificates WHERE id = ?`).get(newId));
});

// DELETE /api/certificates/:id -> C-04: ya no borra la fila. Un
// certificado emitido por error se ANULA (requiere motivo), pero queda en
// la base para el historial médico-legal — igual que anular una factura
// en vez de destruirla. El enlace público deja de servir el PDF de
// inmediato (ver share.js).
certificatesRouter.delete("/:id", requireRole("medico"), async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM certificates WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Certificado no encontrado" });
  if (existing.status === "anulado") return res.status(409).json({ error: "Este certificado ya estaba anulado" });

  const reason = String(req.body?.reason || "").trim();
  if (reason.length < 5) {
    return res.status(400).json({ error: "Indica el motivo de la anulación (mínimo 5 caracteres)" });
  }

  await withTransaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE certificates SET status = 'anulado', void_reason = ?, voided_by = ?, share_revoked = 1,
          voided_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id = ?`
      )
      .run(reason, req.user.username, req.params.id);

    await logAudit({
      clinicId: req.user.clinic_id,
      actor: req.user.username,
      action: "void",
      entity: "certificate",
      entityId: req.params.id,
      detail: { reason },
      tx,
    });
  });
  res.json(await db.prepare(`SELECT * FROM certificates WHERE id = ?`).get(req.params.id));
});

// POST /api/certificates/:id/share/revoke -> apaga el enlace público
// (WhatsApp) inmediatamente, sin esperar a que caduque solo (C-03).
certificatesRouter.post("/:id/share/revoke", async (req, res) => {
  const existing = await db.prepare(`SELECT id FROM certificates WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Certificado no encontrado" });
  await db.prepare(`UPDATE certificates SET share_revoked = 1 WHERE id = ?`).run(req.params.id);
  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "share_revoke", entity: "certificate", entityId: req.params.id });
  res.json({ ok: true });
});

// POST /api/certificates/:id/share/rotate -> invalida el enlace anterior y
// genera uno nuevo con caducidad fresca (por si el anterior se compartió
// de más y se quiere seguir compartiendo el documento con un enlace
// limpio).
certificatesRouter.post("/:id/share/rotate", async (req, res) => {
  const existing = await db.prepare(`SELECT id FROM certificates WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Certificado no encontrado" });
  const share_token = newQrToken();
  const share_expires_at = newShareExpiry();
  await db
    .prepare(`UPDATE certificates SET share_token = ?, share_expires_at = ?, share_revoked = 0 WHERE id = ?`)
    .run(share_token, share_expires_at, req.params.id);
  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "share_rotate", entity: "certificate", entityId: req.params.id });
  res.json({ share_token, share_expires_at });
});

// Prepara los datos de un certificado listos para dibujar el PDF: se usa
// tanto por la ruta autenticada de descarga como por el envío por
// WhatsApp/correo y la ruta pública de compartir.
//
// Los certificados guardan una "foto" del médico y del paciente al momento
// de emitirse (correcto para un documento médico-legal: no debe cambiar
// solo porque después se edite un perfil). Pero si esa foto quedó
// incompleta porque el perfil del médico o los datos del paciente todavía
// no se habían llenado en ese momento, este respaldo completa lo que falte
// con los datos ACTUALES — así un certificado viejo con campos en blanco se
// ve completo en cuanto el perfil se termina de llenar, sin tener que
// volver a generarlo. Esto NO modifica la fila guardada en "certificates";
// solo el objeto que se usa para dibujar el PDF en este momento.
export async function getCertificateReadyForPdf(certId) {
  const cert = await db.prepare(`SELECT * FROM certificates WHERE id = ?`).get(certId);
  if (!cert) return null;

  const doctorNow = await getDoctorProfile(cert.clinic_id);
  const logoBuffer = parseLogoBuffer(doctorNow.logo_base64);

  cert.doctor_name = cert.doctor_name || doctorNow.full_name || null;
  cert.doctor_specialty = cert.doctor_specialty || doctorNow.specialty || null;
  cert.doctor_license = cert.doctor_license || doctorNow.professional_license || null;
  cert.doctor_personal_id = cert.doctor_personal_id || doctorNow.personal_id || null;
  cert.doctor_email = cert.doctor_email || doctorNow.email || null;
  cert.clinic_name = cert.clinic_name || doctorNow.clinic_name || null;
  cert.clinic_address = cert.clinic_address || doctorNow.clinic_address || null;
  cert.clinic_phone = cert.clinic_phone || doctorNow.clinic_phone || null;
  cert.issue_place = cert.issue_place || doctorNow.city || null;

  if (
    !cert.patient_address ||
    !cert.patient_phone ||
    !cert.patient_email ||
    !cert.patient_institution ||
    !cert.patient_job_title ||
    !cert.patient_id_number ||
    !cert.patient_clinical_history_number
  ) {
    const patientNow = await db.prepare(`SELECT * FROM patients WHERE id = ?`).get(cert.patient_id);
    if (patientNow) {
      cert.patient_full_name = cert.patient_full_name || `${patientNow.first_name} ${patientNow.last_name}`;
      cert.patient_address = cert.patient_address || patientNow.address || null;
      cert.patient_phone = cert.patient_phone || patientNow.phone || null;
      cert.patient_email = cert.patient_email || patientNow.email || null;
      cert.patient_institution = cert.patient_institution || patientNow.workplace || null;
      cert.patient_job_title = cert.patient_job_title || patientNow.job_title || null;
      cert.patient_id_number = cert.patient_id_number || patientNow.id_number || null;
      cert.patient_clinical_history_number = cert.patient_clinical_history_number || patientNow.clinical_history_number || null;
    }
  }

  return { cert, logoBuffer };
}

// Dibuja el PDF del certificado directamente sobre cualquier stream
// escribible (la respuesta HTTP, o un stream en memoria para adjuntarlo a
// un correo). Es la MISMA función que usan la descarga manual, el envío
// automático por correo y el link público de WhatsApp — un solo lugar
// donde vive el diseño del certificado.
export function renderCertificatePdf(cert, logoBuffer, writable) {
  const doc = new PDFDocument({ size: "A4", margin: 34 });
  doc.pipe(writable);

  // Marca de agua: el logo del consultorio, grande y muy tenue, centrado
  // detrás de todo el contenido. Se dibuja PRIMERO (antes que cualquier
  // texto) para que quede en el fondo — dibujar una imagen no mueve el
  // cursor de texto de PDFKit, así que no afecta el resto del diseño.
  if (logoBuffer) {
    const wmSize = 320;
    const wmX = (doc.page.width - wmSize) / 2;
    const wmY = (doc.page.height - wmSize) / 2;
    doc.opacity(0.07);
    doc.image(logoBuffer, wmX, wmY, { width: wmSize, height: wmSize });
    doc.opacity(1);
  }

  // Aviso de estado (C-04/A-09): si esta versión del documento ya fue
  // reemplazada por una corrección o fue anulada, se marca de forma bien
  // visible — así nadie confunde una versión vieja con la vigente.
  if (cert.status === "anulado" || cert.status === "corregido") {
    const label = cert.status === "anulado" ? "ANULADO" : "REEMPLAZADO POR CORRECCIÓN";
    doc.save();
    doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.font("Helvetica-Bold").fontSize(58).fillColor("#c0392b").opacity(0.22);
    doc.text(label, 0, doc.page.height / 2 - 30, { width: doc.page.width, align: "center" });
    doc.opacity(1);
    doc.restore();
  }

  const margin = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Etiqueta y valor van en la MISMA línea (en vez de en dos líneas
  // separadas) para que el certificado completo quepa en una sola hoja.
  const row = (labelText, valueText) => {
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#333").text(`${labelText} `, { continued: true });
    doc.font("Helvetica").fontSize(9).fillColor("#000").text(valueText || "—");
    doc.moveDown(0.4);
  };
  const sectionTitle = (text) => {
    doc.moveDown(1.3); // 1-2 líneas de aire entre el bloque anterior (membrete/A/B/C) y el siguiente
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(BRAND_BLUE).text(text);
    doc.moveTo(doc.x, doc.y + 2).lineTo(doc.page.width - doc.page.margins.right, doc.y + 2).strokeColor(BRAND_BLUE).opacity(0.35).stroke().opacity(1);
    doc.moveDown(0.4);
  };

  // ---------- Encabezado ----------
  // Columna izquierda: logo del consultorio (más grande) y, debajo, el
  // nombre del consultorio. Columna derecha: logo de MedicOs (la app) y,
  // debajo, "MedicOs". En el centro: el título del certificado y el
  // nombre del médico.
  const sideColWidth = 118;
  const logoSize = 50;
  const headerTop = doc.y;
  const centerX = margin + sideColWidth;
  const centerWidth = contentWidth - sideColWidth * 2;

  if (logoBuffer) {
    doc.image(logoBuffer, margin + sideColWidth / 2 - logoSize / 2, headerTop, { width: logoSize, height: logoSize });
  }
  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .fillColor("#333")
    .text(cert.clinic_name || "Consultorio médico", margin, headerTop + logoSize + 4, { width: sideColWidth, align: "center" });

  if (appLogoBuffer) {
    doc.image(appLogoBuffer, doc.page.width - margin - sideColWidth / 2 - logoSize / 2, headerTop, { width: logoSize, height: logoSize });
  }
  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .fillColor("#333")
    .text("MedicOs", doc.page.width - margin - sideColWidth, headerTop + logoSize + 4, { width: sideColWidth, align: "center" });

  doc.font("Helvetica-Bold").fontSize(15).fillColor(BRAND_BLUE).text("CERTIFICADO MÉDICO", centerX, headerTop + 6, {
    width: centerWidth,
    align: "center",
  });
  if (cert.doctor_name) {
    doc.font("Helvetica-Bold").fontSize(11.5).fillColor(BRAND_BLUE).text(cert.doctor_name, centerX, doc.y + 4, {
      width: centerWidth,
      align: "center",
    });
  }

  doc.x = margin; // volvemos al margen izquierdo normal para el resto del documento
  doc.y = headerTop + logoSize + 4 + 12; // nunca empezar antes de que termine el bloque de logo + nombre

  // Folio + estado del documento (mejora menor de trazabilidad sugerida
  // en la auditoría junto con el versionado: quien reciba el PDF puede
  // confirmar con el consultorio a qué folio corresponde).
  const statusLabel = { emitido: "Emitido", corregido: "Corregido (reemplazado)", anulado: "Anulado" }[cert.status] || "Emitido";
  doc.font("Helvetica").fontSize(7.5).fillColor("#777").text(`Folio N° ${cert.id} · Estado: ${statusLabel}`, margin, doc.y, { width: contentWidth, align: "right" });
  if (cert.status === "anulado" && cert.void_reason) {
    doc.font("Helvetica-Oblique").fontSize(7.5).fillColor("#c0392b").text(`Motivo de anulación: ${cert.void_reason}`, margin, doc.y, { width: contentWidth, align: "right" });
  }
  if (cert.status === "corregido" && cert.superseded_by_id) {
    doc.font("Helvetica-Oblique").fontSize(7.5).fillColor("#c0392b").text(`Ver versión vigente: folio N° ${cert.superseded_by_id}`, margin, doc.y, { width: contentWidth, align: "right" });
  }
  doc.moveDown(0.3);

  sectionTitle("A) DATOS DEL ESTABLECIMIENTO DE SALUD");
  row("Nombre del establecimiento:", cert.clinic_name);
  row("Correo electrónico del médico emisor del certificado:", cert.doctor_email);
  row("Teléfono del emisor del certificado:", cert.clinic_phone);
  row("Dirección del establecimiento de salud:", cert.clinic_address);
  row(
    "Lugar y fecha de emisión:",
    `${cert.issue_place || ""}, ${new Date(cert.created_at.replace(" ", "T")).toLocaleDateString("es-MX", {
      day: "numeric",
      month: "long",
      year: "numeric",
    })}`
  );

  sectionTitle("B) DATOS DEL PACIENTE");
  row("Apellidos y nombres completo:", cert.patient_full_name);
  row("Dirección domiciliaria:", cert.patient_address);
  row("Número de teléfono:", cert.patient_phone);
  row("Institución o empresa:", cert.patient_institution);
  row("Puesto de trabajo del paciente:", cert.patient_job_title);
  row("Número de cédula:", cert.patient_id_number);
  row("Número de historia clínica:", cert.patient_clinical_history_number);
  row("Correo electrónico:", cert.patient_email);

  sectionTitle("C) MOTIVO DE AISLAMIENTO/ENFERMEDAD");
  row("Diagnóstico:", cert.diagnosis_label);
  if (cert.clinical_picture) row("Cuadro clínico:", cert.clinical_picture);
  row("Código CIE-10:", cert.diagnosis_code);
  row("Presenta síntomas:", cert.presents_symptoms ? "SI" : "NO");
  row("Tipo:", TYPE_LABELS[cert.certificate_type] || cert.certificate_type);
  if (cert.description) row("Descripción:", cert.description);
  row("Total de días concedidos:", `${cert.days_granted} (${cert.days_granted === 1 ? "un" : cert.days_granted} día${cert.days_granted === 1 ? "" : "s"})`);
  row("Desde:", `${formatDateSlashes(cert.date_from)} (${spellDateSpanish(cert.date_from)})`);
  row("Hasta:", `${formatDateSlashes(cert.date_to)} (${spellDateSpanish(cert.date_to)})`);

  // ---------- Firma ----------
  // El espacio antes de la firma debe ser el más grande del documento: la
  // empujamos hasta cerca del pie de página para que el certificado
  // aproveche toda la hoja en vez de dejar el resto en blanco.
  const signatureBlockHeight = 95; // línea + nombre + especialidad + reg. SENESCYT + C.I.
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  const targetSignatureTop = bottomLimit - signatureBlockHeight;
  if (doc.y < targetSignatureTop) {
    doc.y = targetSignatureTop;
  } else {
    doc.moveDown(0.8);
  }

  const signWidth = 240;
  const signX = doc.page.width / 2 - signWidth / 2;
  doc.moveTo(signX, doc.y).lineTo(signX + signWidth, doc.y).strokeColor("#000").stroke();
  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#000").text(cert.doctor_name || "", signX, doc.y, { width: signWidth, align: "center" });
  doc.moveDown(0.1);
  doc.font("Helvetica").fontSize(8.5).fillColor("#333");
  // Orden solicitado: nombre (arriba), especialidad, registro SENESCYT, número de cédula.
  if (cert.doctor_specialty) doc.text(cert.doctor_specialty, signX, doc.y, { width: signWidth, align: "center" });
  if (cert.doctor_license) doc.text(`Reg. SENESCYT No. ${cert.doctor_license}`, signX, doc.y, { width: signWidth, align: "center" });
  if (cert.doctor_personal_id) doc.text(`C.I. ${cert.doctor_personal_id}`, signX, doc.y, { width: signWidth, align: "center" });

  doc.end();
}

certificatesRouter.get("/:id/pdf", async (req, res) => {
  const owned = await db.prepare(`SELECT id FROM certificates WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!owned) return res.status(404).json({ error: "Certificado no encontrado" });

  const ready = await getCertificateReadyForPdf(req.params.id);
  if (!ready) return res.status(404).json({ error: "Certificado no encontrado" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="certificado-${ready.cert.id}.pdf"`);
  renderCertificatePdf(ready.cert, ready.logoBuffer, res);
});

// POST /api/certificates/:id/send -> envío manual por WhatsApp o correo,
// bajo demanda (además del envío automático si está activado).
certificatesRouter.post("/:id/send", async (req, res) => {
  const cert = await db.prepare(`SELECT * FROM certificates WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!cert) return res.status(404).json({ error: "Certificado no encontrado" });

  const { channel } = req.body; // "whatsapp" | "email"
  const result = await notifyDocumentIssued({
    clinicId: req.user.clinic_id,
    kind: "certificate",
    id: cert.id,
    patientPhone: cert.patient_phone,
    patientEmail: cert.patient_email,
    patientName: cert.patient_full_name,
    forceChannel: channel,
  });
  res.json(result);
});
