// Rutas PÚBLICAS (sin sesión) que sirven el PDF de UNA receta o UN
// certificado específico, identificado por un token largo e imposible de
// adivinar (el mismo qr_token/share_token que ya se usa para el QR de
// verificación) — nunca por su id numérico. Así, WhatsApp (Twilio) puede
// descargar el archivo para adjuntarlo al mensaje sin necesitar el token
// de sesión del médico, y sin exponer los documentos de otros pacientes.
import { Router } from "express";
import { db } from "../db.js";
import { getCertificateReadyForPdf, renderCertificatePdf } from "./certificates.js";
import { getPrescriptionReadyForPdf, renderPrescriptionPdf } from "./prescriptions.js";

export const shareRouter = Router();

shareRouter.get("/certificates/:token/pdf", async (req, res) => {
  const row = await db.prepare(`SELECT id FROM certificates WHERE share_token = ?`).get(req.params.token);
  if (!row) return res.status(404).send("Certificado no encontrado o enlace inválido");

  const ready = await getCertificateReadyForPdf(row.id);
  if (!ready) return res.status(404).send("Certificado no encontrado");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="certificado-${ready.cert.id}.pdf"`);
  renderCertificatePdf(ready.cert, ready.logoBuffer, res);
});

shareRouter.get("/prescriptions/:token/pdf", async (req, res) => {
  const row = await db.prepare(`SELECT id FROM prescriptions WHERE qr_token = ?`).get(req.params.token);
  if (!row) return res.status(404).send("Receta no encontrada o enlace inválido");

  const ready = await getPrescriptionReadyForPdf(row.id, req);
  if (!ready) return res.status(404).send("Receta no encontrada");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="receta-${ready.rx.id}.pdf"`);
  renderPrescriptionPdf(ready, res);
});
