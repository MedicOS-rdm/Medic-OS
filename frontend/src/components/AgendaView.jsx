import { useState } from "react";
import { STATUS, NEXT_STATUS } from "../statusConfig.js";

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

export default function AgendaView({ appointments, loading, isMedico, onChangeStatus, onOpenRecord, onSendReminder }) {
  const [sendingId, setSendingId] = useState(null);
  const [sentFeedback, setSentFeedback] = useState({}); // { [apptId]: 'ok' | 'error' }

  async function handleSend(id) {
    setSendingId(id);
    try {
      await onSendReminder(id);
      setSentFeedback((prev) => ({ ...prev, [id]: "ok" }));
    } catch {
      setSentFeedback((prev) => ({ ...prev, [id]: "error" }));
    } finally {
      setSendingId(null);
    }
  }

  if (loading) {
    return <p className="empty-state">Cargando agenda…</p>;
  }

  if (appointments.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-title">No hay citas para este día.</p>
        <p>Usa “Nueva cita” para agendar la primera.</p>
      </div>
    );
  }

  return (
    <ol className="agenda-list">
      {appointments.map((appt) => {
        const status = STATUS[appt.status];
        const nextOptions = NEXT_STATUS[appt.status] || [];
        return (
          <li key={appt.id} className="folder-card appt-card" style={{ "--tab-color": status.color }}>
            <div className="modal-tab" style={{ background: status.color }} />
            <div className="appt-time">{formatTime(appt.start_time)}</div>
            <div className="appt-body">
              <div className="appt-header">
                <span className="appt-name">
                  {appt.first_name} {appt.last_name}
                </span>
                <span className="status-pill" style={{ color: status.color, borderColor: status.color }}>
                  {status.label}
                </span>
              </div>
              {appt.allergies && <div className="allergy-alert">⚠ Alergia: {appt.allergies}</div>}
              <div className="appt-meta">
                {appt.visit_type === "primera_vez" ? "Primera vez" : "Subsecuente"} · {appt.duration_minutes} min
                {appt.reason ? ` · ${appt.reason}` : ""}
              </div>

              {["programada", "confirmada"].includes(appt.status) && (
                <div className="reminder-row">
                  {appt.reminder_sent_at ? (
                    <span className="reminder-tag sent">✓ Recordatorio enviado</span>
                  ) : (
                    <button
                      type="button"
                      className="reminder-tag pending"
                      disabled={sendingId === appt.id}
                      onClick={() => handleSend(appt.id)}
                    >
                      {sendingId === appt.id ? "Enviando…" : "Enviar recordatorio"}
                    </button>
                  )}
                  {sentFeedback[appt.id] === "error" && <span className="hint" style={{ color: "var(--allergy)" }}>No se pudo enviar (¿tiene teléfono?)</span>}
                </div>
              )}
              {nextOptions.length > 0 && (
                <div className="appt-actions">
                  {nextOptions.map((s) => (
                    <button
                      key={s}
                      className="status-btn"
                      style={{ borderColor: STATUS[s].color, color: STATUS[s].color }}
                      onClick={() => onChangeStatus(appt.id, s)}
                    >
                      {STATUS[s].label}
                    </button>
                  ))}
                  {isMedico && (
                    <button className="btn-primary sm" onClick={() => onOpenRecord(appt.patient_id, appt.id)}>
                      Iniciar consulta
                    </button>
                  )}
                </div>
              )}
              {nextOptions.length === 0 && isMedico && (
                <div className="appt-actions">
                  <button className="btn-ghost sm" onClick={() => onOpenRecord(appt.patient_id, appt.id)}>
                    Ver expediente
                  </button>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
