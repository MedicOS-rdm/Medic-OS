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
