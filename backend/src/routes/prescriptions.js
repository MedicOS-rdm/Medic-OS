import { Router } from "express";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import crypto from "node:crypto";
import { db, logAudit, newQrToken, withTransaction } from "../db.js";
import { notifyDocumentIssued } from "../notifications.js";
import { findAllergyConflicts } from "../validators.js";

export const prescriptionsRouter = Router();

// Mismo azul institucional de MedicOs usado en el certificado médico
// (--accent del frontend), para que el nombre del consultorio y del
// médico se vean con el color de la app también en la receta.
const BRAND_BLUE = "#0460d3";

// Cuánto dura vigente el enlace público (WhatsApp) antes de expirar solo
// (C-03) — igual que en certificates.js.
const SHARE_LINK_VALID_DAYS = 30;
export function newShareExpiry() {
  return new Date(Date.now() + SHARE_LINK_VALID_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
export function newShareToken() {
  return crypto.randomBytes(16).toString("hex");
}

async function getDoctorProfile(clinicId) {
  return (
    (await db.prepare(`SELECT * FROM doctor_profile WHERE clinic_id = ?`).get(clinicId)) || {
      full_name: "",
      professional_license: "",
      specialty: "",
      clinic_name: "",
      clinic_address: "",
      clinic_phone: "",
      mobile_phone: "",
    }
  );
}

function calcAge(birthDate) {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}

// Formatea una fecha "YYYY-MM-DD" (sin hora) a texto legible sin caer en
// el corrimiento de día por zona horaria que da `new Date("YYYY-MM-DD")`
// (se interpreta como medianoche UTC). Se fija el mediodía para evitar eso.
function formatIsoDate(isoDate) {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}

// Convierte un "data URI" (ej. "data:image/png;base64,....") guardado en
// doctor_profile.logo_base64 a un Buffer que pdfkit pueda dibujar. Si no
// hay logo o el formato no es válido, regresa null en vez de tronar —
// así un logo mal guardado nunca rompe la generación del PDF.
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

prescriptionsRouter.post("/", async (req, res) => {
  const { patient_id, consultation_id, items, instructions } = req.body;

  if (!patient_id) return res.status(400).json({ error: "patient_id es obligatorio" });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Agrega al menos un medicamento" });
  }
  if (items.length > 30) {
    return res.status(400).json({ error: "Una receta no puede tener más de 30 medicamentos" });
  }
  // A-07 de la auditoría: validación mínima de cada línea (antes se
  // guardaba cualquier cosa, incluyendo un medicamento sin nombre).
  for (const item of items) {
    if (!item || typeof item.generic_name !== "string" || !item.generic_name.trim()) {
      return res.status(400).json({ error: "Cada medicamento necesita un nombre genérico" });
    }
  }

  const patient = await db.prepare(`SELECT id, allergies FROM patients WHERE id = ? AND clinic_id = ?`).get(patient_id, req.user.clinic_id);
  if (!patient) return res.status(400).json({ error: "El paciente no existe" });

  // GRAVE de la auditoría: alerta de alergias antes de emitir la receta.
  // Es una CONFIRMACIÓN, no un bloqueo automático — si el médico ya la vio
  // y decide continuar (a su criterio clínico), reenvía la misma petición
  // con confirm_allergy_override: true.
  if (!req.body.confirm_allergy_override) {
    const conflicts = findAllergyConflicts(patient.allergies, items);
    if (conflicts.length > 0) {
      return res.status(409).json({
        error: "El paciente tiene registrada una alergia que coincide con uno de estos medicamentos.",
        allergy_conflicts: conflicts,
      });
    }
  }

  // A-08: si viene ligada a una consulta puntual, esa consulta debe ser
  // del mismo paciente.
  if (consultation_id) {
    const consultation = await db
      .prepare(`SELECT id FROM consultations WHERE id = ? AND patient_id = ? AND clinic_id = ?`)
      .get(consultation_id, patient_id, req.user.clinic_id);
    if (!consultation) {
      return res.status(400).json({ error: "consultation_id no corresponde a este paciente" });
    }
  }

  const doctor = await getDoctorProfile(req.user.clinic_id);
  const qr_token = newQrToken();
  const share_token = newShareToken();
  const share_expires_at = newShareExpiry();

  const result = await db
    .prepare(
      `INSERT INTO prescriptions
        (clinic_id, patient_id, consultation_id, qr_token, share_token, share_expires_at, items_json, instructions,
         doctor_name, doctor_license, doctor_specialty, doctor_mobile_phone, clinic_name, clinic_address, clinic_phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.clinic_id,
      patient_id,
      consultation_id ?? null,
      qr_token,
      share_token,
      share_expires_at,
      JSON.stringify(items),
      instructions ?? null,
      doctor.full_name,
      doctor.professional_license,
      doctor.specialty,
      doctor.mobile_phone,
      doctor.clinic_name,
      doctor.clinic_address,
      doctor.clinic_phone
    );

  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "create", entity: "prescription", entityId: result.lastInsertRowid });

  const prescription = await db.prepare(`SELECT * FROM prescriptions WHERE id = ?`).get(result.lastInsertRowid);

  const patientFull = await db.prepare(`SELECT * FROM patients WHERE id = ?`).get(patient_id);
  notifyDocumentIssued({
    clinicId: req.user.clinic_id,
    kind: "prescription",
    id: prescription.id,
    patientPhone: patientFull?.phone,
    patientEmail: patientFull?.email,
    patientName: patientFull ? `${patientFull.first_name} ${patientFull.last_name}` : "",
  }).catch((err) => console.error("Error enviando notificación de receta:", err));

  res.status(201).json({ ...prescription, items: JSON.parse(prescription.items_json) });
});

prescriptionsRouter.get("/patient/:patientId", async (req, res) => {
  const rows = await db
    .prepare(`SELECT * FROM prescriptions WHERE patient_id = ? AND clinic_id = ? ORDER BY created_at DESC`)
    .all(req.params.patientId, req.user.clinic_id);
  res.json(rows.map((r) => ({ ...r, items: JSON.parse(r.items_json) })));
});

// GET /api/prescriptions/:id -> una receta (para precargar el formulario de edición)
prescriptionsRouter.get("/:id", async (req, res) => {
  const rx = await db.prepare(`SELECT * FROM prescriptions WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!rx) return res.status(404).json({ error: "Receta no encontrada" });
  res.json({ ...rx, items: JSON.parse(rx.items_json) });
});

// PUT /api/prescriptions/:id -> C-04: igual que en certificates.js, ya no
// sobrescribe la receta original. Crea una receta NUEVA con los cambios
// (una corrección) y conserva la original marcada como "corregida", con
// su propio folio y enlace hacia la versión vigente.
prescriptionsRouter.put("/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM prescriptions WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Receta no encontrada" });
  if (existing.status === "anulado") {
    return res.status(409).json({ error: "Esta receta fue anulada y no se puede corregir. Emite una nueva." });
  }
  if (existing.status === "corregido") {
    return res.status(409).json({ error: "Esta receta ya fue reemplazada por una corrección posterior." });
  }

  const { items, instructions } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Agrega al menos un medicamento" });
  }
  if (items.length > 30) {
    return res.status(400).json({ error: "Una receta no puede tener más de 30 medicamentos" });
  }
  for (const item of items) {
    if (!item || typeof item.generic_name !== "string" || !item.generic_name.trim()) {
      return res.status(400).json({ error: "Cada medicamento necesita un nombre genérico" });
    }
  }

  if (!req.body.confirm_allergy_override) {
    const patient = await db.prepare(`SELECT allergies FROM patients WHERE id = ?`).get(existing.patient_id);
    const conflicts = findAllergyConflicts(patient?.allergies, items);
    if (conflicts.length > 0) {
      return res.status(409).json({
        error: "El paciente tiene registrada una alergia que coincide con uno de estos medicamentos.",
        allergy_conflicts: conflicts,
      });
    }
  }

  const qr_token = newQrToken();
  const share_token = newShareToken();
  const share_expires_at = newShareExpiry();

  // CRÍTICO POTENCIAL de la auditoría: igual que en certificates.js, crear
  // la corrección + marcar la original como "corregida" ahora corre en una
  // sola transacción.
  const newId = await withTransaction(async (tx) => {
    const result = await tx
      .prepare(
        `INSERT INTO prescriptions
          (clinic_id, patient_id, consultation_id, qr_token, share_token, share_expires_at, items_json, instructions,
           doctor_name, doctor_license, doctor_specialty, doctor_mobile_phone, clinic_name, clinic_address, clinic_phone,
           corrected_from_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        existing.clinic_id,
        existing.patient_id,
        existing.consultation_id,
        qr_token,
        share_token,
        share_expires_at,
        JSON.stringify(items),
        instructions ?? null,
        existing.doctor_name,
        existing.doctor_license,
        existing.doctor_specialty,
        existing.doctor_mobile_phone,
        existing.clinic_name,
        existing.clinic_address,
        existing.clinic_phone,
        existing.id
      );

    await tx
      .prepare(
        `UPDATE prescriptions SET status = 'corregido', superseded_by_id = ?,
          updated_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id = ?`
      )
      .run(result.lastInsertRowid, existing.id);

    await logAudit({
      clinicId: req.user.clinic_id,
      actor: req.user.username,
      action: "correct",
      entity: "prescription",
      entityId: existing.id,
      detail: { new_id: result.lastInsertRowid },
      tx,
    });

    return result.lastInsertRowid;
  });

  const updated = await db.prepare(`SELECT * FROM prescriptions WHERE id = ?`).get(newId);
  res.json({ ...updated, items: JSON.parse(updated.items_json) });
});

// DELETE /api/prescriptions/:id -> C-04: anula (con motivo obligatorio) en
// vez de borrar físicamente. El enlace público deja de servir el PDF de
// inmediato.
prescriptionsRouter.delete("/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM prescriptions WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Receta no encontrada" });
  if (existing.status === "anulado") return res.status(409).json({ error: "Esta receta ya estaba anulada" });

  const reason = String(req.body?.reason || "").trim();
  if (reason.length < 5) {
    return res.status(400).json({ error: "Indica el motivo de la anulación (mínimo 5 caracteres)" });
  }

  await withTransaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE prescriptions SET status = 'anulado', void_reason = ?, voided_by = ?, share_revoked = 1,
          voided_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id = ?`
      )
      .run(reason, req.user.username, req.params.id);

    await logAudit({
      clinicId: req.user.clinic_id,
      actor: req.user.username,
      action: "void",
      entity: "prescription",
      entityId: req.params.id,
      detail: { reason },
      tx,
    });
  });

  const updated = await db.prepare(`SELECT * FROM prescriptions WHERE id = ?`).get(req.params.id);
  res.json({ ...updated, items: JSON.parse(updated.items_json) });
});

