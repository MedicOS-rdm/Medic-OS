import { useState } from "react";
import { api } from "../api.js";

export default function AppointmentModal({ date, patients, onClose, onCreated, onNewPatient }) {
  const [patientId, setPatientId] = useState("");
  const [time, setTime] = useState("09:00");
  const [visitType, setVisitType] = useState("subsecuente");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!patientId) {
      setError("Selecciona un paciente.");
      return;
    }
    setSaving(true);
    try {
      const start_time = `${date}T${time}:00`;
      const appt = await api.appointments.create({
        patient_id: Number(patientId),
        start_time,
        visit_type: visitType,
        reason,
      });
      onCreated(appt);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tab" style={{ background: "#2B5C8A" }} />
        <h2 className="modal-title">Nueva cita · {date}</h2>
        <form onSubmit={handleSubmit} className="form-grid">
          <label className="span-2">
            Paciente*
            {patients.length === 0 ? (
              <p className="hint">
                Aún no hay pacientes.{" "}
                <button type="button" className="link-btn" onClick={onNewPatient}>
                  Registrar uno primero
                </button>
              </p>
            ) : (
              <select value={patientId} onChange={(e) => setPatientId(e.target.value)} autoFocus>
                <option value="">Selecciona…</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.first_name} {p.last_name}
                  </option>
                ))}
              </select>
            )}
          </label>

          <label>
            Hora*
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>

          <label>
            Tipo de consulta
            <select value={visitType} onChange={(e) => setVisitType(e.target.value)}>
              <option value="subsecuente">Subsecuente (20 min)</option>
              <option value="primera_vez">Primera vez (45 min)</option>
            </select>
          </label>

          <label className="span-2">
            Motivo de consulta
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej. Control de presión" />
          </label>

          {error && <p className="form-error span-2">{error}</p>}

          <div className="modal-actions span-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn-primary" disabled={saving || patients.length === 0}>
              {saving ? "Agendando…" : "Agendar cita"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
