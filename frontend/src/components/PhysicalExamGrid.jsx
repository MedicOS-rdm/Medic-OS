import { PHYSICAL_EXAM_TEMPLATE } from "../soapCatalogs.js";

// La plantilla "AL EF..." completa, en grilla de 2 columnas anchas para
// que no quede una fila larguísima. Cada línea es un <select> con las
// opciones más comunes (la primera es el hallazgo normal/esperado).
export default function PhysicalExamGrid({ exam, onChange }) {
  function set(key, value) {
    onChange({ ...exam, [key]: value });
  }

  return (
    <div className="physical-exam-grid">
      {PHYSICAL_EXAM_TEMPLATE.map((row) => (
        <label key={row.key}>
          {row.label}
          <select value={exam[row.key] ?? row.options[0]} onChange={(e) => set(row.key, e.target.value)}>
            {row.options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}
