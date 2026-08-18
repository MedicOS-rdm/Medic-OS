import { Router } from "express";
import { db } from "../db.js";
import { requireRole } from "../auth.js";

export const doctorProfileRouter = Router();

// Límite generoso pero razonable para un logo (no es un servicio de
// archivos aparte — se guarda como texto base64 dentro de la misma fila).
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB del archivo original

doctorProfileRouter.get("/", async (req, res) => {
  const profile = await db.prepare(`SELECT * FROM doctor_profile WHERE clinic_id = ?`).get(req.user.clinic_id);
  res.json(
    profile || {
      clinic_id: req.user.clinic_id,
      full_name: "",
      personal_id: "",
      professional_license: "",
      specialty: "",
      email: "",
      city: "",
      clinic_name: "",
      clinic_address: "",
      clinic_phone: "",
      mobile_phone: "",
      logo_base64: null,
    }
  );
});

doctorProfileRouter.put("/", requireRole("medico"), async (req, res) => {
  const {
    personal_id,
    professional_license,
    specialty,
    email,
    city,
    clinic_name,
    clinic_address,
    clinic_phone,
    mobile_phone,
  } = req.body;

  // El nombre del médico NO se acepta aquí a propósito: una vez que el
  // administrador de la plataforma lo da de alta, solo él puede
  // corregirlo (desde /admin.html) — el propio médico no puede cambiarlo
  // por su cuenta. Por eso se conserva el que ya estaba guardado en vez
  // de leerlo del body, sin importar qué mande el cliente.
  const current = await db.prepare(`SELECT full_name FROM doctor_profile WHERE clinic_id = ?`).get(req.user.clinic_id);
  const full_name = current?.full_name ?? "";

  await db
    .prepare(
      `INSERT INTO doctor_profile
        (clinic_id, full_name, personal_id, professional_license, specialty, email, city, clinic_name, clinic_address, clinic_phone, mobile_phone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(clinic_id) DO UPDATE SET
         personal_id = excluded.personal_id,
         professional_license = excluded.professional_license,
         specialty = excluded.specialty,
         email = excluded.email,
         city = excluded.city,
         clinic_name = excluded.clinic_name,
         clinic_address = excluded.clinic_address,
         clinic_phone = excluded.clinic_phone,
         mobile_phone = excluded.mobile_phone`
    )
    .run(
      req.user.clinic_id,
      full_name,
      personal_id ?? "",
      professional_license ?? "",
      specialty ?? "",
      email ?? "",
      city ?? "",
      clinic_name ?? "",
      clinic_address ?? "",
      clinic_phone ?? "",
      mobile_phone ?? ""
    );
  res.json(await db.prepare(`SELECT * FROM doctor_profile WHERE clinic_id = ?`).get(req.user.clinic_id));
});

// PUT /api/doctor-profile/logo -> sube/reemplaza el logo del consultorio.
// Espera { data_uri: "data:image/png;base64,...." } — se valida tipo y
// tamaño antes de guardarlo. Este logo aparece en la barra lateral de la
// app (una vez el médico o su secretaria inician sesión) y en el
// encabezado de las recetas y certificados que se generen desde ahora.
doctorProfileRouter.put("/logo", requireRole("medico"), async (req, res) => {
  const { data_uri } = req.body;
  if (!data_uri || typeof data_uri !== "string" || !data_uri.startsWith("data:image/")) {
    return res.status(400).json({ error: "Formato de imagen inválido" });
  }

  const match = data_uri.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ error: "Solo se aceptan imágenes PNG, JPG o WEBP" });
  }

  const base64Data = match[2];
  const approxBytes = Math.ceil((base64Data.length * 3) / 4);
  if (approxBytes > MAX_LOGO_BYTES) {
    return res.status(400).json({ error: "La imagen es muy grande (máximo 2 MB)" });
  }

  // Asegura que exista una fila para esta clínica (por si aún no se había
  // llenado "Perfil del médico" nunca).
  await db
    .prepare(
      `INSERT INTO doctor_profile (clinic_id, logo_base64) VALUES (?, ?)
       ON CONFLICT(clinic_id) DO UPDATE SET logo_base64 = excluded.logo_base64`
    )
    .run(req.user.clinic_id, data_uri);

  res.json({ logo_base64: data_uri });
});

// DELETE /api/doctor-profile/logo -> quita el logo (vuelve a mostrar el
// logo genérico de MedicOs en la app y en los documentos).
doctorProfileRouter.delete("/logo", requireRole("medico"), async (req, res) => {
  await db.prepare(`UPDATE doctor_profile SET logo_base64 = NULL WHERE clinic_id = ?`).run(req.user.clinic_id);
  res.status(204).end();
});
