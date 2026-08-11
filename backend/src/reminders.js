import { db } from "./db.js";

const DEFAULT_TEMPLATE =
  "Hola {paciente}, le recordamos su cita el {fecha} a las {hora} en {consultorio}. Responda 1 para CONFIRMAR o 2 para CANCELAR.";

export async function getSettings(clinicId) {
  return (
    (await db.prepare(`SELECT * FROM reminder_settings WHERE clinic_id = ?`).get(clinicId)) || {
      clinic_id: clinicId,
      provider: "simulado",
      twilio_account_sid: "",
      twilio_auth_token: "",
      twilio_from_number: "",
      message_template: DEFAULT_TEMPLATE,
      hours_before: 24,
      enabled: 0,
    }
  );
}

function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "long" });
}
function formatTime(iso) {
  return new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

export async function sendReminderForAppointment(appointmentId, clinicId) {
  const appt = await db
    .prepare(
      `SELECT a.*, p.first_name, p.last_name, p.phone
       FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.id = ? AND a.clinic_id = ?`
    )
    .get(appointmentId, clinicId);
  if (!appt) return { ok: false, error: "Cita no encontrada" };
  if (!appt.phone) return { ok: false, error: "El paciente no tiene teléfono registrado" };

  const settings = await getSettings(clinicId);
  const doctor = await db.prepare(`SELECT clinic_name FROM doctor_profile WHERE clinic_id = ?`).get(clinicId);
  const message = renderTemplate(settings.message_template, {
    paciente: `${appt.first_name} ${appt.last_name}`,
    fecha: formatDate(appt.start_time),
    hora: formatTime(appt.start_time),
    consultorio: doctor?.clinic_name || "el consultorio",
  });

  let result;
  if (settings.provider === "twilio_whatsapp" || settings.provider === "twilio_sms") {
    result = await sendViaTwilio(settings, appt.phone, message, settings.provider === "twilio_whatsapp");
  } else {
    console.log(`[recordatorio SIMULADO clínica ${clinicId} -> ${appt.phone}] ${message}`);
    result = { ok: true, simulated: true };
  }

  if (result.ok) {
    await db
      .prepare(`UPDATE appointments SET reminder_sent_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), reminder_channel = ? WHERE id = ?`)
      .run(result.simulated ? "simulado" : settings.provider, appointmentId);
    await db
      .prepare(`INSERT INTO reminder_log (appointment_id, direction, channel, body) VALUES (?, 'out', ?, ?)`)
      .run(appointmentId, result.simulated ? "simulado" : settings.provider, message);
  }

  return { ok: result.ok, channel: settings.provider, simulated: Boolean(result.simulated), error: result.error, message };
}

async function sendViaTwilio(settings, phone, message, isWhatsapp) {
  if (!settings.twilio_account_sid || !settings.twilio_auth_token || !settings.twilio_from_number) {
    return { ok: false, error: "Faltan credenciales de Twilio en la configuración" };
  }
  try {
    const { default: twilio } = await import("twilio");
    const client = twilio(settings.twilio_account_sid, settings.twilio_auth_token);
    const prefix = isWhatsapp ? "whatsapp:" : "";
    await client.messages.create({
      from: `${prefix}${settings.twilio_from_number}`,
      to: `${prefix}${phone}`,
      body: message,
    });
    return { ok: true, simulated: false };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function checkAndSendDueReminders() {
  const activeSettings = await db.prepare(`SELECT * FROM reminder_settings WHERE enabled = 1`).all();

  for (const settings of activeSettings) {
    const windowStart = new Date(Date.now() + (settings.hours_before - 0.5) * 3600 * 1000).toISOString();
    const windowEnd = new Date(Date.now() + (settings.hours_before + 0.5) * 3600 * 1000).toISOString();

    const due = await db
      .prepare(
        `SELECT id FROM appointments
         WHERE clinic_id = ? AND status = 'programada' AND reminder_sent_at IS NULL
         AND start_time BETWEEN ? AND ?`
      )
      .all(settings.clinic_id, windowStart, windowEnd);

    for (const row of due) {
      await sendReminderForAppointment(row.id, settings.clinic_id);
    }
  }
}
