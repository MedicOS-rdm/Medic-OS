import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, logAudit, suggestAvailableUsername } from "../db.js";

export const adminRouter = Router();

// Estas rutas las usas TÚ (el dueño de la plataforma) para dar de alta
// consultorios nuevos. No usan el login de médico/secretaria — usan un
// secreto separado (variable de entorno ADMIN_SECRET) que solo tú conoces.
// Deliberadamente NO hay registro público: cada clínica nueva la crea el
// administrador a mano, tal como se definió.
function requireAdminSecret(req, res, next) {
  if (!process.env.ADMIN_SECRET) {
    return res.status(500).json({ error: "ADMIN_SECRET no está configurado en el servidor (variable de entorno)." });
  }
  const provided = req.headers["x-admin-secret"];
  if (!provided || provided !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Secreto de administrador inválido" });
  }
  next();
}

adminRouter.use(requireAdminSecret);

// GET /api/admin/suggest-username?desired=sofia -> propone un usuario libre
adminRouter.get("/suggest-username", async (req, res) => {
  const desired = String(req.query.desired || "").trim();
  if (!desired) return res.json({ suggestion: "" });
  res.json({ suggestion: await suggestAvailableUsername(desired) });
});

// GET /api/admin/clinics -> lista de clínicas dadas de alta, con cuántos usuarios/pacientes
// tiene cada una, y el usuario de acceso del médico (para no perderlo de vista).
adminRouter.get("/clinics", async (_req, res) => {
  const rows = await db
    .prepare(
      `SELECT c.id, c.name, c.created_at,
        (SELECT COUNT(*) FROM users u WHERE u.clinic_id = c.id) AS user_count,
        (SELECT COUNT(*) FROM patients p WHERE p.clinic_id = c.id) AS patient_count,
        (SELECT u2.username FROM users u2 WHERE u2.clinic_id = c.id AND u2.role = 'medico' ORDER BY u2.id LIMIT 1) AS doctor_username
       FROM clinics c ORDER BY c.created_at DESC`
    )
    .all();
  res.json(rows);
});

// POST /api/admin/clinics/:id/reset-password -> genera una contraseña nueva
// para el médico de esa clínica (la contraseña original nunca se puede
// recuperar porque se guarda cifrada — esto es lo correcto en vez de
// intentar "mostrarla de nuevo").
adminRouter.post("/clinics/:id/reset-password", async (req, res) => {
  const doctor = await db
    .prepare(`SELECT id, username FROM users WHERE clinic_id = ? AND role = 'medico' ORDER BY id LIMIT 1`)
    .get(req.params.id);
  if (!doctor) return res.status(404).json({ error: "No se encontró la cuenta de médico de esta clínica" });

  const { password } = req.body;
  const newPassword = password && password.length >= 6 ? password : Math.random().toString(36).slice(-8);
  const password_hash = bcrypt.hashSync(newPassword, 10);

  await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(password_hash, doctor.id);
  await logAudit({ clinicId: req.params.id, actor: "admin", action: "update", entity: "user", entityId: doctor.id, detail: { reason: "password_reset" } });

  res.json({ username: doctor.username, password: newPassword });
});

// POST /api/admin/clinics -> crea una clínica nueva + su primera cuenta (médico)
adminRouter.post("/clinics", async (req, res) => {
  const {
    clinic_name,
    username,
    password,
    full_name,
    personal_id,
    professional_license,
    specialty,
    email,
    city,
    clinic_address,
    clinic_phone,
  } = req.body;
  if (!clinic_name || !username || !password || !full_name) {
    return res.status(400).json({ error: "clinic_name, username, password y full_name son obligatorios" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });
  }

  const existing = await db.prepare(`SELECT id FROM users WHERE username = ?`).get(username.trim().toLowerCase());
  if (existing) {
    return res.status(400).json({
      error: "Ese nombre de usuario ya existe en otra clínica",
      suggestion: await suggestAvailableUsername(username),
    });
  }

  const clinicResult = await db.prepare(`INSERT INTO clinics (name) VALUES (?)`).run(clinic_name);
  const clinicId = clinicResult.lastInsertRowid;

  const password_hash = bcrypt.hashSync(password, 10);
  const userResult = await db
    .prepare(`INSERT INTO users (clinic_id, username, password_hash, full_name, role) VALUES (?, ?, ?, ?, 'medico')`)
    .run(clinicId, username.trim().toLowerCase(), password_hash, full_name);

  // Pre-llenamos el perfil del médico con lo que ya sabemos (nombre y
  // nombre del consultorio como mínimo), para que "Perfil del médico" no
  // se vea vacío la primera vez que el médico entra. Puede editarlo
  // libremente después.
  await db
    .prepare(
      `INSERT INTO doctor_profile
        (clinic_id, full_name, personal_id, professional_license, specialty, email, city, clinic_name, clinic_address, clinic_phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      clinicId,
      full_name,
      personal_id ?? "",
      professional_license ?? "",
      specialty ?? "",
      email ?? "",
      city ?? "",
      clinic_name,
      clinic_address ?? "",
      clinic_phone ?? ""
    );

  await logAudit({ clinicId, actor: "admin", action: "create", entity: "clinic", entityId: clinicId, detail: { clinic_name } });

  res.status(201).json({
    clinic: { id: clinicId, name: clinic_name },
    user: { id: userResult.lastInsertRowid, username: username.trim().toLowerCase(), full_name, role: "medico" },
  });
});

// DELETE /api/admin/clinics/:id -> borra una clínica y TODO lo que le pertenece (cascada)
adminRouter.delete("/clinics/:id", async (req, res) => {
  const existing = await db.prepare(`SELECT id FROM clinics WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Clínica no encontrada" });
  await db.prepare(`DELETE FROM clinics WHERE id = ?`).run(req.params.id);
  await logAudit({ actor: "admin", action: "delete", entity: "clinic", entityId: req.params.id });
  res.status(204).end();
});
