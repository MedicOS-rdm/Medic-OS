import { useState } from "react";
import { api } from "../api.js";
import { vitalsAlerts, numericOptions, VITAL_DEFAULTS } from "../utils/vitals.js";

// Nuevo rol "enfermera": permite registrar signos vitales de ingreso
// ligados a una cita, SIN necesidad de abrir la nota clínica completa
// (que sigue siendo exclusiva del médico). El médico, al iniciar la
// consulta de esa cita, puede retomar estos valores en vez de volver a
// tomarlos.
//
// Corrección solicitada por el usuario: FC, temperatura, frecuencia
// respiratoria y SaO2 (antes ausente) se ingresan con un <select> ubicado
// por defecto en el valor normal, igual que peso y talla — no con un
// campo numérico vacío.
export default function IntakeVitalsModal({ appointment, onClose, onSaved }) {
  const [form, setForm] = useState({
    weight_kg: appointment.intake_weight_kg != null ? String(appointment.intake_weight_kg) : VITAL_DEFAULTS.weight_kg,
    height_cm: appointment.intake_height_cm != null ? String(appointment.intake_height_cm) : VITAL_DEFAULTS.height_cm,
    blood_pressure: appointment.intake_blood_pressure || VITAL_DEFAULTS.blood_pressure,
    heart_rate: appointment.intake_heart_rate != null ? String(appointment.intake_heart_rate) : VITAL_DEFAULTS.heart_rate,
    temperature_c: appointment.intake_temperature_c != null ? String(appointment.intake_temperature_c) : VITAL_DEFAULTS.temperature_c,
    respiratory_rate: appointment.intake_respiratory_rate != null ? String(appointment.intake_respiratory_rate) : VITAL_DEFAULTS.respiratory_rate,
    oxygen_saturation: appointment.intake_oxygen_saturation != null ? String(appointment.intake_oxygen_saturation) : VITAL_DEFAULTS.oxygen_saturation,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  // Corrección funcional: resalta en rojo mientras se escribe si el valor
  // ingresado está fuera de rango clínico normal.
  const alerts = vitalsAlerts(form);

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
        respiratory_rate: form.respiratory_rate || null,
        oxygen_saturation: form.oxygen_saturation || null,
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
            <input
              value={form.blood_pressure}
              onChange={set("blood_pressure")}
              placeholder="120/80"
              className={alerts.blood_pressure ? "input-alert" : ""}
            />
            {alerts.blood_pressure && <span className="form-alert">⚠ {alerts.blood_pressure}</span>}
          </label>
          <label>
            Frecuencia cardíaca (lpm)
            <select value={form.heart_rate} onChange={set("heart_rate")} className={alerts.heart_rate ? "input-alert" : ""}>
              {numericOptions(30, 220, 1, form.heart_rate).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            {alerts.heart_rate && <span className="form-alert">⚠ {alerts.heart_rate}</span>}
          </label>
          <label>
            Temperatura (°C)
            <select
              value={form.temperature_c}
              onChange={set("temperature_c")}
              className={alerts.temperature_c ? "input-alert" : ""}
            >
              {numericOptions(34, 42, 0.1, form.temperature_c).map((v) => (
                <option key={v} value={v}>
                  {v.toFixed(1)}
                </option>
              ))}
            </select>
            {alerts.temperature_c && <span className="form-alert">⚠ {alerts.temperature_c}</span>}
          </label>
          <label>
            Frecuencia respiratoria (rpm)
            <select
              value={form.respiratory_rate}
              onChange={set("respiratory_rate")}
              className={alerts.respiratory_rate ? "input-alert" : ""}
            >
              {numericOptions(8, 60, 1, form.respiratory_rate).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            {alerts.respiratory_rate && <span className="form-alert">⚠ {alerts.respiratory_rate}</span>}
          </label>
          <label>
            Saturación de oxígeno (%)
            <select
              value={form.oxygen_saturation}
              onChange={set("oxygen_saturation")}
              className={alerts.oxygen_saturation ? "input-alert" : ""}
            >
              {numericOptions(70, 100, 1, form.oxygen_saturation).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            {alerts.oxygen_saturation && <span className="form-alert">⚠ {alerts.oxygen_saturation}</span>}
          </label>
          <label>
            Peso (kg)
            <select value={form.weight_kg} onChange={set("weight_kg")}>
              {numericOptions(1, 150, 0.5, form.weight_kg).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Talla (cm)
            <select value={form.height_cm} onChange={set("height_cm")}>
              {numericOptions(30, 220, 1, form.height_cm).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
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
