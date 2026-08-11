import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

export default function DiagnosisSearch({ code, label, onSelect }) {
  const [query, setQuery] = useState(label || "");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    setQuery(label || "");
  }, [label]);

  function handleChange(e) {
    const value = e.target.value;
    setQuery(value);
    onSelect({ code: "", label: value }); // permite texto libre si no elige de la lista
    clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const matches = await api.cie11.search(value);
      setResults(matches);
      setOpen(matches.length > 0);
    }, 250);
  }

  function pick(item) {
    setQuery(`${item.code} — ${item.label}`);
    onSelect({ code: item.code, label: item.label });
    setOpen(false);
  }

  return (
    <div className="diagnosis-search">
      <input
        value={query}
        onChange={handleChange}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Escribe para buscar (ej. Diabetes)…"
      />
      {code && <span className="cie-code-badge">{code}</span>}
      {open && (
        <ul className="diagnosis-dropdown">
          {results.map((r) => (
            <li key={r.code} onMouseDown={() => pick(r)}>
              <span className="cie-code">{r.code}</span> {r.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
