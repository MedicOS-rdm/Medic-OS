import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, logAudit } from "../db.js";
import { signToken, requireAuth, setAuthCookie, clearAuthCookie } from "../auth.js";
import { loginRateLimit } from "../rateLimiter.js";
import { passwordPolicyError } from "../passwordPolicy.js";

export const authRouter = Router();

// POST /api/auth/login
// Con límite de intentos (A-04: no había ninguna defensa contra fuerza
// bruta) y sin revelar si el problema fue el usuario o la contraseña,
// para no ayudar a un atacante a enumerar usuarios válidos.
authRouter.post("/login", loginRateLimit, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username y password son obligatorios" });

  const row = await db
    .prepare(
      `SELECT u.*, c.name AS clinic_name FROM users u
       JOIN clinics c ON c.id = u.clinic_id
       WHERE u.username = ?`
    )
    .get(username.trim().toLowerCase());

  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  }

  const user = {
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    role: row.role,
    clinic_id: row.clinic_id,
    clinic_name: row.clinic_name,
  };
  await logAudit({ clinicId: user.clinic_id, actor: user.username, action: "login", entity: "user", entityId: user.id });

  const token = signToken(user);
  // La sesión del navegador vive en una cookie httpOnly (A-01/A-02); el
  // token también se regresa en el cuerpo por si algún cliente no basado
  // en navegador (scripts, integraciones futuras) necesita usarlo como
  // Authorization: Bearer en vez de cookie.
  setAuthCookie(res, token);
  res.json({ token, user });
});

// POST /api/auth/logout -> borra la cookie de sesión del navegador.
authRouter.post("/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me -> valida el token y regresa el usuario actual
authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password -> el usuario logueado (médico o
// secretaria) cambia su propia contraseña. Útil sobre todo para que la
// secretaria reemplace la clave temporal que le dio el médico al crear
// su cuenta.
authRouter.post("/change-password", requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: "current_password y new_password son obligatorios" });
  }
  const policyError = passwordPolicyError(new_password);
  if (policyError) return res.status(400).json({ error: policyError });

  const row = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
  if (!row || !bcrypt.compareSync(current_password, row.password_hash)) {
    return res.status(401).json({ error: "La contraseña actual no es correcta" });
  }

  const password_hash = bcrypt.hashSync(new_password, 10);
  await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(password_hash, row.id);
  await logAudit({
    clinicId: req.user.clinic_id,
    actor: req.user.username,
    action: "update",
    entity: "user",
    entityId: row.id,
    detail: { reason: "self_change_password" },
  });

  res.json({ ok: true });
});
