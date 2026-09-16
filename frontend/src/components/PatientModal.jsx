import { useEffect, useState } from "react";
import { api } from "../api.js";
import { formatAge } from "../utils/age.js";
import { vitalsAlerts, numericOptions, VITAL_DEFAULTS } from "../utils/vitals.js";

const EMPTY = {
  first_name: "",
  last_name: "",
  birth_date: "",
  gender: "",
  phone: "",
  email: "",
  emergency_contact_name: "",
  emergency_contact_phone: "",
  blood_type: "",
  allergies: "",
  chronic_conditions: "",
  id_number: "",
  address: "",
  workplace: "",
  job_title: "",
  clinical_history_number: "",
  // Corrección solicitada por el usuario: FC, temperatura, frecuencia
  // respiratoria, SaO2, peso y talla se ingresan con un <select> ubicado
  // por defecto en el valor normal.
  blood_pressure: VITAL_DEFAULTS.blood_pressure,
  heart_rate: VITAL_DEFAULTS.heart_rate,
  temperature_c: VITAL_DEFAULTS.temperature_c,
  respiratory_rate: VITAL_DEFAULTS.respiratory_rate,
  oxygen_saturation: VITAL_DEFAULTS.oxygen_saturation,
  weight_kg: VITAL_DEFAULTS.weight_kg,
  height_cm: VITAL_DEFAULTS.height_cm,
};

