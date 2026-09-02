import { Router } from "express";
import { db, logAudit, withTransaction } from "../db.js";
import { findOverlap } from "./appointments.js";
import { isValidIsoDate, validateBirthDate } from "../validators.js";

// Backend de la página pública de reservas (frontend/public/reservas.html):
// SIN autenticación (cualquier paciente en internet la usa), por eso:
//  - está montada con un rate limit estricto propio (ver server.js)
//  - nunca expone datos clínicos ni de otros pacientes
//  - solo puede escribir dos cosas: un paciente nuevo (o reutilizar uno ya
//    existente por número de cédula) y una cita, dentro de un horario que
//    el propio médico configuró y activó explícitamente (booking_enabled).
export const publicBookingRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/public/booking/doctors?q=texto -> buscar médicos que tengan la
// reserva pública activada (nunca los que no la activaron).
publicBookingRouter.get("/doctors", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
  const like = `%${q}%`;
  const rows = await db
    .prepare(
      `SELECT clinic_id, full_name, specialty, clinic_name, clinic_address
       FROM doctor_profile
       WHERE booking_enabled = 1 AND (full_name ILIKE ? OR specialty ILIKE ? OR clinic_name ILIKE ?)
       ORDER BY full_name LIMIT 15`
    )
    .all(like, like, like);
  res.json(rows);
});

function weekdayOf(dateStr) {
  // dateStr es "AAAA-MM-DD" (fecha pura, sin hora) — se arma en UTC para
  // que el día de la semana no dependa de la zona horaria del servidor.
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=domingo … 6=sábado
}

function addMinutesToHHMM(hhmm, minutes) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

// GET /api/public/booking/availability?clinic_id=&date=AAAA-MM-DD ->
// turnos libres ese día, según el horario semanal que configuró el
// médico menos las citas que ya existan (de cualquier origen, interno o
// público) en ese horario.
publicBookingRouter.get("/availability", async (req, res) => {
  const clinicId = Number(req.query.clinic_id);
  const date = String(req.query.date || "");
  if (!clinicId) return res.status(400).json({ error: "clinic_id es obligatorio" });
  if (!isValidIsoDate(date)) return res.status(400).json({ error: "date debe ser una fecha calendario válida (AAAA-MM-DD)" });

  const today = new Date().toISOString().slice(0, 10);
  if (date < today) return res.status(400).json({ error: "No se pueden reservar fechas pasadas." });

  const profile = await db
    .prepare(`SELECT booking_enabled, booking_slot_minutes, booking_schedule_json FROM doctor_profile WHERE clinic_id = ?`)
    .get(clinicId);
  if (!profile || !profile.booking_enabled) {
    return res.status(404).json({ error: "Este médico no tiene la reserva en línea activada." });
  }

  const schedule = profile.booking_schedule_json ? JSON.parse(profile.booking_schedule_json) : {};
  const ranges = schedule[String(weekdayOf(date))] || [];
  if (ranges.length === 0) return res.json({ slots: [] });

  const existing = await db
    .prepare(`SELECT start_time, duration_minutes FROM appointments WHERE clinic_id = ? AND status <> 'cancelada' AND start_time::date = ?::date`)
    .all(clinicId, date);
  const busy = existing.map((a) => {
    const start = new Date(a.start_time).getTime();
    return { start, end: start + a.duration_minutes * 60000 };
  });

  const nowIso = new Date().toISOString();
  const slotMinutes = profile.booking_slot_minutes;
  const slots = [];
  for (const [start, end] of ranges) {
    let cursor = start;
    while (cursor < end && addMinutesToHHMM(cursor, slotMinutes) <= end) {
      const slotStartIso = `${date}T${cursor}:00`;
      const slotStartMs = new Date(slotStartIso).getTime();
      const slotEndMs = slotStartMs + slotMinutes * 60000;
      const overlaps = busy.some((b) => slotStartMs < b.end && slotEndMs > b.start);
      const isPast = slotStartIso < nowIso;
      if (!overlaps && !isPast) slots.push(cursor);
      cursor = addMinutesToHHMM(cursor, slotMinutes);
    }
  }
  res.json({ slots, slot_minutes: slotMinutes });
});

