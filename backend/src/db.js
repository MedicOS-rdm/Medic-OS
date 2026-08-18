import pg from "pg";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Conexión a PostgreSQL (Neon, u otro proveedor compatible) ----------
// DATABASE_URL es obligatoria: la app ya no usa un archivo local (SQLite),
// porque los discos de los planes gratis de hosting (ej. Render) se borran
// en cada despliegue. Postgres administrado (ej. Neon, plan gratis
// permanente) resuelve esto de raíz: los datos viven fuera del servidor
// web y sobreviven a cualquier despliegue/reinicio.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "Falta la variable de entorno DATABASE_URL (cadena de conexión de PostgreSQL). " +
      "Ver README para cómo crear una base gratis en Neon."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // La mayoría de proveedores gratis (Neon incluido) exigen SSL pero usan
  // certificados que Node no valida por default con la configuración más
  // estricta; esto es el ajuste estándar recomendado por Neon para Node.
  ssl: { rejectUnauthorized: false },
});

// ---------- Shim de compatibilidad ----------
// El resto del backend fue escrito originalmente contra la API síncrona de
// better-sqlite3: `db.prepare(sql).get(a, b)`, `.all(a, b)`, `.run(a, b)`,
// con placeholders `?` y `result.lastInsertRowid`. Para no tener que
// reescribir cada consulta a mano, este shim traduce esa misma forma de
// escribir código hacia PostgreSQL (async, placeholders `$1 $2...`,
// `RETURNING id` en vez de lastInsertRowid), MANTENIENDO cada .get/.all/.run
// como una función async — los archivos de rutas solo necesitan `await`
// antes de cada llamada (y ser funciones `async`), sin tocar el SQL.
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Tablas cuya llave primaria NO se llama "id" (usan clinic_id como PK,
// son "una fila por clínica"): a esas nunca hay que pedirles RETURNING id.
const TABLES_WITHOUT_ID_PK = /into\s+(doctor_profile|reminder_settings|notification_settings)\b/i;

function ensureReturningId(sql) {
  const trimmed = sql.trim();
  if (/^insert/i.test(trimmed) && !/returning/i.test(trimmed) && !TABLES_WITHOUT_ID_PK.test(trimmed)) {
    return `${sql} RETURNING id`;
  }
  return sql;
}

export const db = {
  prepare(sql) {
    const pgSql = toPgPlaceholders(sql);
    const pgSqlWithReturning = ensureReturningId(pgSql);
    return {
      async get(...params) {
        const res = await pool.query(pgSql, params);
        return res.rows[0] || undefined;
      },
      async all(...params) {
        const res = await pool.query(pgSql, params);
        return res.rows;
      },
      async run(...params) {
        const res = await pool.query(pgSqlWithReturning, params);
        return {
          changes: res.rowCount,
          lastInsertRowid: res.rows[0]?.id,
        };
      },
    };
  },
  async exec(sql) {
    await pool.query(sql);
  },
  // db.transaction(fn) en better-sqlite3 regresa una función síncrona que
  // ejecuta fn dentro de una transacción. Aquí lo simplificamos: como
  // fn ya no puede ser síncrona (necesita await en cada .run()), quien la
  // use debe llamarla con `await` y fn debe ser async. Se usa solo para
  // sembrar catálogos al arrancar (no es una ruta HTTP), así que no hay
  // problema de que sea async.
  transaction(fn) {
    return async (...args) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await fn(...args);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    };
  },
};

// ---------- Esquema ----------
// NOTA: created_at/updated_at se guardan como TEXT con formato
// "YYYY-MM-DD HH:MM:SS" (vía to_char(now(), ...)) — el mismo formato que
// generaba SQLite — para que todo el código existente que hace
// `fecha.replace(' ', 'T')` siga funcionando sin cambios.
//
// IMPORTANTE (corregido): now() de Postgres da la hora en UTC. Si se
// guarda tal cual, todo el código que lee ese texto (frontend Y los PDF)
// lo interpreta como si YA fuera hora local de Ecuador — sin restar las 5
// horas de diferencia — porque el texto no lleva marca de zona horaria.
// Por eso "creado a las 20:55" (UTC) se mostraba como "8:55 pm" en vez de
// las 3:55 pm reales. La cita (appointments.start_time) nunca tuvo este
// problema porque se arma directo del formulario ("YYYY-MM-DDTHH:MM:00")
// sin pasar por now(), o sea que ya nace en hora de Ecuador.
//
// La corrección: convertir now() a hora de Ecuador ANTES de convertirlo a
// texto, para que TODOS los created_at/updated_at queden con el mismo
// formato "ya en hora local" que appointments.start_time — así el resto
// del código (que asume hora local) queda automáticamente correcto sin
// tener que tocar cada pantalla o PDF uno por uno.
const NOW_TEXT = `to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS')`;

