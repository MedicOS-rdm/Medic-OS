import { Router } from "express";
import { db } from "../db.js";
import { requireRole } from "../auth.js";
import { webhookRateLimit } from "../rateLimiter.js";
import { getSettings, sendReminderForAppointment } from "../reminders.js";
import { encryptSecret } from "../secretCrypto.js";

export const remindersRouter = Router();   // rutas protegidas (sesión)
export const remindersWebhookRouter = Router(); // pública, la llama Twilio

// GET /api/reminder-settings -> configuración actual DE LA CLÍNICA del usuario (sin exponer el auth token completo)
remindersRouter.get("/reminder-settings", async (req, res) => {
  const s = await getSettings(req.user.clinic_id);
  res.json({
    ...s,
    twilio_auth_token: s.twilio_auth_token ? "••••••••" : "",
    has_twilio_auth_token: Boolean(s.twilio_auth_token),
  });
});

// PUT /api/reminder-settings -> solo médico, siempre sobre SU clínica
remindersRouter.put("/reminder-settings", requireRole("medico"), async (req, res) => {
  const {
    provider,
    twilio_account_sid,
    twilio_auth_token,
    twilio_from_number,
    message_template,
    hours_before,
    enabled,
  } = req.body;

  const current = await getSettings(req.user.clinic_id);
  const nextToken =
    twilio_auth_token && twilio_auth_token !== "••••••••" ? encryptSecret(twilio_auth_token) : encryptSecret(current.twilio_auth_token);

  await db
    .prepare(
      `INSERT INTO reminder_settings
        (clinic_id, provider, twilio_account_sid, twilio_auth_token, twilio_from_number, message_template, hours_before, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(clinic_id) DO UPDATE SET
         provider = excluded.provider,
         twilio_account_sid = excluded.twilio_account_sid,
         twilio_auth_token = excluded.twilio_auth_token,
         twilio_from_number = excluded.twilio_from_number,
         message_template = excluded.message_template,
         hours_before = excluded.hours_before,
         enabled = excluded.enabled`
    )
    .run(
      req.user.clinic_id,
      provider ?? "simulado",
      twilio_account_sid ?? "",
      nextToken ?? "",
      twilio_from_number ?? "",
      message_template ?? current.message_template,
      hours_before ?? 24,
      enabled ? 1 : 0
    );

  const s = await getSettings(req.user.clinic_id);
  res.json({ ...s, twilio_auth_token: s.twilio_auth_token ? "••••••••" : "" });
});

