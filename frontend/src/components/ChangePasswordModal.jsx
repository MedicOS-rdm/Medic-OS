import { useState } from "react";
import { api } from "../api.js";

// Disponible para cualquier usuario logueado (médico o secretaria). Sirve
// sobre todo para que la secretaria reemplace la clave temporal que le dio
// el médico al crear su cuenta, pero también permite al médico cambiar la
// suya propia.
export default function ChangePasswordModal({ onClose }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 6) {
      setError("La nueva contraseña debe tener al menos 6 caracteres.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Las contraseñas nuevas no coinciden.");
      return;
    }
    setSaving(true);
    try {
      await api.auth.changePassword({ current_password: currentPassword, new_password: newPassword });
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tab" style={{ background: "#2B5C8A" }} />
        <h2 className="modal-title">Cambiar contraseña</h2>

        {done ? (
          <div className="rx-success">
            <p>✓ Tu contraseña se actualizó correctamente.</p>
            <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
              <button className="btn-primary" onClick={onClose}>
                Cerrar
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="form-grid">
            <label className="span-2">
              Contraseña actual
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoFocus
              />
            </label>
            <label>
              Contraseña nueva
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Mín. 6 caracteres"
              />
            </label>
            <label>
              Confirmar contraseña nueva
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            </label>

            {error && <p className="form-error span-2">{error}</p>}

            <div className="modal-actions span-2">
              <button type="button" className="btn-ghost" onClick={onClose}>
                Cancelar
              </button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? "Guardando…" : "Cambiar contraseña"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