// Se activa (si el proveedor de Postgres lo permite) dentro de initDb().
// Cuando está en true, las búsquedas de texto (ej. catálogo CIE-10) pueden
// usar unaccent(...) para que "infeccion" encuentre "Infección" sin tilde.
// Si el proveedor no permite crear extensiones, queda en false y las
// búsquedas simplemente no ignoran tildes (no se rompen, solo son menos
// permisivas).
export const dbCapabilities = { unaccent: false };

async function ensureColumn(table, column, definition) {
  // Postgres soporta "ADD COLUMN IF NOT EXISTS" nativamente — más simple
  // y seguro que inspeccionar el esquema a mano.
  await pool.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
}

export async function initDb() {
  // Intento de activar búsqueda insensible a tildes (ej. "infeccion"
  // encuentra "Infección"). Si el proveedor de Postgres no lo permite
  // (algunos hosts restringen la creación de extensiones), seguimos sin
  // ella — la app funciona igual, solo la búsqueda es un poco más estricta.
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
    dbCapabilities.unaccent = true;
  } catch (err) {
    console.warn("[db] No se pudo activar la extensión 'unaccent' (búsqueda sin tildes deshabilitada):", err.message);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clinics (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${NOW_TEXT})
    );

    CREATE TABLE IF NOT EXISTS patients (
      id SERIAL PRIMARY KEY,
      clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      birth_date TEXT,
      gender TEXT,
      phone TEXT,
      email TEXT,
      emergency_contact_name TEXT,
      emergency_contact_phone TEXT,
      blood_type TEXT,
      allergies TEXT,
      chronic_conditions TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW_TEXT}),
      updated_at TEXT NOT NULL DEFAULT (${NOW_TEXT})
    );
    CREATE INDEX IF NOT EXISTS idx_patients_clinic ON patients(clinic_id);

    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      start_time TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 20,
      visit_type TEXT NOT NULL DEFAULT 'subsecuente',
      status TEXT NOT NULL DEFAULT 'programada',
      reason TEXT,
      notes TEXT,
      reminder_sent_at TEXT,
      reminder_channel TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW_TEXT}),
      updated_at TEXT NOT NULL DEFAULT (${NOW_TEXT})
    );
    CREATE INDEX IF NOT EXISTS idx_appointments_clinic ON appointments(clinic_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_start_time ON appointments(start_time);
    CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);

    CREATE TABLE IF NOT EXISTS consultations (
      id SERIAL PRIMARY KEY,
      clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
      subjective TEXT,
      blood_pressure TEXT,
      heart_rate INTEGER,
      temperature_c REAL,
      weight_kg REAL,
      height_cm REAL,
      bmi REAL,
      diagnosis_code TEXT,
      diagnosis_label TEXT,
      plan TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW_TEXT}),
      updated_at TEXT NOT NULL DEFAULT (${NOW_TEXT})
    );
    CREATE INDEX IF NOT EXISTS idx_consultations_clinic ON consultations(clinic_id);
    CREATE INDEX IF NOT EXISTS idx_consultations_patient ON consultations(patient_id);

    -- Historia clínica estructurada tipo SOAP completo. Todas estas
    -- columnas son opcionales (nullable) y se agregan con ADD COLUMN IF
    -- NOT EXISTS para no romper bases ya desplegadas con el esquema
    -- anterior (más simple). Los campos "_json" guardan listas/objetos
    -- (diagnósticos adicionales, medicamentos del tratamiento, examen
    -- físico, estudios) como texto JSON, igual que ya se hace con
    -- prescriptions.items_json.
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS chief_complaint TEXT;              -- S: motivo de consulta
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS present_illness TEXT;              -- S: enfermedad actual
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS relevant_history TEXT;             -- S: antecedentes relevantes
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS physical_exam_json TEXT;           -- O: examen físico (plantilla)
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS clinical_findings TEXT;            -- O: hallazgos
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS clinical_assessment TEXT;          -- A: evaluación clínica
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS additional_diagnoses_json TEXT;    -- A: diagnósticos adicionales
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS treatment_meds_json TEXT;          -- P: tratamiento farmacológico
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS non_pharmacological_treatment TEXT; -- P: tratamiento no farmacológico
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS studies_lab_json TEXT;             -- P: estudios de laboratorio
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS studies_imaging_json TEXT;         -- P: estudios de imagen
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS patient_education TEXT;            -- P: educación al paciente
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS warning_signs TEXT;                -- P: signos de alarma
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS follow_up_interval TEXT;           -- P: seguimiento (ej. "2 semanas")
    ALTER TABLE consultations ADD COLUMN IF NOT EXISTS follow_up_date TEXT;               -- P: seguimiento, fecha calculada

    CREATE TABLE IF NOT EXISTS cie11_catalog (
      code TEXT PRIMARY KEY,
      label TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS medications_catalog (
      id SERIAL PRIMARY KEY,
      generic_name TEXT NOT NULL,
      commercial_names TEXT,
      presentation TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS doctor_profile (
      clinic_id INTEGER PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
      full_name TEXT,
      professional_license TEXT,
      specialty TEXT,
      clinic_name TEXT,
      clinic_address TEXT,
      clinic_phone TEXT
    );

    CREATE TABLE IF NOT EXISTS prescriptions (
      id SERIAL PRIMARY KEY,
      clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL,
      qr_token TEXT NOT NULL UNIQUE,
      items_json TEXT NOT NULL,
      instructions TEXT,
      doctor_name TEXT,
      doctor_license TEXT,
      doctor_specialty TEXT,
      clinic_name TEXT,
      clinic_address TEXT,
      clinic_phone TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW_TEXT})
    );
    CREATE INDEX IF NOT EXISTS idx_prescriptions_clinic ON prescriptions(clinic_id);
    CREATE INDEX IF NOT EXISTS idx_prescriptions_patient ON prescriptions(patient_id);
    CREATE INDEX IF NOT EXISTS idx_prescriptions_qr ON prescriptions(qr_token);

    CREATE TABLE IF NOT EXISTS certificates (
      id SERIAL PRIMARY KEY,
      clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      consultation_id INTEGER REFERENCES consultations(id) ON DELETE SET NULL,
      diagnosis_code TEXT,
      diagnosis_label TEXT,
      clinical_picture TEXT,
      presents_symptoms INTEGER NOT NULL DEFAULT 1,
      certificate_type TEXT NOT NULL DEFAULT 'enfermedad',
      description TEXT,
      days_granted INTEGER NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      patient_full_name TEXT,
      patient_address TEXT,
      patient_phone TEXT,
      patient_email TEXT,
      patient_institution TEXT,
      patient_job_title TEXT,
      patient_id_number TEXT,
      patient_clinical_history_number TEXT,
      doctor_name TEXT,
      doctor_personal_id TEXT,
      doctor_license TEXT,
      doctor_specialty TEXT,
      doctor_email TEXT,
      clinic_name TEXT,
      clinic_address TEXT,
      clinic_phone TEXT,
      issue_place TEXT,
      share_token TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW_TEXT})
    );
    CREATE INDEX IF NOT EXISTS idx_certificates_clinic ON certificates(clinic_id);
    CREATE INDEX IF NOT EXISTS idx_certificates_patient ON certificates(patient_id);

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('medico', 'secretaria')),
      created_at TEXT NOT NULL DEFAULT (${NOW_TEXT})
    );
    CREATE INDEX IF NOT EXISTS idx_users_clinic ON users(clinic_id);

    CREATE TABLE IF NOT EXISTS reminder_settings (
      clinic_id INTEGER PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'simulado',
      twilio_account_sid TEXT,
      twilio_auth_token TEXT,
      twilio_from_number TEXT,
      message_template TEXT NOT NULL DEFAULT
        'Hola {paciente}, le recordamos su cita el {fecha} a las {hora} en {consultorio}. Responda 1 para CONFIRMAR o 2 para CANCELAR.',
      hours_before INTEGER NOT NULL DEFAULT 24,
      enabled INTEGER NOT NULL DEFAULT 0
    );

    -- Envío automático de recetas/certificados por WhatsApp (reutiliza las
    -- credenciales de Twilio de reminder_settings) y por correo (SMTP
    -- propio). Una fila por consultorio.
    CREATE TABLE IF NOT EXISTS notification_settings (
      clinic_id INTEGER PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
      auto_send_whatsapp INTEGER NOT NULL DEFAULT 0,
      auto_send_email INTEGER NOT NULL DEFAULT 0,
      smtp_host TEXT,
      smtp_port INTEGER,
      smtp_secure INTEGER NOT NULL DEFAULT 0,
      smtp_user TEXT,
      smtp_pass TEXT,
      smtp_from_name TEXT,
      smtp_from_email TEXT
    );

    -- Bases desplegadas antes de este cambio no tienen esta columna en
    -- certificates todavía; se agrega sin tocar los certificados ya
    -- emitidos (quedan con share_token NULL hasta que se reenvíen).
    ALTER TABLE certificates ADD COLUMN IF NOT EXISTS share_token TEXT;

    CREATE TABLE IF NOT EXISTS reminder_log (
      id SERIAL PRIMARY KEY,
      appointment_id INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
      direction TEXT NOT NULL,
      channel TEXT,
      body TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW_TEXT})
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      clinic_id INTEGER,
      actor TEXT NOT NULL DEFAULT 'sistema',
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id INTEGER,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW_TEXT})
    );
  `);

  // Columnas agregadas después del lanzamiento inicial (aditivas, seguras).
  await ensureColumn("doctor_profile", "personal_id", "TEXT");
  await ensureColumn("doctor_profile", "email", "TEXT");
  await ensureColumn("doctor_profile", "city", "TEXT");
  // Logo del consultorio, guardado como "data URI" (ej. "data:image/png;base64,...").
  // No usamos un servicio de archivos aparte (S3, etc.) para mantener el
  // MVP simple; por eso se limita el tamaño al subirlo (ver routes/doctorProfile.js).
  await ensureColumn("doctor_profile", "logo_base64", "TEXT");
  // Celular personal del médico — se imprime en la receta en vez de la
  // cédula profesional (que ya no se muestra ahí).
  await ensureColumn("doctor_profile", "mobile_phone", "TEXT");
  await ensureColumn("patients", "id_number", "TEXT");
  await ensureColumn("patients", "address", "TEXT");
  await ensureColumn("patients", "workplace", "TEXT");
  await ensureColumn("patients", "job_title", "TEXT");
  await ensureColumn("patients", "clinical_history_number", "TEXT");
  await ensureColumn("prescriptions", "updated_at", "TEXT");
  // Celular del médico, congelado en la receta al emitirla (igual que
  // doctor_name, doctor_license, etc.) para que ediciones futuras del
  // perfil no cambien recetas ya emitidas.
  await ensureColumn("prescriptions", "doctor_mobile_phone", "TEXT");
  await ensureColumn("certificates", "updated_at", "TEXT");

  // ---------- Catálogo CIE-10 en español (más de 11,000 códigos) ----------
  // Se carga desde backend/data/cie10-es.json — un archivo de datos local,
  // no una llamada a ninguna API externa en cada arranque. Fuente: catálogo
  // público derivado de la clasificación CIE-10 de la OMS con datos
  // administrativos del Ministerio de Salud de Chile (deis.cl), agregado en
  // https://github.com/verasativa/CIE-10. Es un catálogo de referencia
  // general — para uso clínico regulado a gran escala en un país
  // específico, conviene contrastarlo contra el catálogo oficial vigente
  // de la autoridad sanitaria local (en Ecuador, el MSP).
  //
  // Solo se siembra si el catálogo está prácticamente vacío (evita
  // recorrer 11,000 filas en cada reinicio del servidor una vez que ya se
  // cargó la primera vez).
  const cie10Count = await pool.query(`SELECT COUNT(*)::int AS n FROM cie11_catalog`);
  if (cie10Count.rows[0].n < 1000) {
    const dataPath = path.join(__dirname, "..", "data", "cie10-es.json");
    const cie10Data = JSON.parse(await fs.readFile(dataPath, "utf-8"));
    const codes = cie10Data.map((d) => d.code);
    const labels = cie10Data.map((d) => d.label);
    // Inserción masiva en una sola consulta (unnest de dos arreglos
    // paralelos) — mucho más rápido que 11,000 INSERT uno por uno.
    await pool.query(
      `INSERT INTO cie11_catalog (code, label)
       SELECT * FROM UNNEST($1::text[], $2::text[])
       ON CONFLICT (code) DO NOTHING`,
      [codes, labels]
    );
  }

  // Catálogo de medicamentos (nombre genérico, nombres comerciales de
  // referencia y presentación). Se carga desde backend/data/medications-es.json
  // — una lista de formulario general de uso común en Ecuador/Latinoamérica,
  // no un vademécum oficial; para prescripción de medicamentos controlados
  // o de alto riesgo, siempre contrastar contra el registro sanitario
  // vigente (ARCSA en Ecuador).
  //
  // A diferencia del seed anterior (que solo corría una vez si la tabla
  // estaba vacía), este usa UPSERT: cada vez que el servidor arranca,
  // agrega cualquier medicamento nuevo del archivo que aún no exista, sin
  // duplicar ni tocar los que el catálogo ya tenía. Así, ampliar este
  // archivo en el futuro alcanza para que los catálogos ya desplegados
  // se pongan al día solos, sin perder medicamentos que el médico haya
  // agregado manualmente aparte.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'medications_catalog_generic_presentation_key'
      ) THEN
        ALTER TABLE medications_catalog
          ADD CONSTRAINT medications_catalog_generic_presentation_key UNIQUE (generic_name, presentation);
      END IF;
    END $$;
  `);
  const medsDataPath = path.join(__dirname, "..", "data", "medications-es.json");
  const medsSeed = JSON.parse(await fs.readFile(medsDataPath, "utf-8"));
  {
    const generics = medsSeed.map((m) => m[0]);
    const commercials = medsSeed.map((m) => m[1]);
    const presentations = medsSeed.map((m) => m[2]);
    await pool.query(
      `INSERT INTO medications_catalog (generic_name, commercial_names, presentation)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[])
       ON CONFLICT (generic_name, presentation) DO NOTHING`,
      [generics, commercials, presentations]
    );
  }

  // ---------- Migración única: corregir fechas guardadas en UTC ----------
  // Antes de este cambio, created_at/updated_at se guardaban en UTC pero
  // se LEÍAN como si ya fueran hora de Ecuador (ver nota junto a
  // NOW_TEXT) — un desfase de 5 horas. NOW_TEXT ya quedó corregido para
  // los registros NUEVOS; esto corrige los registros VIEJOS que ya
  // quedaron guardados con la hora equivocada, restándoles esas 5 horas
  // una sola vez. Se guarda un marcador para que, aunque el servidor
  // reinicie muchas veces, esta corrección NUNCA se vuelva a aplicar dos
  // veces sobre los mismos datos (eso los dejaría mal de nuevo).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (${NOW_TEXT})
    );
  `);
  const MIGRATION_NAME = "fix_utc_timestamps_to_ecuador_2026_08";
  const already = await pool.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [MIGRATION_NAME]);
  if (already.rows.length === 0) {
    // Reinterpreta el texto viejo (mal etiquetado como si fuera local)
    // como UTC de verdad, y lo convierte a la hora local de Ecuador.
    // NO toca appointments.start_time: esa columna nunca tuvo el bug,
    // porque se arma directo del formulario de la cita, sin pasar por
    // now().
    const fix = (col) => `${col} = to_char((${col}::timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD HH24:MI:SS')`;
    await pool.query(`UPDATE clinics SET ${fix("created_at")}`);
    await pool.query(`UPDATE patients SET ${fix("created_at")}, ${fix("updated_at")}`);
    await pool.query(`UPDATE appointments SET ${fix("created_at")}, ${fix("updated_at")}`);
    await pool.query(`UPDATE appointments SET ${fix("reminder_sent_at")} WHERE reminder_sent_at IS NOT NULL`);
    await pool.query(`UPDATE consultations SET ${fix("created_at")}`);
    await pool.query(`UPDATE prescriptions SET ${fix("created_at")}`);
    await pool.query(`UPDATE certificates SET ${fix("created_at")}`);
    await pool.query(`UPDATE users SET ${fix("created_at")}`);
    await pool.query(`UPDATE reminder_log SET ${fix("created_at")}`);
    await pool.query(`UPDATE audit_log SET ${fix("created_at")}`);
    await pool.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [MIGRATION_NAME]);
    console.log(`[migración] Horas de registros existentes corregidas de UTC a hora de Ecuador (${MIGRATION_NAME})`);
  }
}

