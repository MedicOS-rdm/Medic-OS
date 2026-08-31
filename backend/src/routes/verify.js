import { Router } from "express";
import { db, logAudit } from "../db.js";

export const verifyRouter = Router();

// GET /api/verify/:token — endpoint PÚBLICO (lo abre cualquiera que
// escanee el QR impreso en la receta, sin sesión ni contraseña).
//
// C-01 de la auditoría: antes esta ruta devolvía el nombre completo del
// paciente y la lista completa de medicamentos recetados — es decir,
// bastaba con encontrar o adivinar el enlace (el token es corto y viaja
// impreso en papel/PDF que circula por WhatsApp) para ver qué enfermedad
// o tratamiento tiene una persona. Su único propósito legítimo es que un
// farmacéutico o el propio paciente confirmen que la receta es AUTÉNTICA
// y sigue VIGENTE — no reemplaza mostrar la receta física/PDF completa.
// Ahora solo se expone lo mínimo necesario para ese propósito: validez,
// estado del documento, quién la emitió (información profesional pública,
// no del paciente) y cuándo. El nombre del paciente y los medicamentos ya
// NO viajan en esta respuesta.
verifyRouter.get("/:token", async (req, res) => {
  const rx = await db.prepare(`SELECT * FROM prescriptions WHERE qr_token = ?`).get(req.params.token);
  if (!rx) return res.status(404).json({ valid: false, error: "Receta no encontrada" });

  await logAudit({
    clinicId: rx.clinic_id,
    actor: "público (QR)",
    action: "public_verify",
    entity: "prescription",
    entityId: rx.id,
  });

  const voided = rx.status === "anulado";
  res.json({
    valid: !voided,
    status: rx.status || "emitido",
    issued_at: rx.created_at,
    doctor_name: rx.doctor_name,
    doctor_license: rx.doctor_license,
    clinic_name: rx.clinic_name,
    ...(voided ? { void_reason: rx.void_reason, voided_at: rx.voided_at } : {}),
  });
});

