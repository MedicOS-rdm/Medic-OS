import { useState } from "react";

// Un <select> con la lista de opciones + botón "Agregar", más una lista de
// chips removibles abajo con lo ya elegido. Incluye "Otro…" para escribir
// algo que no esté en la lista.
export default function MultiSelectChips({ options, values, onChange, placeholder = "Seleccionar…" }) {
  const [pending, setPending] = useState("");
  const [customText, setCustomText] = useState("");

  function addValue(v) {
    const value = v.trim();
    if (!value || values.includes(value)) return;
    onChange([...values, value]);
  }

  function handleAddClick() {
    if (pending === "__other__") {
      addValue(customText);
      setCustomText("");
    } else {
      addValue(pending);
    }
    setPending("");
  }

  function removeValue(v) {
    onChange(values.filter((x) => x !== v));
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8 }}>
        <select value={pending} onChange={(e) => setPending(e.target.value)} style={{ flex: 1 }}>
          <option value="">{placeholder}</option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
          <option value="__other__">Otro…</option>
        </select>
        {pending === "__other__" && (
          <input
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder="Escribir estudio…"
            style={{ flex: 1 }}
          />
        )}
        <button type="button" className="btn-ghost sm" onClick={handleAddClick} disabled={!pending}>
          Agregar
        </button>
      </div>
      {values.length > 0 && (
        <div className="chip-list">
          {values.map((v) => (
            <span key={v} className="chip">
              {v}
              <button type="button" onClick={() => removeValue(v)} aria-label={`Quitar ${v}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
