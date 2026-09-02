import { useEffect, useState } from "react";
import { api } from "../api.js";
import { formatAge } from "../utils/age.js";

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
};

// patient: si se pasa, el modal edita ese paciente en vez de crear uno nuevo.
// canEditClinical: nuevo rol "enfermera" — puede ver/editar alergias y
// antecedentes igual que el médico; por defecto sigue el valor de isMedico
// para no romper los usos existentes del componente.
export default function PatientModal({ isMedico = true, canEditClinical = isMedico, patient = null, onClose, onCreated, onUpdated }) {
  const isEdit = Boolean(patient);
  const [form, setForm] = useState(() => (patient ? { ...EMPTY, ...patient } : EMPTY));
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
      <div className="modal folder-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tab" style={{ background: "#0460D3" }} />
        <h2 className="modal-title">{isEdit ? "Editar paciente" : "Nuevo paciente"}</h2>
        <form onSubmit={handleSubmit} className="form-grid">
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
          {canEditClinical && (
            <>
              <label className="span-2">
                Alergias
                <input
                  value={form.allergies || ""}
                  onChange={set("allergies")}
                  placeholder="Ej. Penicilina — se mostrará como alerta roja"
                />
              </label>
              <label className="span-2">
                Enfermedades crónicas / antecedentes
                <textarea rows={2} value={form.chronic_conditions || ""} onChange={set("chronic_conditions")} />
              </label>
            </>
          )}

          {error && <p className="form-error span-2">{error}</p>}

          <div className="modal-actions span-2">
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
