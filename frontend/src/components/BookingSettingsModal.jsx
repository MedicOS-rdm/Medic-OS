import { useEffect, useState } from "react";
import { api } from "../api.js";

const DAYS = [
  { key: "1", label: "Lunes" },
  { key: "2", label: "Martes" },
  { key: "3", label: "Miércoles" },
  { key: "4", label: "Jueves" },
  { key: "5", label: "Viernes" },
  { key: "6", label: "Sábado" },
  { key: "0", label: "Domingo" },
];

// Nueva página pública de reservas (frontend/public/reservas.html): el
// médico activa aquí si acepta reservas en línea, cuánto dura cada turno,
// y en qué horario de cada día de la semana. Un solo rango por día (ej.
// "08:00–13:00") mantiene el formulario simple; si el médico atiende en
// dos bloques (mañana y tarde), puede agregar un segundo rango con "+".
export default function BookingSettingsModal({ onClose }) {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [slotMinutes, setSlotMinutes] = useState(20);
  // { [dayKey]: [["08:00","13:00"], ...] }
  const [schedule, setSchedule] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const profile = await api.doctorProfile.get();
        setEnabled(Boolean(profile.booking_enabled));
        setSlotMinutes(profile.booking_slot_minutes || 20);
        setSchedule(profile.booking_schedule_json ? JSON.parse(profile.booking_schedule_json) : {});
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function toggleDay(dayKey, active) {
    setSchedule((prev) => {
      const next = { ...prev };
      if (active) next[dayKey] = [["08:00", "13:00"]];
      else delete next[dayKey];
      return next;
    });
  }

  function updateRange(dayKey, idx, pos, value) {
    setSchedule((prev) => {
      const ranges = (prev[dayKey] || []).map((r, i) => (i === idx ? (pos === 0 ? [value, r[1]] : [r[0], value]) : r));
      return { ...prev, [dayKey]: ranges };
    });
  }

  function addRange(dayKey) {
    setSchedule((prev) => ({ ...prev, [dayKey]: [...(prev[dayKey] || []), ["14:00", "18:00"]] }));
  }

  function removeRange(dayKey, idx) {
    setSchedule((prev) => {
      const ranges = (prev[dayKey] || []).filter((_, i) => i !== idx);
      const next = { ...prev };
      if (ranges.length === 0) delete next[dayKey];
      else next[dayKey] = ranges;
      return next;
    });
  }

  async function handleSave(e) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    setSaved(false);
    try {
      await api.doctorProfile.updateBooking({
        booking_enabled: enabled,
        booking_slot_minutes: Number(slotMinutes),
        booking_schedule: schedule,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const publicUrl = `${window.location.origin}/reservas`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
        <div className="modal-tab" style={{ background: "#0460D3" }} />
        <h2 className="modal-title">Reserva de citas en línea</h2>
        {loading ? (
          <p className="hint">Cargando…</p>
        ) : (
          <form onSubmit={handleSave}>
            <label className="checkbox-row booking-enable-row">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Activar la página pública de reservas para mis pacientes
            </label>

            {enabled && (
              <p className="hint" style={{ marginTop: 4 }}>
                Comparte este enlace con tus pacientes: <strong>{publicUrl}</strong>
              </p>
            )}

            <label className="booking-slot-duration">
              Duración de cada turno (minutos)
              <input
                type="number"
                min={5}
                max={240}
                value={slotMinutes}
                onChange={(e) => setSlotMinutes(e.target.value)}
              />
            </label>

            <h3 className="history-title" style={{ marginBottom: 6 }}>
              Horario de atención
            </h3>
            {/* Corrección solicitada por el usuario: el listado de días se
                veía como texto suelto, sin orden claro — ahora cada día es
                una fila con su propia tarjeta, alineada en columnas fijas
                (día · horarios · acciones), y se resalta suavemente cuando
                está activo, para que el médico elija su horario de forma
                más clara y profesional. */}
            <div className="booking-day-list">
              {DAYS.map(({ key, label }) => {
                const ranges = schedule[key] || [];
                const active = ranges.length > 0;
                return (
                  <div key={key} className={`booking-day-row${active ? " active" : ""}`}>
                    <label className="checkbox-row booking-day-label">
                      <input type="checkbox" checked={active} onChange={(e) => toggleDay(key, e.target.checked)} />
                      {label}
                    </label>
                    {active ? (
                      <div className="booking-day-ranges">
                        {ranges.map((range, idx) => (
                          <div key={idx} className="booking-range-row">
                            <input type="time" value={range[0]} onChange={(e) => updateRange(key, idx, 0, e.target.value)} />
                            <span className="booking-range-sep">a</span>
                            <input type="time" value={range[1]} onChange={(e) => updateRange(key, idx, 1, e.target.value)} />
                            {ranges.length > 1 && (
                              <button type="button" className="link-btn link-btn-danger" onClick={() => removeRange(key, idx)}>
                                Quitar
                              </button>
                            )}
                          </div>
                        ))}
                        <button type="button" className="link-btn booking-add-range" onClick={() => addRange(key)}>
                          + Agregar jornada de tarde
                        </button>
                      </div>
                    ) : (
                      <span className="booking-day-closed">Cerrado</span>
                    )}
                  </div>
                );
              })}
            </div>

            {error && <p className="form-error" style={{ marginTop: 12 }}>{error}</p>}
            {saved && (
              <p className="hint" style={{ color: "var(--accent)", marginTop: 12 }}>
                ✓ Guardado.
              </p>
            )}

            <div className="modal-actions">
              <button type="button" className="btn-ghost" onClick={onClose}>
                Cerrar
              </button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? "Guardando…" : "Guardar"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
