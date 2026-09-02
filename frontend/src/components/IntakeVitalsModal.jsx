import { useState } from "react";
import { api } from "../api.js";

// Nuevo rol "enfermera": permite registrar signos vitales de ingreso
// ligados a una cita, SIN necesidad de abrir la nota clínica completa
// (que sigue siendo exclusiva del médico). El médico, al iniciar la
// consulta de esa cita, puede retomar estos valores en vez de volver a
// tomarlos.
export default function IntakeVitalsModal({ appointment, onClose, onSaved }) {
  const [form, setForm] = useState({
    weight_kg: appointment.intake_weight_kg || "",
    height_cm: appointment.intake_height_cm || "",
    blood_pressure: appointment.intake_blood_pressure || "",
    heart_rate: appointment.intake_heart_rate || "",
    temperature_c: appointment.intake_temperature_c || "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.appointments.setIntake(appointment.id, {
        weight_kg: form.weight_kg || null,
        height_cm: form.height_cm || null,
        blood_pressure: form.blood_pressure || null,
        heart_rate: form.heart_rate || null,
        temperature_c: form.temperature_c || null,
      });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tab" style={{ background: "#5B6B5F" }} />
        <h2 className="modal-title">
          Signos vitales — {appointment.first_name} {appointment.last_name}
        </h2>
        <form onSubmit={handleSubmit} className="form-grid">
          <label>
            Presión arterial
            <input value={form.blood_pressure} onChange={set("blood_pressure")} placeholder="120/80" />
          </label>
          <label>
            Frecuencia cardíaca (lpm)
            <input type="number" value={form.heart_rate} onChange={set("heart_rate")} />
          </label>
          <label>
            Temperatura (°C)
            <input type="number" step="0.1" value={form.temperature_c} onChange={set("temperature_c")} />
          </label>
          <label>
            Peso (kg)
            <input type="number" step="0.1" value={form.weight_kg} onChange={set("weight_kg")} />
          </label>
          <label>
            Talla (cm)
            <input type="number" step="0.1" value={form.height_cm} onChange={set("height_cm")} />
          </label>

          {error && <p className="form-error span-2">{error}</p>}

          <div className="modal-actions span-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? "Guardando…" : "Guardar signos vitales"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
