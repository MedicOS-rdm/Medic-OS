import MedicationSearch from "./MedicationSearch.jsx";
import { DOSE_FREQUENCY_OPTIONS, TREATMENT_DURATION_OPTIONS } from "../soapCatalogs.js";

// Igual que la lista de medicamentos de "Nueva receta", pero embebida
// dentro de la nota SOAP: lo que el médico agrega aquí se convierte
// automáticamente en la receta al guardar la nota.
export default function TreatmentMedsEditor({ items, onChange }) {
  function addMedication(med) {
    onChange([
      ...items,
      {
        key: `${med.id}-${items.length}-${Date.now()}`,
        generic_name: med.generic_name,
        commercial_name: med.commercial_names?.split(",")[0]?.trim() || "",
        presentation: med.presentation,
        dose: "",
        frequency: "",
        duration: "",
      },
    ]);
  }
  function updateItem(idx, field, value) {
    onChange(items.map((it, i) => (i === idx ? { ...it, [field]: value } : it)));
  }
  function removeItem(idx) {
    onChange(items.filter((_, i) => i !== idx));
  }

  return (
    <div>
      <MedicationSearch onSelect={addMedication} />
      {items.length > 0 && (
        <ul className="rx-item-list" style={{ marginTop: 10 }}>
          {items.map((item, idx) => (
            <li key={item.key ?? idx} className="rx-item">
              <div className="rx-item-header">
                <strong>
                  {item.generic_name}
                  {item.commercial_name ? ` (${item.commercial_name})` : ""}
                </strong>
                <button type="button" className="link-btn link-btn-danger" onClick={() => removeItem(idx)}>
                  Quitar
                </button>
              </div>
              <div className="rx-item-sub">{item.presentation}</div>
              <div className="rx-item-grid">
                <input
                  placeholder="Dosis (ej. 1 tableta)"
                  value={item.dose}
                  onChange={(e) => updateItem(idx, "dose", e.target.value)}
                />
                <select value={item.frequency} onChange={(e) => updateItem(idx, "frequency", e.target.value)}>
                  <option value="">Frecuencia…</option>
                  {DOSE_FREQUENCY_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
                <select value={item.duration} onChange={(e) => updateItem(idx, "duration", e.target.value)}>
                  <option value="">Duración…</option>
                  {TREATMENT_DURATION_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
