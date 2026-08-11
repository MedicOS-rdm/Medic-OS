import { useEffect, useState } from "react";
import { api } from "../api.js";

export default function ReminderSettingsModal({ onClose }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);

  useEffect(() => {
    api.reminders.getSettings().then(setForm);
  }, []);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await api.reminders.updateSettings(form);
      setForm(updated);
      setSavedMsg(true);
      setTimeout(() => setSavedMsg(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  if (!form) return null;
  const usesTwilio = form.provider === "twilio_whatsapp" || form.provider === "twilio_sms";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-card rx-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tab" style={{ background: "#C08A3E" }} />
        <h2 className="modal-title">Recordatorios automáticos</h2>
        <p className="hint" style={{ marginTop: -8, marginBottom: 14 }}>
          Envía un mensaje antes de cada cita. Si el paciente responde <strong>1</strong>, la cita se
          confirma sola; si responde <strong>2</strong>, se cancela sola.
        </p>

        <form onSubmit={handleSubmit} className="form-grid">
          <label className="span-2">
            <span className="checkbox-row">
              <input
                type="checkbox"
                checked={Boolean(form.enabled)}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              Activar envío automático (revisa cada 15 min mientras el servidor esté corriendo)
            </span>
          </label>

          <label className="span-2">
            Proveedor
            <select value={form.provider} onChange={set("provider")}>
              <option value="simulado">Simulado (no envía nada real — solo para probar)</option>
              <option value="twilio_whatsapp">WhatsApp vía Twilio</option>
              <option value="twilio_sms">SMS vía Twilio</option>
            </select>
          </label>

          {form.provider === "simulado" && (
            <p className="hint span-2 rx-warning">
              En modo simulado, los recordatorios solo se registran en la consola del backend y en el
              historial — no llega ningún mensaje real al teléfono del paciente.
            </p>
          )}

          {usesTwilio && (
            <>
              <label className="span-2">
                Twilio Account SID
                <input value={form.twilio_account_sid} onChange={set("twilio_account_sid")} placeholder="ACxxxxxxxx…" />
              </label>
              <label className="span-2">
                Twilio Auth Token
                <input
                  type="password"
                  value={form.twilio_auth_token}
                  onChange={set("twilio_auth_token")}
                  placeholder={form.has_twilio_auth_token ? "•••••••• (ya guardado, deja igual para no cambiarlo)" : ""}
                />
              </label>
              <label className="span-2">
                Número de Twilio (remitente)
                <input value={form.twilio_from_number} onChange={set("twilio_from_number")} placeholder="+14155238886" />
              </label>
              <p className="hint span-2">
                Necesitas una cuenta de Twilio con un número habilitado para{" "}
                {form.provider === "twilio_whatsapp" ? "WhatsApp Business" : "SMS"}. El webhook de respuestas
                es: <code>/api/reminders/webhook</code> (configúralo en tu consola de Twilio).
              </p>
            </>
          )}

          <label>
            Horas de anticipación
            <input type="number" min="1" value={form.hours_before} onChange={set("hours_before")} />
          </label>

          <label className="span-2">
            Plantilla del mensaje
            <textarea rows={3} value={form.message_template} onChange={set("message_template")} />
          </label>
          <p className="hint span-2">
            Variables disponibles: <code>{"{paciente}"}</code> <code>{"{fecha}"}</code> <code>{"{hora}"}</code>{" "}
            <code>{"{consultorio}"}</code>
          </p>

          {savedMsg && <p className="saved-msg span-2">✓ Configuración guardada.</p>}

          <div className="modal-actions span-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cerrar
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? "Guardando…" : "Guardar configuración"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