// patient: si se pasa, el modal edita ese paciente en vez de crear uno nuevo.
// canEditClinical: nuevo rol "enfermera" — puede ver/editar alergias,
// antecedentes Y signos vitales igual que el médico (antes los signos
// vitales solo se podían registrar si existía una cita ESE día — si no
// había ninguna, la enfermera no tenía dónde ingresarlos). Por defecto
// sigue el valor de isMedico para no romper los usos existentes.
export default function PatientModal({ isMedico = true, canEditClinical = isMedico, patient = null, onClose, onCreated, onUpdated }) {
  const isEdit = Boolean(patient);
  const [form, setForm] = useState(() =>
    patient
      ? {
          ...EMPTY,
          ...patient,
          blood_pressure: patient.last_blood_pressure || EMPTY.blood_pressure,
          heart_rate: patient.last_heart_rate != null ? String(patient.last_heart_rate) : EMPTY.heart_rate,
          temperature_c: patient.last_temperature_c != null ? String(patient.last_temperature_c) : EMPTY.temperature_c,
          respiratory_rate: patient.last_respiratory_rate != null ? String(patient.last_respiratory_rate) : EMPTY.respiratory_rate,
          oxygen_saturation: patient.last_oxygen_saturation != null ? String(patient.last_oxygen_saturation) : EMPTY.oxygen_saturation,
          weight_kg: patient.last_weight_kg != null ? String(patient.last_weight_kg) : EMPTY.weight_kg,
          height_cm: patient.last_height_cm != null ? String(patient.last_height_cm) : EMPTY.height_cm,
        }
      : EMPTY
  );
  const [historyPlaceholder, setHistoryPlaceholder] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Al crear un paciente nuevo, mostramos como sugerencia (placeholder, no
  // valor forzado) el siguiente número de historia clínica de la clínica.
  // Si el médico deja el campo vacío, el backend asigna ese mismo número al
  // guardar; si escribe uno distinto, se respeta el que él ponga.
  useEffect(() => {
    if (isEdit) return;
    api.patients.nextHistoryNumber().then(({ suggestion }) => setHistoryPlaceholder(suggestion));
  }, [isEdit]);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  // Corrección funcional: "si los signos vitales están alterados se
  // presentarán de rojo para marcar la alerta" — se calcula en cada
  // tecleo, sin esperar a guardar.
  const alerts = canEditClinical ? vitalsAlerts(form) : {};

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!form.first_name.trim() || !form.last_name.trim()) {
      setError("Nombre y apellido son obligatorios.");
      return;
    }
    setSaving(true);
    try {
      if (isEdit) {
        const updated = await api.patients.update(patient.id, form);
        onUpdated(updated);
      } else {
        const created = await api.patients.create(form);
        onCreated(created);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-card" style={{ maxWidth: canEditClinical ? 780 : 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-tab" style={{ background: "#0460D3" }} />
        <h2 className="modal-title">{isEdit ? "Editar paciente" : "Nuevo paciente"}</h2>
        <form onSubmit={handleSubmit}>
          {/* Corrección solicitada por el usuario: antes los signos
              vitales quedaban al final del formulario, debajo de todos
              los datos generales — la enfermera podía pasarlos por alto
              sin darse cuenta. Ahora, cuando quien edita puede registrar
              datos clínicos (médico/enfermera), el modal se ensancha y
              los signos vitales (junto con alergias/antecedentes) van en
              un recuadro aparte, bien visible, al lado de los datos
              generales — no al final ni escondidos tras un scroll. */}
          <div className={canEditClinical ? "patient-modal-columns" : ""}>
            <div className={canEditClinical ? "patient-modal-col-main form-grid" : "form-grid"}>
              <label>
                Nombre*
                <input value={form.first_name} onChange={set("first_name")} autoFocus />
              </label>
              <label>
                Apellido*
                <input value={form.last_name} onChange={set("last_name")} />
              </label>
              <label>
                Fecha de nacimiento
                <input type="date" value={form.birth_date || ""} onChange={set("birth_date")} />
              </label>
              <label>
                Edad
                <input value={formatAge(form.birth_date) || "—"} disabled placeholder="Se calcula sola" />
              </label>
              <label>
                Género
                <select value={form.gender || ""} onChange={set("gender")}>
                  <option value="">Seleccionar…</option>
                  <option value="F">Femenino</option>
                  <option value="M">Masculino</option>
                  <option value="Otro">Otro</option>
                </select>
              </label>
              <label>
                Teléfono
                <input value={form.phone || ""} onChange={set("phone")} />
              </label>
              <label>
                Correo
                <input type="email" value={form.email || ""} onChange={set("email")} />
              </label>
              <label>
                Contacto de emergencia
                <input value={form.emergency_contact_name || ""} onChange={set("emergency_contact_name")} />
              </label>
              <label>
                Teléfono de emergencia
                <input value={form.emergency_contact_phone || ""} onChange={set("emergency_contact_phone")} />
              </label>
              <label>
                Tipo de sangre
                <input value={form.blood_type || ""} onChange={set("blood_type")} placeholder="O+" />
              </label>
              <label>
                Número de cédula
                <input value={form.id_number || ""} onChange={set("id_number")} />
              </label>
              <label className="span-2">
                Dirección domiciliaria
                <input value={form.address || ""} onChange={set("address")} />
              </label>
              <label>
                Institución o empresa
                <input value={form.workplace || ""} onChange={set("workplace")} />
              </label>
              <label>
                Puesto de trabajo
                <input value={form.job_title || ""} onChange={set("job_title")} />
              </label>
              <label>
                Número de historia clínica
                <input
                  value={form.clinical_history_number || ""}
                  onChange={set("clinical_history_number")}
                  placeholder={isEdit ? "" : historyPlaceholder ? `Se asignará ${historyPlaceholder} si lo dejas vacío` : ""}
                />
              </label>
            </div>

            {canEditClinical && (
              <div className="patient-modal-col-vitals">
                <h3 className="history-title" style={{ marginTop: 0 }}>
                  Signos vitales
                </h3>
                <div className="form-grid">
                  <label>
                    Presión arterial
                    <input
                      value={form.blood_pressure || ""}
                      onChange={set("blood_pressure")}
                      placeholder="120/80"
                      className={alerts.blood_pressure ? "input-alert" : ""}
                    />
                    {alerts.blood_pressure && <span className="form-alert">⚠ {alerts.blood_pressure}</span>}
                  </label>
                  <label>
                    Frecuencia cardíaca (lpm)
                    <select value={form.heart_rate || ""} onChange={set("heart_rate")} className={alerts.heart_rate ? "input-alert" : ""}>
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
                      value={form.temperature_c || ""}
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
                      value={form.respiratory_rate || ""}
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
                      value={form.oxygen_saturation || ""}
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
                    <select value={form.weight_kg || ""} onChange={set("weight_kg")}>
                      {numericOptions(1, 150, 0.5, form.weight_kg).map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Talla (cm)
                    <select value={form.height_cm || ""} onChange={set("height_cm")}>
                      {numericOptions(30, 220, 1, form.height_cm).map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {patient?.vitals_recorded_at && (
                  <p className="hint">
                    Últimos signos registrados el {patient.vitals_recorded_at} por {patient.vitals_recorded_by || "—"}.
                  </p>
                )}

                <h3 className="history-title">Alergias y antecedentes</h3>
                <div className="form-grid">
                  <label>
                    Alergias
                    <input
                      value={form.allergies || ""}
                      onChange={set("allergies")}
                      placeholder="Ej. Penicilina — se mostrará como alerta roja"
                      className={form.allergies ? "input-alert" : ""}
                    />
                  </label>
                  {form.allergies && <p className="form-alert">⚠ Alergia registrada: {form.allergies}</p>}
                  <label>
                    Enfermedades crónicas / antecedentes patológicos importantes
                    <textarea rows={2} value={form.chronic_conditions || ""} onChange={set("chronic_conditions")} />
                  </label>
                </div>
              </div>
            )}
          </div>

          {error && <p className="form-error">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? "Guardando…" : isEdit ? "Guardar cambios" : "Guardar paciente"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
