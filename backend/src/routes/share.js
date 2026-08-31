// Rutas PÚBLICAS (sin sesión) que sirven el PDF de UNA receta o UN
// certificado específico, identificado por un token largo e imposible de
// adivinar — nunca por su id numérico. Así, WhatsApp (Twilio) puede
// descargar el archivo para adjuntarlo al mensaje sin necesitar el token
// de sesión del médico, y sin exponer los documentos de otros pacientes.
//
// C-03 de la auditoría: antes este enlace público NUNCA caducaba, no se
// podía revocar, y no quedaba registro de quién lo abrió — un documento
// filtrado (reenviado, encontrado en un chat, etc.) quedaba accesible para
// siempre. Ahora cada documento tiene su propia fecha de caducidad
// (`share_expires_at`, se fija al emitirlo) y puede revocarse manualmente
// desde la ficha del paciente (`share_revoked`); pasada la caducidad o tras
// revocarlo, el enlace responde 410 Gone. También se registra cada acceso
// en audit_log (A-09/C-03: "auditoría de accesos").
//
// A-09: un documento ANULADO (ver certificates.js/prescriptions.js) deja
// de estar disponible por este enlace público de inmediato, sin depender
// de que también haya expirado.
//
// Nota sobre recetas: antes el mismo qr_token servía tanto para el QR de
// verificación mínima (ver routes/verify.js) como para este PDF completo
// — quien escaneaba el QR de "solo verificar" también podía construir la
// URL del PDF entero. Ahora usan tokens distintos: qr_token (verificación)
// y share_token (PDF completo, el que de verdad debe caducar/revocarse).
import { Router } from "express";
import { db, logAudit } from "../db.js";
import { getCertificateReadyForPdf, renderCertificatePdf } from "./certificates.js";
import { getPrescriptionReadyForPdf, renderPrescriptionPdf } from "./prescriptions.js";

export const shareRouter = Router();

function isExpiredOrRevoked(row) {
  if (row.share_revoked) return "revocado";
  if (row.share_expires_at && new Date(row.share_expires_at).getTime() < Date.now()) return "expirado";
  return null;
}

shareRouter.get("/certificates/:token/pdf", async (req, res) => {
  const row = await db
    .prepare(`SELECT id, clinic_id, status, share_expires_at, share_revoked FROM certificates WHERE share_token = ?`)
    .get(req.params.token);
  if (!row) return res.status(404).send("Certificado no encontrado o enlace inválido");

  if (row.status === "anulado") {
    await logAudit({ clinicId: row.clinic_id, actor: "público", action: "public_view_blocked", entity: "certificate", entityId: row.id, detail: { reason: "anulado" } });
    return res.status(410).send("Este certificado fue anulado por el médico y ya no está disponible.");
  }
  const blockedReason = isExpiredOrRevoked(row);
  if (blockedReason) {
    await logAudit({ clinicId: row.clinic_id, actor: "público", action: "public_view_blocked", entity: "certificate", entityId: row.id, detail: { reason: blockedReason } });
    return res.status(410).send("Este enlace ya no está disponible (expiró o fue revocado). Pide al consultorio que te comparta uno nuevo.");
  }

  const ready = await getCertificateReadyForPdf(row.id);
  if (!ready) return res.status(404).send("Certificado no encontrado");

  await logAudit({ clinicId: row.clinic_id, actor: "público", action: "public_view", entity: "certificate", entityId: row.id });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="certificado-${ready.cert.id}.pdf"`);
  renderCertificatePdf(ready.cert, ready.logoBuffer, res);
});

shareRouter.get("/prescriptions/:token/pdf", async (req, res) => {
  const row = await db
    .prepare(`SELECT id, clinic_id, status, share_expires_at, share_revoked FROM prescriptions WHERE share_token = ?`)
    .get(req.params.token);
  if (!row) return res.status(404).send("Receta no encontrada o enlace inválido");

  if (row.status === "anulado") {
    await logAudit({ clinicId: row.clinic_id, actor: "público", action: "public_view_blocked", entity: "prescription", entityId: row.id, detail: { reason: "anulado" } });
    return res.status(410).send("Esta receta fue anulada por el médico y ya no está disponible.");
  }
  const blockedReason = isExpiredOrRevoked(row);
  if (blockedReason) {
    await logAudit({ clinicId: row.clinic_id, actor: "público", action: "public_view_blocked", entity: "prescription", entityId: row.id, detail: { reason: blockedReason } });
    return res.status(410).send("Este enlace ya no está disponible (expiró o fue revocado). Pide al consultorio que te comparta uno nuevo.");
  }

  const ready = await getPrescriptionReadyForPdf(row.id, req);
  if (!ready) return res.status(404).send("Receta no encontrada");

  await logAudit({ clinicId: row.clinic_id, actor: "público", action: "public_view", entity: "prescription", entityId: row.id });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="receta-${ready.rx.id}.pdf"`);
  renderPrescriptionPdf(ready, res);
});