// POST /api/prescriptions/:id/share/revoke y /share/rotate -> igual que en
// certificates.js (C-03).
prescriptionsRouter.post("/:id/share/revoke", async (req, res) => {
  const existing = await db.prepare(`SELECT id FROM prescriptions WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Receta no encontrada" });
  await db.prepare(`UPDATE prescriptions SET share_revoked = 1 WHERE id = ?`).run(req.params.id);
  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "share_revoke", entity: "prescription", entityId: req.params.id });
  res.json({ ok: true });
});

prescriptionsRouter.post("/:id/share/rotate", async (req, res) => {
  const existing = await db.prepare(`SELECT id FROM prescriptions WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Receta no encontrada" });
  const share_token = newShareToken();
  const share_expires_at = newShareExpiry();
  await db
    .prepare(`UPDATE prescriptions SET share_token = ?, share_expires_at = ?, share_revoked = 0 WHERE id = ?`)
    .run(share_token, share_expires_at, req.params.id);
  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "share_rotate", entity: "prescription", entityId: req.params.id });
  res.json({ share_token, share_expires_at });
});

export async function getPrescriptionReadyForPdf(rxId, req) {
  const rx = await db.prepare(`SELECT * FROM prescriptions WHERE id = ?`).get(rxId);
  if (!rx) return null;

  const patient = await db.prepare(`SELECT * FROM patients WHERE id = ?`).get(rx.patient_id);
  const items = JSON.parse(rx.items_json);
  const verifyUrl = `${req.protocol}://${req.get("host")}/api/verify/${rx.qr_token}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 200 });
  const qrBuffer = Buffer.from(qrDataUrl.split(",")[1], "base64");

  // El logo se toma del perfil ACTUAL del médico (no queda "congelado" en
  // la receta al emitirla) — así, si el consultorio cambia de logo más
  // adelante, los documentos reimpresos reflejan el logo vigente, en vez
  // de duplicar la imagen completa en cada receta guardada.
  const doctorNow = await getDoctorProfile(rx.clinic_id);
  const logoBuffer = parseLogoBuffer(doctorNow.logo_base64);

  // Próxima consulta (fecha marcada en "Seguimiento / control" de la nota
  // de evolución que originó esta receta, si la receta viene ligada a una
  // consulta). Se muestra a la derecha de los datos del paciente.
  let nextVisitDate = null;
  if (rx.consultation_id) {
    const consultation = await db
      .prepare(`SELECT follow_up_date FROM consultations WHERE id = ?`)
      .get(rx.consultation_id);
    nextVisitDate = consultation?.follow_up_date || null;
  }

  return { rx, patient, items, qrBuffer, logoBuffer, nextVisitDate };
}

// Dibuja el PDF de la receta sobre cualquier stream escribible — la MISMA
// función que usan la descarga manual, el envío automático por correo y
// el link público de WhatsApp.
export function renderPrescriptionPdf({ rx, patient, items, qrBuffer, logoBuffer, nextVisitDate }, writable) {
  const doc = new PDFDocument({ size: "A5", margin: 40 });
  doc.pipe(writable);

  const contentLeft = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // ---------- Marca de agua: logo del consultorio, muy tenue, centrado
  // detrás de todo el contenido ----------
  if (logoBuffer) {
    const cursorX = doc.x;
    const cursorY = doc.y;
    const wmSize = 260;
    doc.opacity(0.06);
    doc.image(logoBuffer, (doc.page.width - wmSize) / 2, (doc.page.height - wmSize) / 2, {
      width: wmSize,
      height: wmSize,
    });
    doc.opacity(1);
    doc.x = cursorX;
    doc.y = cursorY;
  }

  // Aviso de estado (C-04/A-09): igual que en el certificado, una versión
  // vieja o anulada se marca de forma bien visible.
  if (rx.status === "anulado" || rx.status === "corregido") {
    const label = rx.status === "anulado" ? "ANULADA" : "REEMPLAZADA";
    doc.save();
    doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.font("Helvetica-Bold").fontSize(40).fillColor("#c0392b").opacity(0.22);
    doc.text(label, 0, doc.page.height / 2 - 20, { width: doc.page.width, align: "center" });
    doc.opacity(1);
    doc.restore();
  }

  // ---------- Encabezado: logo pequeño + nombre del consultorio centrado ----------
  const headerTop = doc.y;
  if (logoBuffer) {
    doc.image(logoBuffer, contentLeft, headerTop, { width: 34, height: 34 });
  }
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor(BRAND_BLUE)
    .text(rx.clinic_name || "Consultorio médico", contentLeft, headerTop, { width: contentWidth, align: "center" });
  doc.font("Helvetica").fontSize(10).fillColor("#555");
  if (rx.clinic_address) doc.text(rx.clinic_address, contentLeft, doc.y, { width: contentWidth, align: "center" });
  if (rx.clinic_phone) doc.text(`Tel: ${rx.clinic_phone}`, contentLeft, doc.y, { width: contentWidth, align: "center" });
  doc.x = contentLeft; // volvemos al margen izquierdo normal para el resto del documento
  if (logoBuffer) doc.y = Math.max(doc.y, headerTop + 38); // nunca terminar antes de que acabe el logo
  const statusLabel = { emitido: "Emitido", corregido: "Corregida (reemplazada)", anulado: "Anulada" }[rx.status] || "Emitido";
  doc.font("Helvetica").fontSize(6.5).fillColor("#999").text(`Folio N° ${rx.id} · Estado: ${statusLabel}`, contentLeft, doc.y, { width: contentWidth, align: "right" });
  doc.moveDown(0.5);

  // ---------- Datos del médico: solo nombre, especialidad y celular ----------
  doc.fillColor(BRAND_BLUE).font("Helvetica-Bold").fontSize(11).text(rx.doctor_name || "");
  doc.font("Helvetica").fontSize(9).fillColor("#555");
  if (rx.doctor_specialty) doc.text(rx.doctor_specialty);
  if (rx.doctor_mobile_phone) doc.text(`Cel: ${rx.doctor_mobile_phone}`);
  doc.moveDown();

  doc.strokeColor("#ccc").moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).stroke();
  doc.moveDown();

  // ---------- Datos del paciente (izquierda) + próxima consulta (derecha) ----------
  const patientBlockTop = doc.y;
  const nextVisitColWidth = 150;
  const nextVisitColX = doc.page.width - doc.page.margins.right - nextVisitColWidth;
  const patientColWidth = nextVisitColX - contentLeft - 10;

  doc.fillColor("#000").font("Helvetica-Bold").fontSize(10).text("Paciente:", contentLeft, patientBlockTop, {
    continued: true,
    width: patientColWidth,
  });
  doc.font("Helvetica").text(` ${patient.first_name} ${patient.last_name}`);
  const age = calcAge(patient.birth_date);
  doc.font("Helvetica").fontSize(9).fillColor("#555");
  const patientMeta = [age !== null ? `${age} años` : null, patient.allergies ? `Alergias: ${patient.allergies}` : null]
    .filter(Boolean)
    .join(" · ");
  if (patientMeta) doc.text(patientMeta, contentLeft, doc.y, { width: patientColWidth });
  doc
    .fillColor("#000")
    .fontSize(9)
    .text(`Fecha: ${new Date(rx.created_at.replace(" ", "T")).toLocaleDateString("es-MX")}`, contentLeft, doc.y, {
      width: patientColWidth,
    });
  const patientBlockBottom = doc.y;

  const nextVisitLabel = formatIsoDate(nextVisitDate);
  if (nextVisitLabel) {
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(BRAND_BLUE)
      .text("Próxima consulta:", nextVisitColX, patientBlockTop, { width: nextVisitColWidth, align: "right" });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#000")
      .text(nextVisitLabel, nextVisitColX, doc.y, { width: nextVisitColWidth, align: "right" });
  }

  doc.x = contentLeft;
  doc.y = Math.max(patientBlockBottom, doc.y);
  doc.moveDown();

  doc.font("Helvetica-Bold").fontSize(13).text("Rx", { underline: false });
  doc.moveDown(0.3);
  items.forEach((item, i) => {
    doc.font("Helvetica-Bold").fontSize(10).text(`${i + 1}. ${item.generic_name}${item.commercial_name ? ` (${item.commercial_name})` : ""}`);
    doc.font("Helvetica").fontSize(9).fillColor("#333");
    const line = [item.presentation, item.dose, item.frequency, item.duration].filter(Boolean).join(" · ");
    if (line) doc.text(line, { indent: 12 });
    doc.fillColor("#000");
    doc.moveDown(0.4);
  });

  if (rx.instructions) {
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(10).text("Indicaciones adicionales:");
    doc.font("Helvetica").fontSize(9).text(rx.instructions);
  }

  const qrSize = 90;
  const qrX = doc.page.width - doc.page.margins.right - qrSize;
  const qrY = doc.page.height - doc.page.margins.bottom - qrSize - 24;
  doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
  doc.font("Helvetica").fontSize(7).fillColor("#777").text("Verificar autenticidad", qrX - 20, qrY + qrSize + 4, {
    width: qrSize + 40,
    align: "center",
  });

  doc.end();
}

prescriptionsRouter.get("/:id/pdf", async (req, res) => {
  const owned = await db.prepare(`SELECT id FROM prescriptions WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!owned) return res.status(404).json({ error: "Receta no encontrada" });

  const ready = await getPrescriptionReadyForPdf(req.params.id, req);
  if (!ready) return res.status(404).json({ error: "Receta no encontrada" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="receta-${ready.rx.id}.pdf"`);
  renderPrescriptionPdf(ready, res);
});

// POST /api/prescriptions/:id/send -> envío manual por WhatsApp o correo,
// bajo demanda (además del envío automático si está activado).
prescriptionsRouter.post("/:id/send", async (req, res) => {
  const rx = await db.prepare(`SELECT * FROM prescriptions WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!rx) return res.status(404).json({ error: "Receta no encontrada" });

  const patient = await db.prepare(`SELECT * FROM patients WHERE id = ?`).get(rx.patient_id);
  const { channel } = req.body; // "whatsapp" | "email"
  const result = await notifyDocumentIssued({
    clinicId: req.user.clinic_id,
    kind: "prescription",
    id: rx.id,
    patientPhone: patient?.phone,
    patientEmail: patient?.email,
    patientName: patient ? `${patient.first_name} ${patient.last_name}` : "",
    forceChannel: channel,
  });
  res.json(result);
});
