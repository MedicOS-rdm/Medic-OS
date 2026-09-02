import { useRef, useState } from "react";
import { api } from "../api.js";

export default function MedicationSearch({ onSelect }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);

  function handleChange(e) {
    const value = e.target.value;
    setQuery(value);
    clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const matches = await api.medications.search(value);
      setResults(matches);
      setOpen(matches.length > 0);
    }, 250);
  }

  function pick(item) {
    onSelect(item);
    setQuery("");
    setResults([]);
    setOpen(false);
  }

  return (
    <div className="diagnosis-search">
      <input
        value={query}
        onChange={handleChange}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Escribe para buscar (ej. Paracetamol)…"
      />
      {/* CRÍTICO de la auditoría ("no existe una barrera de seguridad
          farmacológica real"): este catálogo es solo una lista local de
          nombres/presentaciones para agilizar la escritura de la receta.
          NO valida interacciones, contraindicaciones, ni dosis máximas —
          eso requiere una fuente farmacológica oficial licenciada, fuera
          del alcance de este catálogo. Se deja explícito para no generar
          una falsa sensación de que el sistema ya filtra eso. */}
      <p className="hint" style={{ marginTop: 4 }}>
        Catálogo local de referencia rápida — no revisa interacciones, contraindicaciones ni dosis máximas. El criterio clínico es siempre del médico.
      </p>
      {open && (
        <ul className="diagnosis-dropdown">
          {results.map((r) => (
            <li key={r.id} onMouseDown={() => pick(r)}>
              <strong>{r.generic_name}</strong>
              {r.commercial_names ? ` (${r.commercial_names})` : ""} — {r.presentation}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
