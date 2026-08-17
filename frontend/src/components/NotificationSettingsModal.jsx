import { useEffect, useState } from "react";
import { api } from "../api.js";

export default function NotificationSettingsModal({ onClose }) {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedMsg, setSavedMsg] = useState(false);

  useEffect(() => {
    api.notifications.getSettings().then(setSettings);
  }, []);

  if (!settings) return null;

  const set = (field) => (e) => {
    const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setSettings({ ...settings, [field]: value });
  };

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.notifications.updateSettings(settings);
      setSettings(updated);
      setSavedMsg(true);
      setTimeout(() => setSavedMsg(false), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-card" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-tab" style={{ background: "#2B5C8A" }} />
        <h2 className="modal-title">Envío automático de recetas y certificados</h2>
        <p className="hint">
          Al crear una receta o un certificado, se pueden enviar solos por WhatsApp y/o por el correo del paciente
          (el que esté guardado en su ficha). También puedes enviarlos manualmente después, con el botón "Enviar"
          en el historial del paciente.
        </p>

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <input type="checkbox" checked={Boolean(settings.auto_send_whatsapp)} onChange={set("auto_send_whatsapp")} />
          Enviar automáticamente por WhatsApp
        </label>
        <p className="hint" style={{ marginTop: -6, marginBottom: 14 }}>
          Usa el mismo número de WhatsApp Business configurado en "Recordatorios automáticos" (Twilio). Si esa
          configuración no tiene credenciales válidas, el envío por WhatsApp fallará silenciosamente — revisa esa
          sección primero.
        </p>

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <input type="checkbox" checked={Boolean(settings.auto_send_email)} onChange={set("auto_send_email")} />
          Enviar automáticamente por correo electrónico
        </label>

        <div style={{ background: "#f4f6fb", borderRadius: 10, padding: 14, marginTop: 6 }}>
          <strong style={{ fontSize: "0.85rem" }}>Correo saliente (SMTP)</strong>
          <p className="hint" style={{ marginTop: 4 }}>
            Ej. con Gmail: host <code>smtp.gmail.com</code>, puerto <code>587</code>, usuario tu correo completo, y
            en "Contraseña" una <em>contraseña de aplicación</em> (no la contraseña normal de la cuenta — Gmail la
            exige aparte para este tipo de conexión).
          </p>
          <div className="form-grid" style={{ marginTop: 10 }}>
            <label>
              Host SMTP
              <input value={settings.smtp_host || ""} onChange={set("smtp_host")} placeholder="smtp.gmail.com" />
            </label>
            <label>
              Puerto
              <input type="number" value={settings.smtp_port || 587} onChange={set("smtp_port")} />
            </label>
            <label className="span-2">
              Usuario / correo remitente
              <input value={settings.smtp_user || ""} onChange={set("smtp_user")} placeholder="tuconsultorio@gmail.com" />
            </label>
            <label className="span-2">
              Contraseña
              <input
                type="password"
                value={settings.smtp_pass || ""}
                onChange={set("smtp_pass")}
                placeholder={settings.has_smtp_pass ? "•••••••• (dejar así para no cambiarla)" : "Contraseña de aplicación"}
              />
            </label>
            <label>
              Nombre del remitente
              <input value={settings.smtp_from_name || ""} onChange={set("smtp_from_name")} placeholder="Consultorio Dr. García" />
            </label>
            <label>
              Correo del remitente
              <input value={settings.smtp_from_email || ""} onChange={set("smtp_from_email")} placeholder="tuconsultorio@gmail.com" />
            </label>
          </div>
        </div>

        {error && <p className="form-error" style={{ marginTop: 10 }}>{error}</p>}
        {savedMsg && <p className="hint" style={{ color: "#1f8a4c", marginTop: 10 }}>✓ Configuración guardada</p>}

        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn-ghost" onClick={onClose}>
            Cerrar
          </button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Guardando…" : "Guardar configuración"}
          </button>
        </div>
      </div>
    </div>
  );
}