// POST /api/public/booking -> el paciente confirma su reserva. Crea (o
// reutiliza, por cédula) al paciente y la cita — nunca toca datos
// clínicos (alergias/antecedentes) de un paciente ya existente.
publicBookingRouter.post("/", async (req, res) => {
  const { clinic_id, date, time, patient, reason } = req.body;
  const clinicId = Number(clinic_id);
  if (!clinicId) return res.status(400).json({ error: "clinic_id es obligatorio" });
  if (!isValidIsoDate(date)) return res.status(400).json({ error: "La fecha no es válida." });
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(time || ""))) return res.status(400).json({ error: "La hora no es válida." });
  if (!reason || !reason.trim()) return res.status(400).json({ error: "Indica el motivo de la consulta." });
  if (reason.trim().length > 500) return res.status(400).json({ error: "El motivo de la consulta es demasiado largo." });

  if (!patient || typeof patient !== "object") return res.status(400).json({ error: "Faltan los datos del paciente." });
  const { first_name, last_name, id_number, birth_date, gender, phone, email } = patient;
  if (!first_name?.trim() || !last_name?.trim()) {
    return res.status(400).json({ error: "Nombre y apellido del paciente son obligatorios." });
  }
  if (!id_number || !String(id_number).trim()) {
    return res.status(400).json({ error: "El número de cédula es obligatorio." });
  }
  const birthDateError = validateBirthDate(birth_date);
  if (birthDateError) return res.status(400).json({ error: birthDateError });
  if (!phone || !String(phone).trim()) {
    return res.status(400).json({ error: "El teléfono es obligatorio." });
  }
  if (email && !EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: "El correo no tiene un formato válido." });
  }

  const profile = await db
    .prepare(`SELECT booking_enabled, booking_slot_minutes, booking_schedule_json, full_name, clinic_name FROM doctor_profile WHERE clinic_id = ?`)
    .get(clinicId);
  if (!profile || !profile.booking_enabled) {
    return res.status(404).json({ error: "Este médico no tiene la reserva en línea activada." });
  }
  const schedule = profile.booking_schedule_json ? JSON.parse(profile.booking_schedule_json) : {};
  const ranges = schedule[String(weekdayOf(date))] || [];
  const withinSchedule = ranges.some(([start, end]) => time >= start && addMinutesToHHMM(time, profile.booking_slot_minutes) <= end);
  if (!withinSchedule) {
    return res.status(409).json({ error: "Ese horario ya no está disponible. Elige otro turno." });
  }

  const startTime = `${date}T${time}:00`;
  const startMs = new Date(startTime).getTime();
  if (Number.isNaN(startMs) || startMs < Date.now() - 5 * 60000) {
    return res.status(400).json({ error: "Ese horario ya pasó. Elige uno más adelante." });
  }

  const overlap = await findOverlap(clinicId, startTime, profile.booking_slot_minutes, null);
  if (overlap) {
    return res.status(409).json({ error: "Ese horario acaba de ser tomado por otra persona. Elige otro turno." });
  }

  try {
    const result = await withTransaction(async (tx) => {
      // Reutiliza al paciente si ya existe por cédula en esta clínica —
      // SIN tocar ninguno de sus datos ya guardados (mucho menos los
      // clínicos: alergias/antecedentes/notas). Si no existe, se crea uno
      // nuevo solo con los datos demográficos que la persona acaba de dar.
      let patientRow = await tx
        .prepare(`SELECT id FROM patients WHERE clinic_id = ? AND id_number = ? AND status = 'activo'`)
        .get(clinicId, String(id_number).trim());
      let patientId;
      if (patientRow) {
        patientId = patientRow.id;
      } else {
        const inserted = await tx
          .prepare(
            `INSERT INTO patients (clinic_id, first_name, last_name, id_number, birth_date, gender, phone, email)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            clinicId,
            first_name.trim(),
            last_name.trim(),
            String(id_number).trim(),
            birth_date || null,
            gender || null,
            String(phone).trim(),
            email ? String(email).trim() : null
          );
        patientId = inserted.lastInsertRowid;
        await logAudit({ clinicId, actor: "paciente (reserva pública)", action: "create", entity: "patient", entityId: patientId, tx });
      }

      const apptResult = await tx
        .prepare(
          `INSERT INTO appointments (clinic_id, patient_id, start_time, duration_minutes, visit_type, reason, source)
           VALUES (?, ?, ?, ?, 'primera_vez', ?, 'reserva_publica')`
        )
        .run(clinicId, patientId, startTime, profile.booking_slot_minutes, reason.trim());
      await logAudit({
        clinicId,
        actor: "paciente (reserva pública)",
        action: "create",
        entity: "appointment",
        entityId: apptResult.lastInsertRowid,
        tx,
      });
      return apptResult.lastInsertRowid;
    });

    res.status(201).json({
      ok: true,
      appointment_id: result,
      doctor_name: profile.full_name,
      clinic_name: profile.clinic_name,
      date,
      time,
    });
  } catch (err) {
    if (err.code === "23P01") {
      return res.status(409).json({ error: "Ese horario acaba de ser tomado por otra persona. Elige otro turno." });
    }
    throw err;
  }
});
