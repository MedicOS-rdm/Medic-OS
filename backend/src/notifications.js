// Envío de recetas y certificados médicos por WhatsApp y/o correo
// electrónico, automático (al crearlos) o manual (botón "Enviar").
//
// El envío por WhatsApp reutiliza las MISMAS credenciales de Twilio que
// "Recordatorios automáticos" (reminder_settings) — un solo número de
// WhatsApp Business por consultorio para todo. El correo usa su propia
// configuración SMTP (notification_settings), porque suele ser una
// cuenta de correo distinta a la del WhatsApp.
//
// Los helpers que arman el PDF de receta/certificado se importan de forma
// DINÁMICA (dentro de la función, no arriba del archivo) a propósito:
// routes/certificates.js y routes/prescriptions.js importan
// `notifyDocumentIssued` de este mismo archivo, así que un import estático
// aquí crearía una dependencia circular. El import dinámico se resuelve en
// tiempo de ejecución, cuando ambos módulos ya están completamente
// cargados, así que evita el problema.

import { PassThrough } from "node:stream";
import { db } from "./db.js";
import { getSettings as getReminderSettings } from "./reminders.js";

function getPublicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
}

export async function getNotificationSettings(clinicId) {
  const row = await db.prepare(`SELECT * FROM notification_settings WHERE clinic_id = ?`).get(clinicId);
  return (
    row || {
      clinic_id: clinicId,
      auto_send_whatsapp: 0,
      auto_send_email: 0,
      smtp_host: "",
      smtp_port: 587,
      smtp_secure: 0,
      smtp_user: "",
      smtp_pass: "",
      smtp_from_name: "",
      smtp_from_email: "",
    }
  );
}

async function sendWhatsAppDocument({ clinicId, phone, message, mediaUrl }) {
  const s = await getReminderSettings(clinicId);
  if (!s.twilio_account_sid || !s.twilio_auth_token || !s.twilio_from_number) {
    return { ok: false, error: "Faltan credenciales de WhatsApp (Twilio). Configúralas en \"Recordatorios automáticos\"." };
  }
  try {
    const { default: twilio } = await import("twilio");
    const client = twilio(s.twilio_account_sid, s.twilio_auth_token);
    await client.messages.create({
      from: `whatsapp:${s.twilio_from_number}`,
      to: `whatsapp:${phone}`,
      body: message,
      ...(mediaUrl ? { mediaUrl: [mediaUrl] } : {}),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sendEmailDocument({ clinicId, toEmail, subject, text, attachment }) {
  const s = await getNotificationSettings(clinicId);
  if (!s.smtp_host || !s.smtp_user || !s.smtp_pass) {
    return { ok: false, error: "Falta configurar el correo saliente (SMTP) en \"Envío automático\"." };
  }
  try {
    const { default: nodemailer } = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: s.smtp_host,
      port: s.smtp_port || 587,
      secure: Boolean(s.smtp_secure),
      auth: { user: s.smtp_user, pass: s.smtp_pass },
    });
    await transporter.sendMail({
      from: s.smtp_from_email ? `"${s.smtp_from_name || "MedicOs"}" <${s.smtp_from_email}>` : s.smtp_user,
      to: toEmail,
      subject,
      text,
      attachments: attachment ? [attachment] : [],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function streamToBuffer(renderFn) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = new PassThrough();
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
    renderFn(stream);
  });
}

async function getShareToken(kind, id) {
  if (kind === "certificate") {
    const row = await db.prepare(`SELECT share_token FROM certificates WHERE id = ?`).get(id);
    return row?.share_token || null;
  }
  const row = await db.prepare(`SELECT qr_token FROM prescriptions WHERE id = ?`).get(id);
  return row?.qr_token || null;
}

// Construye un "request" mínimo (protocolo + host) para reutilizar
// getPrescriptionReadyForPdf, que normalmente arma la URL del QR a partir
// de un request HTTP real. Aquí, al enviar por correo, no hay uno.
function buildFakeReq() {
  const baseUrl = getPublicBaseUrl() || "http://localhost:4000";
  const url = new URL(baseUrl);
  return { protocol: url.protocol.replace(":", ""), get: () => url.host };
}

async function buildPdfAttachment(kind, id) {
  if (kind === "certificate") {
    const { getCertificateReadyForPdf, renderCertificatePdf } = await import("./routes/certificates.js");
    const ready = await getCertificateReadyForPdf(id);
    if (!ready) return null;
    const buffer = await streamToBuffer((writable) => renderCertificatePdf(ready.cert, ready.logoBuffer, writable));
    return { filename: `certificado-${id}.pdf`, content: buffer, contentType: "application/pdf" };
  }
  const { getPrescriptionReadyForPdf, renderPrescriptionPdf } = await import("./routes/prescriptions.js");
  const ready = await getPrescriptionReadyForPdf(id, buildFakeReq());
  if (!ready) return null;
  const buffer = await streamToBuffer((writable) => renderPrescriptionPdf(ready, writable));
  return { filename: `receta-${id}.pdf`, content: buffer, contentType: "application/pdf" };
}

// Orquestador de alto nivel: se llama al crear una receta/certificado
// (envío automático, según la configuración del consultorio) o desde el
// botón "Enviar" (envío manual, forzando un canal específico).
export async function notifyDocumentIssued({ clinicId, kind, id, patientPhone, patientEmail, patientName, forceChannel }) {
  const settings = await getNotificationSettings(clinicId);
  const results = {};

  const wantsWhatsapp = forceChannel ? forceChannel === "whatsapp" : Boolean(settings.auto_send_whatsapp);
  const wantsEmail = forceChannel ? forceChannel === "email" : Boolean(settings.auto_send_email);

  if (!wantsWhatsapp && !wantsEmail) return results;

  const label = kind === "certificate" ? "certificado médico" : "receta";
  const baseUrl = getPublicBaseUrl();

  if (wantsWhatsapp) {
    if (!patientPhone) {
      results.whatsapp = { ok: false, error: "El paciente no tiene un teléfono registrado" };
    } else if (!baseUrl) {
      results.whatsapp = {
        ok: false,
        error: "Falta configurar la URL pública del servidor (variable de entorno PUBLIC_BASE_URL) para poder adjuntar el PDF por WhatsApp",
      };
    } else {
      const token = await getShareToken(kind, id);
      const mediaUrl = token
        ? `${baseUrl}/api/share/${kind === "certificate" ? "certificates" : "prescriptions"}/${token}/pdf`
        : null;
      results.whatsapp = await sendWhatsAppDocument({
        clinicId,
        phone: patientPhone,
        message: `Hola ${patientName || ""}, aquí tiene su ${label} de MedicOs.${mediaUrl ? ` Puede descargarlo aquí: ${mediaUrl}` : ""}`,
        mediaUrl,
      });
    }
  }

  if (wantsEmail) {
    if (!patientEmail) {
      results.email = { ok: false, error: "El paciente no tiene un correo registrado" };
    } else {
      const attachment = await buildPdfAttachment(kind, id);
      results.email = await sendEmailDocument({
        clinicId,
        toEmail: patientEmail,
        subject: `Tu ${label} — MedicOs`,
        text: `Hola ${patientName || ""}, adjunto encontrarás tu ${label} emitido en MedicOs.`,
        attachment,
      });
    }
  }

  return results;
}
