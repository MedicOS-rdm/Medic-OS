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
const TABLES_WITHOUT_ID_PK = /into\s+(doctor_profile|reminder_settings)\b/i;

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
const NOW_TEXT = `to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`;

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
  await ensureColumn("patients", "id_number", "TEXT");
  await ensureColumn("patients", "address", "TEXT");
  await ensureColumn("patients", "workplace", "TEXT");
  await ensureColumn("patients", "job_title", "TEXT");
  await ensureColumn("patients", "clinical_history_number", "TEXT");
  await ensureColumn("prescriptions", "updated_at", "TEXT");
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

  const medsSeed = [
    ["Paracetamol", "Tempra, Tylenol", "Tabletas 500 mg"],
    ["Paracetamol", "Tempra, Tylenol", "Jarabe 120 mg/5 ml"],
    ["Ibuprofeno", "Advil, Motrin", "Tabletas 400 mg"],
    ["Ibuprofeno", "Advil, Motrin", "Suspensión 100 mg/5 ml"],
    ["Amoxicilina", "Amoxil", "Cápsulas 500 mg"],
    ["Amoxicilina", "Amoxil", "Suspensión 250 mg/5 ml"],
    ["Losartán", "Cozaar", "Tabletas 50 mg"],
    ["Metformina", "Glucophage", "Tabletas 850 mg"],
    ["Omeprazol", "Losec", "Cápsulas 20 mg"],
    ["Loratadina", "Clarityne", "Tabletas 10 mg"],
    ["Salbutamol", "Ventolin", "Inhalador 100 mcg"],
    ["Diclofenaco", "Voltaren", "Tabletas 50 mg"],
    ["Enalapril", "Renitec", "Tabletas 10 mg"],
    ["Atorvastatina", "Lipitor", "Tabletas 20 mg"],
    ["Cetirizina", "Zyrtec", "Tabletas 10 mg"],
    ["Azitromicina", "Zithromax", "Tabletas 500 mg"],
    ["Ácido acetilsalicílico", "Aspirina", "Tabletas 100 mg"],
    ["Metamizol", "Neomelubrina", "Tabletas 500 mg"],
    ["Dexametasona", "Decadron", "Tabletas 0.5 mg"],
    ["Complejo B", "Neurobion", "Tabletas"],
  ];
  const medsCount = await pool.query(`SELECT COUNT(*)::int AS n FROM medications_catalog`);
  if (medsCount.rows[0].n === 0) {
    for (const [generic_name, commercial_names, presentation] of medsSeed) {
      await pool.query(
        `INSERT INTO medications_catalog (generic_name, commercial_names, presentation) VALUES ($1, $2, $3)`,
        [generic_name, commercial_names, presentation]
      );
    }
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