export async function logAudit({ clinicId = null, actor = "sistema", action, entity, entityId, detail }) {
  await pool.query(
    `INSERT INTO audit_log (clinic_id, actor, action, entity, entity_id, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
    [clinicId, actor, action, entity, entityId ?? null, detail ? JSON.stringify(detail) : null]
  );
}

export function newQrToken() {
  return crypto.randomBytes(16).toString("hex");
}

// Convierte "Sofía Barberán" o "sofia" en un slug simple ("sofia.barberan",
// "sofia"), y si ya existe le agrega un sufijo numérico (sofia2, sofia3...)
// hasta encontrar uno libre en TODA la plataforma (username es único
// globalmente porque el login no pide "clínica").
export async function suggestAvailableUsername(desired) {
  const base =
    desired
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, ".")
      .replace(/\.+/g, ".")
      .replace(/^\.|\.$/g, "") || "usuario";

  const exists = async (u) => {
    const res = await pool.query(`SELECT id FROM users WHERE username = $1`, [u]);
    return res.rows.length > 0;
  };

  if (!(await exists(base))) return base;
  let i = 2;
  while (await exists(`${base}${i}`)) i++;
  return `${base}${i}`;
}

export const VALID_STATUSES = [
  "programada",
  "confirmada",
  "en_sala_espera",
  "en_consulta",
  "finalizada",
  "cancelada",
  "no_asistio",
];
