import { useState } from "react";
import { api } from "../api.js";
import MedicationSearch from "./MedicationSearch.jsx";
import { DOSE_FREQUENCY_OPTIONS, TREATMENT_DURATION_OPTIONS, ADMINISTRATION_ROUTE_OPTIONS } from "../soapCatalogs.js";

// existing: si se pasa una receta ya emitida (con .items), el modal edita
// esa receta en vez de crear una nueva.
//
// CRÍTICO de la auditoría ("prescripción demasiado permisiva"): dosis,
// vía, frecuencia y duración/cantidad ahora son obligatorias (el backend
// las exige — ver validators.js). Se agregan "vía" y "cantidad
// total"/"indicación", que antes no existían en este formulario.
export default function PrescriptionModal({ patientId, consultationId, existing = null, doctorReady, onClose, onOpenDoctorProfile }) {
  const isEdit = Boolean(existing);
  const [items, setItems] = useState(() =>
    existing ? existing.items.map((it, i) => ({ key: `existing-${i}`, ...it })) : []
  );
  const [instructions, setInstructions] = useState(existing?.instructions || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [doneId, setDoneId] = useState(null);

  function addMedication(med) {
    setItems((prev) => [
      ...prev,
      {
        key: `${med.id}-${prev.length}`,
        generic_name: med.generic_name,
        commercial_name: med.commercial_names?.split(",")[0]?.trim() || "",
        presentation: med.presentation,
        dose: "",
        route: "",
        quantity: "",
        frequency: "",
        duration: "",
        indication: "",
      },
    ]);
  }

  function updateItem(idx, field, value) {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [field]: value } : it)));
  }

  function removeItem(idx) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e, overrideAllergy = false, overrideReason = "") {
    e?.preventDefault?.();
    setError(null);
    if (items.length === 0) {
      setError("Agrega al menos un medicamento.");
      return;
    }
    setSaving(true);
    const payload = {
      items: items.map(({ key, ...rest }) => rest),
      instructions,
      ...(overrideAllergy ? { confirm_allergy_override: true, override_reason: overrideReason } : {}),
    };
    try {
      let result;
      if (isEdit) {
        // C-04: editar ahora crea una CORRECCIÓN (una fila nueva); usamos
        // el id que regresa el servidor, no el de la receta original.
        result = await api.prescriptions.update(existing.id, payload);
      } else {
        result = await api.prescriptions.create({ patient_id: patientId, consultation_id: consultationId ?? null, ...payload });
      }
      if (result.duplicate_warnings?.length > 0) {
        const detail = result.duplicate_warnings.map((d) => `• ${d.generic_name}`).join("\n");
        alert(`⚠️ Hay medicamentos repetidos (duplicidad terapéutica) en esta receta:\n\n${detail}`);
      }
      setDoneId(result.id);
    } catch (err) {
      // CRÍTICO de la auditoría ("el override nunca debe ser una bandera
      // booleana sin trazabilidad"): el backend ahora también exige un
      // motivo clínico (mínimo 10 caracteres) para poder continuar pese a
      // la alerta de alergia — se pide aquí y viaja junto con la
      // confirmación, quedando registrado en la bitácora de auditoría.
      if (err.allergy_conflicts?.length > 0) {
        const detail = err.allergy_conflicts.map((c) => `• ${c.medication} (alergia registrada: ${c.allergy})`).join("\n");
        const proceed = confirm(
          `⚠️ Posible alergia registrada en este paciente:\n\n${detail}\n\n¿Deseas continuar de todas formas?`
        );
        if (proceed) {
          const reason = prompt("Indica el motivo clínico para continuar pese a la alerta de alergia (mínimo 10 caracteres):");
          if (reason && reason.trim().length >= 10) {
            setSaving(false);
            return handleSubmit(null, true, reason.trim());
          }
          setError("Se requiere un motivo clínico de al menos 10 caracteres para continuar pese a la alerta de alergia.");
        } else {
          setError("No se emitió la receta: hay una alerta de alergia sin confirmar.");
        }
      } else {
        setError(err.message);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-card rx-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tab" style={{ background: "#5B6B5F" }} />
        <h2 className="modal-title">{isEdit ? "Editar receta electrónica" : "Nueva receta electrónica"}</h2>

        {!doctorReady && (
          <p className="hint rx-warning">
            No has llenado el perfil del médico — la receta se generará sin encabezado.{" "}
            <button type="button" className="link-btn" onClick={onOpenDoctorProfile}>
              Llenarlo ahora
            </button>
          </p>
        )}

        {doneId ? (
          <div className="rx-success">
            <p>✓ Receta {isEdit ? "actualizada" : "generada"} correctamente.</p>
            <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
              <a className="btn-primary" href={api.prescriptions.pdfUrl(doneId)} target="_blank" rel="noreferrer">
                Ver / descargar PDF
              </a>
              <button className="btn-ghost" onClick={onClose}>
                Cerrar
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <label className="soap-block">
              <span className="soap-letter">Agregar medicamento</span>
              <MedicationSearch onSelect={addMedication} />
            </label>

            {items.length > 0 && (
              <ul className="rx-item-list">
                {items.map((item, idx) => (
                  <li key={item.key} className="rx-item">
                    <div className="rx-item-header">
                      <strong>
                        {item.generic_name}
                        {item.commercial_name ? ` (${item.commercial_name})` : ""}
                      </strong>
                      <button type="button" className="link-btn" onClick={() => removeItem(idx)}>
                        Quitar
                      </button>
                    </div>
                    <div className="rx-item-sub">{item.presentation}</div>
                    <div className="rx-item-grid">
                      <input
                        placeholder="Dosis por toma (ej. 1 tableta) *"
                        value={item.dose}
                        onChange={(e) => updateItem(idx, "dose", e.target.value)}
                      />
                      <select value={item.route || ""} onChange={(e) => updateItem(idx, "route", e.target.value)}>
                        <option value="">Vía de administración… *</option>
                        {ADMINISTRATION_ROUTE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <select value={item.frequency} onChange={(e) => updateItem(idx, "frequency", e.target.value)}>
                        <option value="">Frecuencia… *</option>
                        {DOSE_FREQUENCY_OPTIONS.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                      <select value={item.duration} onChange={(e) => updateItem(idx, "duration", e.target.value)}>
                        <option value="">Duración… *</option>
                        {TREATMENT_DURATION_OPTIONS.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                      <input
                        placeholder="Cantidad total (ej. 20 tabletas)"
                        value={item.quantity || ""}
                        onChange={(e) => updateItem(idx, "quantity", e.target.value)}
                      />
                      <input
                        placeholder="Indicación de uso (opcional)"
                        value={item.indication || ""}
                        onChange={(e) => updateItem(idx, "indication", e.target.value)}
                      />
                    </div>
                    <p className="hint" style={{ marginTop: 4 }}>
                      * Obligatorios. Duración o cantidad total: al menos uno de los dos.
                    </p>
                  </li>
                ))}
              </ul>
            )}

            <label className="soap-block" style={{ marginTop: 14 }}>
              <span className="soap-letter">Indicaciones adicionales</span>
              <textarea rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            </label>

            {error && <p className="form-error">{error}</p>}

            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={onClose}>
                Cancelar
              </button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? "Guardando…" : isEdit ? "Guardar cambios" : "Generar receta"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
