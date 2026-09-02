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

// Validación de TLS con Postgres administrado (Neon u otro): por defecto
// se exige un certificado válido (rejectUnauthorized: true), como
// corresponde para una base de datos con información clínica sensible.
// Solo se relaja explícitamente si PGSSL_INSECURE=true está definida (uso
// exclusivo para depurar contra un Postgres local sin certificado válido;
// NUNCA debe activarse en producción).
const sslConfig =
  process.env.PGSSL_INSECURE === "true"
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
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

// Fábrica que arma el mismo shim de compatibilidad (`.prepare(sql).get/all/run`)
// tanto para el pool normal como para una transacción — la única
// diferencia es qué función de bajo nivel ejecuta el SQL (`pool.query` o
// `client.query` de una conexión ya abierta en una transacción).
function makeDbFrom(queryExecutor) {
  return {
    prepare(sql) {
      const pgSql = toPgPlaceholders(sql);
      const pgSqlWithReturning = ensureReturningId(pgSql);
      return {
        async get(...params) {
          const res = await queryExecutor(pgSql, params);
          return res.rows[0] || undefined;
        },
        async all(...params) {
          const res = await queryExecutor(pgSql, params);
          return res.rows;
        },
        async run(...params) {
          const res = await queryExecutor(pgSqlWithReturning, params);
          return {
            changes: res.rowCount,
            lastInsertRowid: res.rows[0]?.id,
          };
        },
      };
    },
    async exec(sql) {
      await queryExecutor(sql, []);
    },
  };
}

export const db = makeDbFrom((sql, params) => pool.query(sql, params));

