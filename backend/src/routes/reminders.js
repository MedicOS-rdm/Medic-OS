import { Router } from "express";
import { db } from "../db.js";
import { requireRole } from "../auth.js";
import { getSettings, sendReminderForAppointment } from "../reminders.js";

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
    twilio_auth_token && twilio_auth_token !== "••••••••" ? twilio_auth_token : current.twilio_auth_token;

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
remindersWebhookRouter.post("/webhook", async (req, res) => {
  const from = String(req.body.From || "").replace("whatsapp:", "");
  const to = String(req.body.To || "").replace("whatsapp:", "");
  const body = String(req.body.Body || "").trim();
  const digits = from.replace(/\D/g, "").slice(-10);

  let clinicId = null;
  if (to) {
    const settings = await db.prepare(`SELECT clinic_id FROM reminder_settings WHERE twilio_from_number = ?`).get(to);
    if (settings) clinicId = settings.clinic_id;
  }

  const patientQuery = clinicId
    ? await db
        .prepare(
          `SELECT id, clinic_id FROM patients WHERE clinic_id = ? AND REPLACE(REPLACE(REPLACE(phone,'-',''),' ',''),'+','') LIKE ?`
        )
        .get(clinicId, `%${digits}`)
    : await db
        .prepare(`SELECT id, clinic_id FROM patients WHERE REPLACE(REPLACE(REPLACE(phone,'-',''),' ',''),'+','') LIKE ?`)
        .get(`%${digits}`);

  let replyText = "No pudimos identificar tu cita. Por favor comunícate al consultorio.";

  if (patientQuery) {
    const appt = await db
      .prepare(
        `SELECT * FROM appointments
         WHERE patient_id = ? AND clinic_id = ? AND status IN ('programada','confirmada')
         ORDER BY start_time ASC LIMIT 1`
      )
      .get(patientQuery.id, patientQuery.clinic_id);

    if (appt) {
      if (body === "1") {
        await db
          .prepare(`UPDATE appointments SET status = 'confirmada', updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
          .run(appt.id);
        replyText = "¡Gracias! Tu cita quedó confirmada.";
      } else if (body === "2") {
        await db
          .prepare(`UPDATE appointments SET status = 'cancelada', updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`)
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