// POST /api/appointments/:id/send-reminder -> envío manual, dentro de la clínica del usuario
remindersRouter.post("/appointments/:id/send-reminder", async (req, res) => {
  const result = await sendReminderForAppointment(req.params.id, req.user.clinic_id);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// ---------- Webhook público (lo llama Twilio, sin sesión) ----------
//
// C-02 de la auditoría: este endpoint no verificaba que la petición
// realmente viniera de Twilio — cualquiera que conociera la URL podía
// simular respuestas "1"/"2" y confirmar o CANCELAR citas ajenas. Ahora se
// valida la cabecera X-Twilio-Signature con el auth token de la clínica
// correspondiente (según validateRequest de Twilio: HMAC-SHA1 sobre la URL
// completa + los parámetros del POST, exactamente el mismo algoritmo que
// usa Twilio para firmar). Si no coincide, se rechaza con 403 antes de
// tocar cualquier dato.
//
// De paso corrijo otro problema encontrado al revisar esta ruta: cuando no
// se lograba identificar la clínica por el número "To", el código buscaba
// el paciente por teléfono EN TODAS las clínicas (sin filtrar por
// clinic_id) — en una plataforma multi-clínica, dos consultorios distintos
// podrían tener pacientes con el mismo número o uno parecido, y esa
// consulta global podía terminar confirmando/cancelando la cita de la
// clínica equivocada. Ahora, si no se puede determinar la clínica de forma
// inequívoca, el webhook responde sin identificar ninguna cita — nunca
// busca "a ciegas" entre clínicas.
remindersWebhookRouter.post("/webhook", webhookRateLimit, async (req, res) => {
  const from = String(req.body.From || "").replace("whatsapp:", "");
  const to = String(req.body.To || "").replace("whatsapp:", "");
  const body = String(req.body.Body || "").trim();
  const digits = from.replace(/\D/g, "").slice(-10);

  let clinicId = null;
  let settings = null;
  if (to) {
    settings = await db.prepare(`SELECT * FROM reminder_settings WHERE twilio_from_number = ?`).get(to);
    if (settings) clinicId = settings.clinic_id;
  }

  // Sin clínica identificada no hay auth token con qué validar la firma,
  // y tampoco hay forma segura de buscar el paciente sin salirse del
  // límite de esa clínica — se corta aquí.
  if (!clinicId || !settings?.twilio_auth_token) {
    console.warn(`[reminders-webhook] No se pudo determinar la clínica para To="${to}"; petición rechazada.`);
    return res.status(403).type("text/xml").send(`<Response></Response>`);
  }

  const signature = req.headers["x-twilio-signature"];
  const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  let signatureValid = false;
  try {
    const { default: twilio } = await import("twilio");
    signatureValid = Boolean(
      signature && twilio.validateRequest(settings.twilio_auth_token, signature, fullUrl, req.body)
    );
  } catch (err) {
    console.error("[reminders-webhook] Error validando firma de Twilio:", err.message);
  }

  if (!signatureValid) {
    console.warn(`[reminders-webhook] Firma inválida o ausente para clinic_id=${clinicId}; petición rechazada.`);
    return res.status(403).type("text/xml").send(`<Response></Response>`);
  }

  const patientQuery = await db
    .prepare(
      `SELECT id, clinic_id FROM patients WHERE clinic_id = ? AND REPLACE(REPLACE(REPLACE(phone,'-',''),' ',''),'+','') LIKE ?`
    )
    .get(clinicId, `%${digits}`);

  let replyText = "No pudimos identificar tu cita. Por favor comunícate al consultorio.";

  if (patientQuery) {
    // GRAVE de la auditoría: en vez de adivinar "la próxima cita
    // programada/confirmada" del paciente (ambiguo si tiene más de una),
    // se busca primero a qué cita corresponde el RECORDATORIO SALIENTE
    // más reciente enviado a este número — esa es la conversación real
    // que el paciente está respondiendo. Solo si no hay ningún
    // recordatorio previo (p. ej. el paciente escribe espontáneamente sin
    // que se le haya mandado nada) se usa el criterio anterior como
    // respaldo.
    const recentReminder = await db
      .prepare(
        `SELECT rl.appointment_id, a.status FROM reminder_log rl
         JOIN appointments a ON a.id = rl.appointment_id
         WHERE rl.direction = 'out' AND a.clinic_id = ?
           AND REPLACE(REPLACE(REPLACE(rl.phone,'-',''),' ',''),'+','') LIKE ?
           AND a.status IN ('programada','confirmada')
         ORDER BY rl.created_at DESC LIMIT 1`
      )
      .get(patientQuery.clinic_id, `%${digits}`);

    const appt = recentReminder
      ? { id: recentReminder.appointment_id }
      : await db
          .prepare(
            `SELECT * FROM appointments
             WHERE patient_id = ? AND clinic_id = ? AND status IN ('programada','confirmada')
             ORDER BY start_time ASC LIMIT 1`
          )
          .get(patientQuery.id, patientQuery.clinic_id);

    if (appt) {
      if (body === "1") {
        await db
          .prepare(`UPDATE appointments SET status = 'confirmada', updated_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
          .run(appt.id);
        replyText = "¡Gracias! Tu cita quedó confirmada.";
      } else if (body === "2") {
        await db
          .prepare(`UPDATE appointments SET status = 'cancelada', updated_at = to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
          .run(appt.id);
        replyText = "Tu cita fue cancelada. Si deseas reagendar, comunícate al consultorio.";
      } else {
        replyText = "Por favor responde solo con 1 para CONFIRMAR o 2 para CANCELAR tu cita.";
      }
      await db
        .prepare(`INSERT INTO reminder_log (appointment_id, direction, channel, body) VALUES (?, 'in', 'twilio', ?)`)
        .run(appt.id, body);
    }
  }

  res.type("text/xml").send(`<Response><Message>${replyText}</Message></Response>`);
});