// CRÍTICO POTENCIAL de la auditoría: "el proyecto dispone de
// infraestructura transaccional en db.js, pero los flujos que crean
// varias entidades... pueden quedar parcialmente ejecutados si una
// operación intermedia falla". Al revisar esto encontré que era exacto:
// existía un `db.transaction(fn)` que abría BEGIN/COMMIT sobre una
// conexión dedicada, pero `fn` seguía usando `db.prepare(...)` de más
// arriba, que toma conexiones SUELTAS del pool — es decir, las consultas
// de adentro NUNCA corrían realmente dentro de esa transacción, y
// además nunca se usaba en ninguna ruta. Este reemplazo sí funciona: crea
// una conexión dedicada, la pasa como un "db" con la misma forma
// (`tx.prepare(sql).get/all/run(...)`) a la función que le pases, y hace
// COMMIT solo si todo terminó bien — si cualquier paso lanza, hace
// ROLLBACK y ninguno de los cambios queda a medias.
//
// Uso: `await withTransaction(async (tx) => { await tx.prepare(...).run(...); ... })`
export async function withTransaction(fn) {
  const client = await pool.connect();
  const tx = makeDbFrom((sql, params) => client.query(sql, params));
  try {
    await client.query("BEGIN");
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

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

// GRAVE de la auditoría: "no se identificaron CHECK constraints ni
// validaciones a nivel de base de datos para... rangos clínicos". La
// aplicación ya valida esto (ver validators.js), pero solo la base de
// datos es la última línea de defensa real — protege incluso si alguien
// escribe directamente por SQL o si un futuro cambio de código se salta
// la validación de la aplicación por error.
//
// Se agregan como NOT VALID a propósito: un CHECK normal revisa TODAS las
// filas existentes al crearse, y si ya hay una sola fila con un valor
// fuera de rango (dato viejo de antes de que existiera esta validación),
// la migración completa fallaría y el servidor no arrancaría. NOT VALID
// se salta esa revisión histórica — protege todo lo que se escriba de
// ahora en adelante, sin arriesgar el arranque por datos del pasado.
async function addCheckConstraintNotValid(table, constraintName, expression) {
  try {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${constraintName}') THEN
          ALTER TABLE "${table}" ADD CONSTRAINT ${constraintName} CHECK (${expression}) NOT VALID;
        END IF;
      END $$;
    `);
  } catch (err) {
    console.warn(`[db] No se pudo agregar la restricción ${constraintName} en ${table} (se sigue confiando solo en la validación de la aplicación):`, err.message);
  }
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
  // Snapshot de paciente/médico en el certificado: si la tabla "certificates"
  // ya existía en esta base (desplegada antes de que estas columnas se
  // agregaran al CREATE TABLE de arriba), "CREATE TABLE IF NOT EXISTS" no
  // las crea — por eso se agregan también aquí, de forma aditiva y segura,
  // igual que ya se hacía con "updated_at" y "share_token". Sin este
  // respaldo, el PDF se genera pero los datos del médico y del paciente
  // salen en blanco aunque los formularios estén completos.
  await ensureColumn("certificates", "patient_full_name", "TEXT");
  await ensureColumn("certificates", "patient_address", "TEXT");
  await ensureColumn("certificates", "patient_phone", "TEXT");
  await ensureColumn("certificates", "patient_email", "TEXT");
  await ensureColumn("certificates", "patient_institution", "TEXT");
  await ensureColumn("certificates", "patient_job_title", "TEXT");
  await ensureColumn("certificates", "patient_id_number", "TEXT");
  await ensureColumn("certificates", "patient_clinical_history_number", "TEXT");
  await ensureColumn("certificates", "doctor_name", "TEXT");
  await ensureColumn("certificates", "doctor_personal_id", "TEXT");
  await ensureColumn("certificates", "doctor_license", "TEXT");
  await ensureColumn("certificates", "doctor_specialty", "TEXT");
  await ensureColumn("certificates", "doctor_email", "TEXT");
  await ensureColumn("certificates", "clinic_name", "TEXT");
  await ensureColumn("certificates", "clinic_address", "TEXT");
  await ensureColumn("certificates", "clinic_phone", "TEXT");
  await ensureColumn("certificates", "issue_place", "TEXT");

  // ---------- Versionado inmutable y control de exposición pública (C-04, C-03, A-09) ----------
  // "status": emitido -> corregido (cuando se edita: el original NO se
  // sobrescribe, se crea una fila nueva y el original queda marcado como
  // corregido con un enlace a la fila que lo reemplaza) -> anulado (el
  // médico anula el documento, con motivo obligatorio; no se borra la fila
  // físicamente, así el historial médico-legal se conserva siempre).
  await ensureColumn("certificates", "status", "TEXT NOT NULL DEFAULT 'emitido'");  await ensureColumn("certificates", "corrected_from_id", "INTEGER REFERENCES certificates(id)");
  await ensureColumn("certificates", "superseded_by_id", "INTEGER REFERENCES certificates(id)");
  await ensureColumn("certificates", "void_reason", "TEXT");
  await ensureColumn("certificates", "voided_at", "TEXT");
  await ensureColumn("certificates", "voided_by", "TEXT");
  // Enlace público (WhatsApp) con caducidad y revocación — antes no expiraba nunca.
  await ensureColumn("certificates", "share_expires_at", "TEXT");
  await ensureColumn("certificates", "share_revoked", "INTEGER NOT NULL DEFAULT 0");

  await ensureColumn("prescriptions", "status", "TEXT NOT NULL DEFAULT 'emitido'");
  await ensureColumn("prescriptions", "corrected_from_id", "INTEGER REFERENCES prescriptions(id)");
  await ensureColumn("prescriptions", "superseded_by_id", "INTEGER REFERENCES prescriptions(id)");
  await ensureColumn("prescriptions", "void_reason", "TEXT");
  await ensureColumn("prescriptions", "voided_at", "TEXT");
  await ensureColumn("prescriptions", "voided_by", "TEXT");
  // Antes, el mismo "qr_token" servía TANTO para el QR de verificación
  // pública (datos mínimos) COMO para el enlace que descarga el PDF
  // completo por WhatsApp — quien escaneaba el QR de verificación también
  // podía armar la URL del PDF completo. Ahora son dos secretos distintos:
  // qr_token sigue siendo el de verificación mínima; share_token (nuevo,
  // como en certificates) es el único que sirve para el PDF completo, y sí
  // caduca/se puede revocar.
  await ensureColumn("prescriptions", "share_token", "TEXT");  await ensureColumn("prescriptions", "share_expires_at", "TEXT");
  await ensureColumn("prescriptions", "share_revoked", "INTEGER NOT NULL DEFAULT 0");
  // Back-fill: recetas ya emitidas antes de este cambio no tienen
  // share_token todavía (comparten qr_token, que es justo lo que este
  // cambio corrige) — se les asigna uno propio, generado en JS para no
  // depender de la extensión pgcrypto en el proveedor de Postgres.
  const legacyRx = await pool.query(`SELECT id FROM prescriptions WHERE share_token IS NULL`);
  for (const row of legacyRx.rows) {
    await pool.query(`UPDATE prescriptions SET share_token = $1 WHERE id = $2`, [crypto.randomBytes(16).toString("hex"), row.id]);
  }
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'prescriptions_share_token_key'
      ) THEN
        ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_share_token_key UNIQUE (share_token);
      END IF;
    END $$;
  `);

  // CRÍTICO de la auditoría ("borrar una clínica hace DELETE físico con
  // cascada, sin poder deshacerse, arrastrando pacientes, historiales,
  // recetas, certificados y usuarios de TODA la clínica en una sola
  // operación irreversible"): igual que se hizo con pacientes, una
  // clínica ahora se ARCHIVA en vez de borrarse. Además, se retiran los
  // "ON DELETE CASCADE" hacia clinics en cada tabla dependiente y se
  // reemplazan por "ON DELETE RESTRICT": aunque alguien ejecutara un
  // DELETE FROM clinics a mano (fuera de la aplicación), Postgres se
  // niega a hacerlo si existe cualquier dato dependiente, en vez de
  // borrar todo en cascada silenciosamente.
  await ensureColumn("clinics", "status", "TEXT NOT NULL DEFAULT 'activo'");
  await ensureColumn("clinics", "archived_reason", "TEXT");
  await ensureColumn("clinics", "archived_at", "TEXT");
  await ensureColumn("clinics", "archived_by", "TEXT");
  for (const [table, column] of [
    ["patients", "clinic_id"],
    ["appointments", "clinic_id"],
    ["consultations", "clinic_id"],
    ["doctor_profile", "clinic_id"],
    ["prescriptions", "clinic_id"],
    ["certificates", "clinic_id"],
    ["users", "clinic_id"],
    ["reminder_settings", "clinic_id"],
    ["notification_settings", "clinic_id"],
  ]) {
    const constraintName = `${table}_${column}_fkey`;
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${constraintName}') THEN
          ALTER TABLE ${table} DROP CONSTRAINT ${constraintName};
        END IF;
        ALTER TABLE ${table}
          ADD CONSTRAINT ${constraintName} FOREIGN KEY (${column}) REFERENCES clinics(id) ON DELETE RESTRICT;
      END $$;
    `);
  }

  // CRÍTICO FUNCIONAL/CLÍNICO de la auditoría: antes DELETE /patients/:id
  // borraba la fila físicamente (con ON DELETE CASCADE arrastrando
  // consultas, recetas, certificados y citas). En una historia clínica
  // real eso puede destruir información asistencial sin remedio y romper
  // la trazabilidad exigida. Ahora un paciente se ARCHIVA (no se borra):
  // queda fuera de las búsquedas normales pero su expediente completo
  // sigue intacto y es recuperable.
  await ensureColumn("patients", "status", "TEXT NOT NULL DEFAULT 'activo'");
  await ensureColumn("patients", "archived_reason", "TEXT");
  await ensureColumn("patients", "archived_at", "TEXT");
  await ensureColumn("patients", "archived_by", "TEXT");

  // CRÍTICO FUNCIONAL de la auditoría: antes DELETE /appointments/:id
  // borraba la cita físicamente. Ahora se cancela (status='cancelada',
  // que ya existía) con un motivo obligatorio que sí queda guardado.
  // GRAVE de la auditoría (webhook de Twilio): antes se respondía a "la
  // próxima cita programada/confirmada" del paciente que coincidiera por
  // teléfono — si tenía dos citas cercanas, la respuesta podía aplicarse
  // a la cita equivocada. Ahora se guarda a qué teléfono se envió cada
  // recordatorio saliente, y el webhook responde sobre la cita del
  // recordatorio MÁS RECIENTE enviado a ese número — es decir, sobre la
  // conversación real que se está respondiendo.
  await ensureColumn("reminder_log", "phone", "TEXT");

  // GRAVE de la auditoría: "el JWT es válido 12 horas sin mecanismo
  // central de revocación" — si un token se filtra (o si hay que forzar
  // el cierre de sesión de alguien, p. ej. tras cambiar su contraseña),
  // antes no había forma de invalidarlo antes de que expirara solo.
  // session_version se incluye en el token al iniciar sesión y se
  // compara contra el valor actual en la base en cada petición (ver
  // requireAuth); cambiar la contraseña incrementa este número, lo que
  // invalida automáticamente cualquier token viejo emitido antes del
  // cambio, sin tener que esperar a que expire.
  await ensureColumn("users", "session_version", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("appointments", "cancel_reason", "TEXT");

  // GRAVE de la auditoría (G7): restricciones a nivel de base de datos
  // para los mismos rangos/valores que ya valida la aplicación (ver
  // validators.js) — última línea de defensa, NOT VALID para no arriesgar
  // el arranque por datos históricos (ver addCheckConstraintNotValid).
  await addCheckConstraintNotValid(
    "appointments",
    "appointments_status_check",
    `status IN (${VALID_STATUSES.map((s) => `'${s}'`).join(",")})`
  );
  await addCheckConstraintNotValid("appointments", "appointments_duration_check", "duration_minutes > 0 AND duration_minutes <= 480");
  await addCheckConstraintNotValid("certificates", "certificates_status_check", "status IN ('emitido','corregido','anulado')");
  await addCheckConstraintNotValid("prescriptions", "prescriptions_status_check", "status IN ('emitido','corregido','anulado')");
  await addCheckConstraintNotValid("consultations", "consultations_status_check", "status IN ('emitido','corregido','anulado')");
  await addCheckConstraintNotValid("consultations", "consultations_heart_rate_check", "heart_rate BETWEEN 20 AND 300");
  await addCheckConstraintNotValid("consultations", "consultations_temperature_check", "temperature_c BETWEEN 25 AND 45");
  await addCheckConstraintNotValid("consultations", "consultations_weight_check", "weight_kg BETWEEN 0.3 AND 400");
  await addCheckConstraintNotValid("consultations", "consultations_height_check", "height_cm BETWEEN 15 AND 250");

  // Nuevo rol "enfermera": el médico ahora puede dar de alta UNA cuenta
  // de asistente que sea secretaria O enfermera (antes el CHECK de la
  // base solo permitía 'medico'/'secretaria' — un ALTER TABLE normal no
  // puede "editar" un CHECK existente, hay que quitarlo y ponerlo de
  // nuevo con el valor agregado).
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
        ALTER TABLE users DROP CONSTRAINT users_role_check;
      END IF;
      ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('medico', 'secretaria', 'enfermera'));
    END $$;
  `);

  // Reserva pública de citas: el médico decide si activa la reserva en
  // línea, cuánto dura cada turno por defecto, y su horario semanal de
  // atención (JSON: { "0": [["08:00","13:00"]], "1": [...], ... } con
  // 0 = domingo .. 6 = sábado, cada día con 0 o más rangos horarios).
  await ensureColumn("doctor_profile", "booking_enabled", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("doctor_profile", "booking_slot_minutes", "INTEGER NOT NULL DEFAULT 20");
  await ensureColumn("doctor_profile", "booking_schedule_json", "TEXT");

  // Signos vitales de ingreso: los registra la enfermera (o el médico) al
  // recibir al paciente, ANTES de la consulta — quedan ligados a la cita,
  // y el médico los ve/retoma al abrir la nota clínica de esa cita en vez
  // de tener que volver a tomarlos.
  await ensureColumn("appointments", "intake_weight_kg", "REAL");
  await ensureColumn("appointments", "intake_height_cm", "REAL");
  await ensureColumn("appointments", "intake_blood_pressure", "TEXT");
  await ensureColumn("appointments", "intake_heart_rate", "INTEGER");
  await ensureColumn("appointments", "intake_temperature_c", "REAL");
  await ensureColumn("appointments", "intake_recorded_by", "TEXT");
  await ensureColumn("appointments", "intake_recorded_at", "TEXT");
  // Marca las citas creadas desde la página pública de reservas, para que
  // el consultorio pueda distinguirlas de un vistazo en la agenda.
  await ensureColumn("appointments", "source", "TEXT NOT NULL DEFAULT 'interno'");

  // CRÍTICO POTENCIAL de la auditoría: no había ninguna protección contra
  // dos citas que se traslapan en el mismo horario, ni siquiera frente a
  // dos solicitudes simultáneas (una validación solo en el backend, antes
  // de insertar, sigue teniendo una ventana de carrera: dos peticiones
  // pueden pasar esa validación "al mismo tiempo" y las dos insertar).
  // La única defensa que de verdad funciona bajo concurrencia es una
  // restricción a nivel de base de datos — aquí, un EXCLUDE constraint
  // que usa el rango de tiempo [inicio, inicio+duración) de la cita: dos
  // filas de la MISMA clínica cuyo rango se traslape (y ninguna esté
  // cancelada) quedan bloqueadas por Postgres mismo, sin importar qué
  // tan simultáneas sean las peticiones. Se agrega de forma defensiva:
  // si el proveedor de Postgres no permite crear la extensión, o si ya
  // existen citas traslapadas en los datos actuales (algo posible si
  // nunca hubo esta validación), la migración se salta con una
  // advertencia en vez de tumbar el arranque del servidor — en ese caso
  // solo queda la validación de aplicación (ver routes/appointments.js),
  // que sigue siendo mejor que nada pero no es 100% segura bajo
  // concurrencia real.
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_no_overlap') THEN
          ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
            EXCLUDE USING gist (
              clinic_id WITH =,
              tsrange(start_time::timestamp, start_time::timestamp + (duration_minutes || ' minutes')::interval) WITH &&
            ) WHERE (status <> 'cancelada');
        END IF;
      END $$;
    `);
  } catch (err) {
    console.warn(
      "[db] No se pudo crear la restricción anti-solapamiento de citas (appointments_no_overlap). " +
        "Puede deberse a que el proveedor de Postgres no permite btree_gist, o a que ya existen citas " +
        "traslapadas en los datos actuales. La app sigue funcionando con la validación de aplicación " +
        "únicamente. Detalle:",
      err.message
    );
  }

  // Notas de evolución (consultations) — el audit C-04 las incluye
  // explícitamente junto a recetas y certificados: tampoco deberían poder
  // sobrescribirse/borrarse sin dejar rastro. Sin token de enlace público
  // (nunca se comparten fuera de la app), solo necesitan estado y motivo
  // de anulación.
  await ensureColumn("consultations", "status", "TEXT NOT NULL DEFAULT 'emitido'");
  await ensureColumn("consultations", "corrected_from_id", "INTEGER REFERENCES consultations(id)");
  await ensureColumn("consultations", "superseded_by_id", "INTEGER REFERENCES consultations(id)");
  await ensureColumn("consultations", "void_reason", "TEXT");
  await ensureColumn("consultations", "voided_at", "TEXT");
  await ensureColumn("consultations", "voided_by", "TEXT");

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

  // GRAVE de la auditoría: "audit_log no es estrictamente append-only ni
  // hay separación de privilegios — un operador con acceso amplio a la
  // base podría alterar la evidencia". No controlamos roles de Postgres
  // separados en un hosting compartido típico (Neon/Render), pero SÍ
  // podemos hacer que la tabla se comporte como append-only para
  // CUALQUIER conexión, incluida la propia app: un trigger a nivel de
  // base de datos que rechaza cualquier UPDATE o DELETE contra
  // audit_log, sin importar qué usuario/rol ejecute la sentencia SQL.
  // IMPORTANTE: se crea AQUÍ, después de la migración de arriba (que si
  // corre, sí necesita poder hacer UPDATE audit_log una única vez) — así
  // nunca chocan entre sí.
  await pool.query(`
    CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log es de solo lectura una vez escrito: % no está permitido', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(`DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log`);
  await pool.query(`
    CREATE TRIGGER audit_log_no_update
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
  `);

  // GRAVE de la auditoría ("las credenciales de Twilio/SMTP quedan en
  // texto plano hasta que alguien vuelva a guardar la configuración"):
  // encryptSecret()/decryptSecret() ya sabían convivir con valores legado
  // sin cifrar, pero solo se re-cifraban si el médico volvía a tocar el
  // formulario de configuración — mientras tanto, el secreto seguía
  // legible en texto plano en la base indefinidamente. Aquí se migran
  // AUTOMÁTICAMENTE al arrancar el servidor, sin depender de ninguna
  // acción del usuario.
  const { encryptSecret } = await import("./secretCrypto.js");
  const ENC_PREFIX = "enc1:";
  const legacyTwilioTokens = await pool.query(
    `SELECT clinic_id, twilio_auth_token FROM reminder_settings
     WHERE twilio_auth_token IS NOT NULL AND twilio_auth_token <> '' AND twilio_auth_token NOT LIKE '${ENC_PREFIX}%'`
  );
  for (const row of legacyTwilioTokens.rows) {
    await pool.query(`UPDATE reminder_settings SET twilio_auth_token = $1 WHERE clinic_id = $2`, [
      encryptSecret(row.twilio_auth_token),
      row.clinic_id,
    ]);
  }
  const legacySmtpPasswords = await pool.query(
    `SELECT clinic_id, smtp_pass FROM notification_settings
     WHERE smtp_pass IS NOT NULL AND smtp_pass <> '' AND smtp_pass NOT LIKE '${ENC_PREFIX}%'`
  );
  for (const row of legacySmtpPasswords.rows) {
    await pool.query(`UPDATE notification_settings SET smtp_pass = $1 WHERE clinic_id = $2`, [
      encryptSecret(row.smtp_pass),
      row.clinic_id,
    ]);
  }
  if (legacyTwilioTokens.rows.length > 0 || legacySmtpPasswords.rows.length > 0) {
    console.log(
      `[migración] Se cifraron ${legacyTwilioTokens.rows.length} token(s) de Twilio y ${legacySmtpPasswords.rows.length} contraseña(s) SMTP que estaban en texto plano.`
    );
  }
}

// `tx`: pásalo (el objeto que te da withTransaction) cuando la escritura
// de auditoría debe formar parte de la MISMA transacción que el cambio
// que audita (así, si la transacción hace rollback, tampoco queda un
// registro de auditoría huérfano describiendo un cambio que en realidad
// no se guardó). Por defecto usa el pool normal (para los muchos casos
// que no son multi-paso).
export async function logAudit({ clinicId = null, actor = "sistema", action, entity, entityId, detail, tx }) {
  const executor = tx || db;
  await executor
    .prepare(`INSERT INTO audit_log (clinic_id, actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(clinicId, actor, action, entity, entityId ?? null, detail ? JSON.stringify(detail) : null);
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
