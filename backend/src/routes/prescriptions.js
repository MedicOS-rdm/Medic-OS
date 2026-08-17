import { Router } from "express";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { db, logAudit, newQrToken } from "../db.js";
import { notifyDocumentIssued } from "../notifications.js";

export const prescriptionsRouter = Router();

// Mismo azul institucional de MedicOs usado en el certificado médico
// (--accent del frontend), para que el nombre del consultorio y del
// médico se vean con el color de la app también en la receta.
const BRAND_BLUE = "#0460d3";

async function getDoctorProfile(clinicId) {
  return (
    (await db.prepare(`SELECT * FROM doctor_profile WHERE clinic_id = ?`).get(clinicId)) || {
      full_name: "",
      professional_license: "",
      specialty: "",
      clinic_name: "",
      clinic_address: "",
      clinic_phone: "",
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

  const patient = await db.prepare(`SELECT id FROM patients WHERE id = ? AND clinic_id = ?`).get(patient_id, req.user.clinic_id);
  if (!patient) return res.status(400).json({ error: "El paciente no existe" });

  const doctor = await getDoctorProfile(req.user.clinic_id);
  const qr_token = newQrToken();

  const result = await db
    .prepare(
      `INSERT INTO prescriptions
        (clinic_id, patient_id, consultation_id, qr_token, items_json, instructions,
         doctor_name, doctor_license, doctor_specialty, clinic_name, clinic_address, clinic_phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.clinic_id,
      patient_id,
      consultation_id ?? null,
      qr_token,
      JSON.stringify(items),
      instructions ?? null,
      doctor.full_name,
      doctor.professional_license,
      doctor.specialty,
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

// PUT /api/prescriptions/:id -> corregir una receta ya emitida (por si se escribió con un error)
prescriptionsRouter.put("/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM prescriptions WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Receta no encontrada" });

  const { items, instructions } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Agrega al menos un medicamento" });
  }

  await db
    .prepare(`UPDATE prescriptions SET items_json = ?, instructions = ?, updated_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
    .run(JSON.stringify(items), instructions ?? null, req.params.id);

  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "update", entity: "prescription", entityId: req.params.id });

  const updated = await db.prepare(`SELECT * FROM prescriptions WHERE id = ?`).get(req.params.id);
  res.json({ ...updated, items: JSON.parse(updated.items_json) });
});

// DELETE /api/prescriptions/:id -> borra una receta emitida por error
prescriptionsRouter.delete("/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM prescriptions WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Receta no encontrada" });

  await db.prepare(`DELETE FROM prescriptions WHERE id = ?`).run(req.params.id);
  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "delete", entity: "prescription", entityId: req.params.id });
  res.json({ ok: true });
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

  return { rx, patient, items, qrBuffer, logoBuffer };
}

// Dibuja el PDF de la receta sobre cualquier stream escribible — la MISMA
// función que usan la descarga manual, el envío automático por correo y
// el link público de WhatsApp.
export function renderPrescriptionPdf({ rx, patient, items, qrBuffer, logoBuffer }, writable) {
  const doc = new PDFDocument({ size: "A5", margin: 40 });
  doc.pipe(writable);

  const textStartX = logoBuffer ? doc.x + 46 : doc.x;
  const headerTop = doc.y;
  if (logoBuffer) {
    doc.image(logoBuffer, doc.x, headerTop, { width: 38, height: 38 });
  }
  doc.font("Helvetica-Bold").fontSize(16).fillColor(BRAND_BLUE).text(rx.clinic_name || "Consultorio médico", textStartX, headerTop);
  doc.font("Helvetica").fontSize(10).fillColor("#555");
  if (rx.clinic_address) doc.text(rx.clinic_address, textStartX);
  if (rx.clinic_phone) doc.text(`Tel: ${rx.clinic_phone}`, textStartX);
  doc.x = doc.page.margins.left; // volvemos al margen izquierdo normal para el resto del documento
  if (logoBuffer) doc.y = Math.max(doc.y, headerTop + 42); // nunca empezar antes de que termine el logo
  doc.moveDown(0.5);
  doc.fillColor(BRAND_BLUE).font("Helvetica-Bold").fontSize(11).text(rx.doctor_name || "");
  doc.font("Helvetica").fontSize(9).fillColor("#555");
  const doctorLine = [rx.doctor_specialty, rx.doctor_license ? `Cédula ${rx.doctor_license}` : null]
    .filter(Boolean)
    .join(" · ");
  if (doctorLine) doc.text(doctorLine);
  doc.moveDown();

  doc.strokeColor("#ccc").moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).stroke();
  doc.moveDown();

  doc.fillColor("#000").font("Helvetica-Bold").fontSize(10).text("Paciente:", { continued: true });
  doc.font("Helvetica").text(` ${patient.first_name} ${patient.last_name}`);
  const age = calcAge(patient.birth_date);
  doc.font("Helvetica").fontSize(9).fillColor("#555");
  const patientMeta = [age !== null ? `${age} años` : null, patient.allergies ? `Alergias: ${patient.allergies}` : null]
    .filter(Boolean)
    .join(" · ");
  if (patientMeta) doc.text(patientMeta);
  doc.fillColor("#000").fontSize(9).text(`Fecha: ${new Date(rx.created_at.replace(" ", "T")).toLocaleDateString("es-MX")}`);
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
