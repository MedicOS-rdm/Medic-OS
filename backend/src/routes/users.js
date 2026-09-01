import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, logAudit, suggestAvailableUsername } from "../db.js";
import { passwordPolicyError, generateSecurePassword } from "../passwordPolicy.js";

export const usersRouter = Router();

// GET /api/users/suggest-username?desired=sofia -> propone un usuario libre
usersRouter.get("/suggest-username", async (req, res) => {
  const desired = String(req.query.desired || "").trim();
  if (!desired) return res.json({ suggestion: "" });
  res.json({ suggestion: await suggestAvailableUsername(desired) });
});

usersRouter.get("/", async (req, res) => {
  const rows = await db
    .prepare(`SELECT id, username, full_name, role, created_at FROM users WHERE clinic_id = ? ORDER BY role, full_name`)
    .all(req.user.clinic_id);
  res.json(rows);
});

usersRouter.post("/", async (req, res) => {
  const { username, password, full_name } = req.body;
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: "username, password y full_name son obligatorios" });
  }
  // GRAVE de la auditoría: esta ruta tenía su propia regla ("al menos 6
  // caracteres"), distinta de la política reforzada usada en el resto de
  // la app — ahora usan la misma función en todos los puntos de creación
  // y cambio de contraseña.
  const policyError = passwordPolicyError(password);
  if (policyError) return res.status(400).json({ error: policyError });

  const existing = await db.prepare(`SELECT id FROM users WHERE username = ?`).get(username.trim().toLowerCase());
  if (existing) {
    return res.status(400).json({
      error: "Ese nombre de usuario ya existe",
      suggestion: await suggestAvailableUsername(username),
    });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const result = await db
    .prepare(`INSERT INTO users (clinic_id, username, password_hash, full_name, role) VALUES (?, ?, ?, ?, 'secretaria')`)
    .run(req.user.clinic_id, username.trim().toLowerCase(), password_hash, full_name);

  await logAudit({
    clinicId: req.user.clinic_id,
    actor: req.user.username,
    action: "create",
    entity: "user",
    entityId: result.lastInsertRowid,
    detail: { role: "secretaria" },
  });

  res.status(201).json(
    await db.prepare(`SELECT id, username, full_name, role, created_at FROM users WHERE id = ?`).get(result.lastInsertRowid)
  );
});

// PUT /api/users/:id -> el médico puede corregir el nombre de una cuenta
// de SECRETARIA (nunca el de una cuenta de médico — ni siquiera la
// propia; ver la nota en admin.js sobre por qué eso solo lo cambia el
// administrador de la plataforma).
usersRouter.put("/:id", async (req, res) => {
  const target = await db.prepare(`SELECT * FROM users WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!target) return res.status(404).json({ error: "Usuario no encontrado" });
  if (target.role === "medico") {
    return res.status(400).json({ error: "El nombre de una cuenta de médico solo lo puede corregir el administrador de la plataforma" });
  }

  const { full_name } = req.body;
  if (!full_name || !full_name.trim()) {
    return res.status(400).json({ error: "full_name es obligatorio" });
  }

  await db.prepare(`UPDATE users SET full_name = ? WHERE id = ?`).run(full_name.trim(), target.id);
  await logAudit({
    clinicId: req.user.clinic_id,
    actor: req.user.username,
    action: "update",
    entity: "user",
    entityId: target.id,
    detail: { reason: "name_correction" },
  });

  res.json(await db.prepare(`SELECT id, username, full_name, role, created_at FROM users WHERE id = ?`).get(target.id));
});

// POST /api/users/:id/reset-password -> el médico genera una clave
// temporal nueva para una cuenta de secretaria (por ejemplo si la olvidó).
// La secretaria debe cambiarla desde "Cambiar contraseña" apenas entre.
usersRouter.post("/:id/reset-password", async (req, res) => {
  const target = await db.prepare(`SELECT * FROM users WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!target) return res.status(404).json({ error: "Usuario no encontrado" });
  if (target.role === "medico") {
    return res.status(400).json({ error: "No puedes generar una clave temporal para una cuenta de médico desde aquí" });
  }

  const newPassword = generateSecurePassword();
  const password_hash = bcrypt.hashSync(newPassword, 10);
  // Invalida de inmediato cualquier sesión abierta con la contraseña
  // anterior (ver auth.js) — importante sobre todo si el reseteo se hizo
  // porque se sospecha que la cuenta estaba comprometida.
  await db.prepare(`UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?`).run(password_hash, target.id);

  await logAudit({
    clinicId: req.user.clinic_id,
    actor: req.user.username,
    action: "update",
    entity: "user",
    entityId: target.id,
    detail: { reason: "password_reset" },
  });

  res.json({ username: target.username, password: newPassword });
});

usersRouter.delete("/:id", async (req, res) => {
  const target = await db.prepare(`SELECT * FROM users WHERE id = ? AND clinic_id = ?`).get(req.params.id, req.user.clinic_id);
  if (!target) return res.status(404).json({ error: "Usuario no encontrado" });
  if (target.role === "medico") return res.status(400).json({ error: "No puedes eliminar una cuenta de médico" });

  await db.prepare(`DELETE FROM users WHERE id = ?`).run(req.params.id);
  await logAudit({ clinicId: req.user.clinic_id, actor: req.user.username, action: "delete", entity: "user", entityId: req.params.id });
  res.status(204).end();
});
