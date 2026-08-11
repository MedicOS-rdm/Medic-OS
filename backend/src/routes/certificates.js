import { Router } from "express";
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, logAudit } from "../db.js";
import { spellDateSpanish, formatDateSlashes } from "../spanishDates.js";

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

function daysBetweenInclusive(fromISO, toISO) {
  const from = new Date(`${fromISO}T00:00:00`);
  const to = new Date(`${toISO}T00:00:00`);
  const diff = Math.round((to - from) / (1000 * 60 * 60 * 24));
  return diff >= 0 ? diff + 1 : null;
}

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

certificatesRouter.post("/", async (req, res) => {
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
  if (!TYPE_LABELS[certificate_type]) {
    return res.status(400).json({ error: "certificate_type debe ser enfermedad, aislamiento o teletrabajo" });
  }

  const patient = await db.prepare(`SELECT * FROM patients WHERE id = ? AND clinic_id = ?`).get(patient_id, req.user.clinic_id);
  if (!patient) return res.status(400).json({ error: "El paciente no existe" });

  const autoDays = daysBetweenInclusive(date_from, date_to);
  const finalDays = days_granted ?? autoDays;
  if (!finalDays || finalDays < 1) {
    return res.status(400).json({ error: "El rango de fechas o los días concedidos no son válidos" });
  }

  const doctor = await getDoctorProfile(req.user.clinic_id);

  const result = await db
    .prepare(
      `INSERT INTO certificates
        (clinic_id, patient_id, consultation_id,
         diagnosis_code, diagnosis_label, clinical_picture, presents_symptoms, certificate_type,
         description, days_granted, date_from, date_to,
         patient_full_name, patient_address, patient_phone, patient_email,
         patient_institution, patient_job_title, patient_id_number, patient_clinical_history_number,
         doctor_name, doctor_personal_id, doctor_license, doctor_specialty, doctor_email,
         clinic_name, clinic_address, clinic_phone, issue_place)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.clinic_id,
      patient_id,
      consultation_id ?? null,
      diagnosis_code ?? null,
      diagnosis_label ?? null,
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
      doctor.city
    );

  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "create", entity: "certificate", entityId: result.lastInsertRowid });

  const certificate = await db.prepare(`SELECT * FROM certificates WHERE id = ?`).get(result.lastInsertRowid);
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

certificatesRouter.put("/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT * FROM certificates WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!existing) return res.status(404).json({ error: "Certificado no encontrado" });

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
  if (!TYPE_LABELS[certificate_type]) {
    return res.status(400).json({ error: "certificate_type debe ser enfermedad, aislamiento o teletrabajo" });
  }

  const autoDays = daysBetweenInclusive(date_from, date_to);
  const finalDays = days_granted ?? autoDays;
  if (!finalDays || finalDays < 1) {
    return res.status(400).json({ error: "El rango de fechas o los días concedidos no son válidos" });
  }

  await db
    .prepare(
      `UPDATE certificates SET
        diagnosis_code = ?, diagnosis_label = ?, clinical_picture = ?, presents_symptoms = ?,
        certificate_type = ?, description = ?, days_granted = ?, date_from = ?, date_to = ?,
        updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ?`
    )
    .run(
      diagnosis_code ?? null,
      diagnosis_label ?? null,
      clinical_picture ?? null,
      presents_symptoms === false ? 0 : 1,
      certificate_type,
      description ?? null,
      finalDays,
      date_from,
      date_to,
      req.params.id
    );

  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "update", entity: "certificate", entityId: req.params.id });
  res.json(await db.prepare(`SELECT * FROM certificates WHERE id = ?`).get(req.params.id));
});

certificatesRouter.get("/:id/pdf", async (req, res) => {
  const cert = await db.prepare(`SELECT * FROM certificates WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!cert) return res.status(404).json({ error: "Certificado no encontrado" });

  // El logo se toma del perfil ACTUAL del médico (no queda "congelado" en
  // el certificado al emitirlo) — así, si el consultorio cambia de logo
  // más adelante, los documentos reimpresos reflejan el logo vigente.
  const doctorNow = await getDoctorProfile(req.user.clinic_id);
  const logoBuffer = parseLogoBuffer(doctorNow.logo_base64);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="certificado-${cert.id}.pdf"`);

  const doc = new PDFDocument({ size: "A4", margin: 42 });
  doc.pipe(res);

  const margin = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const label = (text) => doc.font("Helvetica-Bold").fontSize(9).fillColor("#333").text(text, { continued: false });
  const value = (text) => doc.font("Helvetica").fontSize(10).fillColor("#000").text(text || "—");
  const row = (labelText, valueText) => {
    // Evita que una etiqueta quede sola al pie de una página y su valor
    // aparezca huérfano al inicio de la siguiente.
    if (doc.y + 34 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    label(labelText);
    value(valueText);
    doc.moveDown(0.55); // espacio entre cada punto para que no se vea todo pegado
  };
  const sectionTitle = (text) => {
    doc.moveDown(0.35);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND_BLUE).text(text);
    doc.moveTo(doc.x, doc.y + 3).lineTo(doc.page.width - doc.page.margins.right, doc.y + 3).strokeColor(BRAND_BLUE).opacity(0.35).stroke().opacity(1);
    doc.moveDown(0.5);
  };

  // ---------- Encabezado ----------
  // Logo del consultorio a la izquierda, logo de MedicOs (la aplicación) a
  // la derecha, y en el centro — apilados y centrados — el título del
  // documento, el nombre del médico (con mayor tamaño que el resto) y el
  // nombre del consultorio.
  const logoSize = 44;
  const headerTop = doc.y;

  if (logoBuffer) {
    doc.image(logoBuffer, margin, headerTop, { width: logoSize, height: logoSize });
  }
  if (appLogoBuffer) {
    doc.image(appLogoBuffer, doc.page.width - margin - logoSize, headerTop, { width: logoSize, height: logoSize });
  }

  doc.font("Helvetica-Bold").fontSize(17).fillColor(BRAND_BLUE).text("CERTIFICADO MÉDICO", margin, headerTop + 2, {
    width: contentWidth,
    align: "center",
  });
  if (cert.doctor_name) {
    doc.font("Helvetica-Bold").fontSize(13).fillColor(BRAND_BLUE).text(cert.doctor_name, margin, doc.y + 3, {
      width: contentWidth,
      align: "center",
    });
  }
  doc.font("Helvetica").fontSize(10).fillColor("#444").text(cert.clinic_name || "Consultorio médico", margin, doc.y + 2, {
    width: contentWidth,
    align: "center",
  });

  doc.x = margin; // volvemos al margen izquierdo normal para el resto del documento
  doc.y = Math.max(doc.y, headerTop + logoSize) + 14; // nunca empezar antes de que terminen los logos, más aire antes del cuerpo

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

  // Espacio reservado para la firma: si no queda suficiente aire al final
  // de la página, mejor pasamos a una página nueva en vez de apretarla
  // contra el pie de página.
  const signatureBlockHeight = 130;
  if (doc.y + signatureBlockHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  } else {
    doc.moveDown(2.2);
  }

  const signWidth = 220;
  const signX = doc.page.width / 2 - signWidth / 2;
  doc.moveTo(signX, doc.y).lineTo(signX + signWidth, doc.y).strokeColor("#000").stroke();
  doc.moveDown(0.35);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#000").text(cert.doctor_name || "", signX, doc.y, { width: signWidth, align: "center" });
  doc.moveDown(0.1);
  doc.font("Helvetica").fontSize(9).fillColor("#333");
  if (cert.doctor_personal_id) doc.text(`C.I. ${cert.doctor_personal_id}`, signX, doc.y, { width: signWidth, align: "center" });
  if (cert.doctor_specialty) doc.text(cert.doctor_specialty, signX, doc.y, { width: signWidth, align: "center" });
  if (cert.doctor_license) doc.text(`Reg. SENESCYT No. ${cert.doctor_license}`, signX, doc.y, { width: signWidth, align: "center" });

  doc.end();
});
