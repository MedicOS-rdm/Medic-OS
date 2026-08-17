import { Router } from "express";
import { db } from "../db.js";
import { requireRole } from "../auth.js";
import { getNotificationSettings } from "../notifications.js";

export const notificationSettingsRouter = Router();

// GET /api/notification-settings -> configuración actual del consultorio
// (sin exponer la contraseña SMTP completa)
notificationSettingsRouter.get("/notification-settings", async (req, res) => {
  const s = await getNotificationSettings(req.user.clinic_id);
  res.json({
    ...s,
    smtp_pass: s.smtp_pass ? "••••••••" : "",
    has_smtp_pass: Boolean(s.smtp_pass),
  });
});

// PUT /api/notification-settings -> solo médico
notificationSettingsRouter.put("/notification-settings", requireRole("medico"), async (req, res) => {
  const {
    auto_send_whatsapp,
    auto_send_email,
    smtp_host,
    smtp_port,
    smtp_secure,
    smtp_user,
    smtp_pass,
    smtp_from_name,
    smtp_from_email,
  } = req.body;

  const current = await getNotificationSettings(req.user.clinic_id);
  const nextPass = smtp_pass && smtp_pass !== "••••••••" ? smtp_pass : current.smtp_pass;

  await db
    .prepare(
      `INSERT INTO notification_settings
        (clinic_id, auto_send_whatsapp, auto_send_email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from_name, smtp_from_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(clinic_id) DO UPDATE SET
         auto_send_whatsapp = excluded.auto_send_whatsapp,
         auto_send_email = excluded.auto_send_email,
         smtp_host = excluded.smtp_host,
         smtp_port = excluded.smtp_port,
         smtp_secure = excluded.smtp_secure,
         smtp_user = excluded.smtp_user,
         smtp_pass = excluded.smtp_pass,
         smtp_from_name = excluded.smtp_from_name,
         smtp_from_email = excluded.smtp_from_email`
    )
    .run(
      req.user.clinic_id,
      auto_send_whatsapp ? 1 : 0,
      auto_send_email ? 1 : 0,
      smtp_host ?? "",
      smtp_port ?? 587,
      smtp_secure ? 1 : 0,
      smtp_user ?? "",
      nextPass ?? "",
      smtp_from_name ?? "",
      smtp_from_email ?? ""
    );

  const s = await getNotificationSettings(req.user.clinic_id);
  res.json({ ...s, smtp_pass: s.smtp_pass ? "••••••••" : "" });
});
