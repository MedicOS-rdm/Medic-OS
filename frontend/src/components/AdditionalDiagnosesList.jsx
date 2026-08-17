import DiagnosisSearch from "./DiagnosisSearch.jsx";

// Lista repetible de diagnósticos adicionales, cada uno con el MISMO
// buscador CIE-10 que "Diagnóstico principal".
export default function AdditionalDiagnosesList({ diagnoses, onChange }) {
  function updateAt(idx, value) {
    const next = diagnoses.slice();
    next[idx] = value;
    onChange(next);
  }
  function addRow() {
    onChange([...diagnoses, { code: "", label: "" }]);
  }
  function removeRow(idx) {
    onChange(diagnoses.filter((_, i) => i !== idx));
  }

  return (
    <div className="additional-dx-list">
      {diagnoses.map((dx, idx) => (
        <div key={idx} className="additional-dx-row">
          <DiagnosisSearch code={dx.code} label={dx.label} onSelect={(v) => updateAt(idx, v)} />
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
