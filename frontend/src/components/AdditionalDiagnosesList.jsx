import DiagnosisSearch from "./DiagnosisSearch.jsx";

// CORRECCIÓN 4 solicitada por el usuario ("historia clínica completa
// según normativa ecuatoriana"): el Formulario 002 del MSP exige
// clasificar CADA diagnóstico (no solo el principal) como presuntivo o
// definitivo.
const CERTAINTY_OPTIONS = [
  { value: "presuntivo", label: "Presuntivo" },
  { value: "definitivo", label: "Definitivo" },
];

// Lista repetible de diagnósticos adicionales, cada uno con el MISMO
// buscador CIE-10 que "Diagnóstico principal".
export default function AdditionalDiagnosesList({ diagnoses, onChange }) {
  function updateAt(idx, value) {
    const next = diagnoses.slice();
    next[idx] = { ...next[idx], ...value };
    onChange(next);
  }
  function addRow() {
    onChange([...diagnoses, { code: "", label: "", certainty: "" }]);
  }
  function removeRow(idx) {
    onChange(diagnoses.filter((_, i) => i !== idx));
  }

  return (
    <div className="additional-dx-list">
      {diagnoses.map((dx, idx) => (
        <div key={idx} className="additional-dx-row">
          <DiagnosisSearch code={dx.code} label={dx.label} onSelect={(v) => updateAt(idx, v)} />
          <select
            value={dx.certainty || ""}
            onChange={(e) => updateAt(idx, { certainty: e.target.value })}
            style={{ maxWidth: 140 }}
          >
            <option value="">Tipo…</option>
            {CERTAINTY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button type="button" className="link-btn link-btn-danger" onClick={() => removeRow(idx)}>
            Quitar
          </button>
        </div>
      ))}
      <button type="button" className="link-btn" onClick={addRow}>
        + Agregar diagnóstico adicional
      </button>
    </div>
  );
}
