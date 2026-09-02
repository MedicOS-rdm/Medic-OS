import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

const ROLE_LABELS = { medico: "Médico", secretaria: "Secretaria", enfermera: "Enfermera" };

export default function UsersModal({ onClose }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ username: "", password: "", full_name: "", role: "secretaria" });
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [error, setError] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef(null);
  const [resetting, setResetting] = useState(null); // id del usuario al que se le está generando clave
  const [tempPassword, setTempPassword] = useState(null); // { userId, username, password }
  const [copied, setCopied] = useState(false);

  // Nuevo rol "enfermera": el médico puede dar de alta como máximo UNA
  // cuenta de asistente por clínica, sea secretaria o enfermera (el
  // backend rechaza una segunda cuenta con 409 — aquí solo ocultamos el
  // formulario cuando ya existe, para que quede claro de entrada).
  const hasAssistant = users.some((u) => u.role === "secretaria" || u.role === "enfermera");

  async function load() {
    setLoading(true);
    try {
      setUsers(await api.users.list());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Mientras el usuario no haya tocado a mano el campo "Usuario", lo
  // autocompletamos a partir del nombre completo (ej. "Sofía López" ->
  // "sofia.lopez", o "sofia.lopez2" si ya existe).
  useEffect(() => {
    if (usernameTouched || !form.full_name.trim()) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const { suggestion: s } = await api.users.suggestUsername(form.full_name);
      if (s) setForm((f) => (f.username === "" || !usernameTouched ? { ...f, username: s } : f));
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [form.full_name, usernameTouched]);

  async function handleCreate(e) {
    e.preventDefault();
    setError(null);
    setSuggestion(null);
    setSaving(true);
    try {
      await api.users.create(form);
      setForm({ username: "", password: "", full_name: "", role: "secretaria" });
      setUsernameTouched(false);
      load();
    } catch (err) {
      setError(err.message);
      if (err.suggestion) setSuggestion(err.suggestion);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm("¿Eliminar esta cuenta de asistente?")) return;
    await api.users.remove(id);
    load();
  }

  async function handleEditName(u) {
    const nuevo = prompt("Nombre completo correcto:", u.full_name || "");
    if (nuevo === null) return; // canceló
    if (!nuevo.trim()) return;
    await api.users.update(u.id, { full_name: nuevo.trim() });
    load();
  }

  async function handleResetPassword(u) {
    if (!confirm(`¿Generar una nueva clave temporal para ${u.full_name}? La clave actual dejará de funcionar.`)) return;
    setResetting(u.id);
    setCopied(false);
    try {
      const result = await api.users.resetPassword(u.id);
      setTempPassword({ userId: u.id, username: result.username, password: result.password });
    } finally {
      setResetting(null);
    }
  }

  async function handleCopyTempPassword() {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Si el navegador bloquea el portapapeles, al menos la clave sigue
      // visible en pantalla para copiarla a mano.
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tab" style={{ background: "#5B6B5F" }} />
        <h2 className="modal-title">Usuarios del sistema</h2>

        {loading ? (
          <p className="hint">Cargando…</p>
        ) : (
          <ul className="user-list">
            {users.map((u) => (
              <li key={u.id}>
                <div>
                  <strong>{u.full_name}</strong>
                  <span className="user-role-tag">{ROLE_LABELS[u.role] || u.role}</span>
                  <div className="hint">@{u.username}</div>
                </div>
                {u.role !== "medico" && (
                  <div style={{ display: "flex", gap: 10 }}>
                    <button type="button" className="link-btn" onClick={() => handleEditName(u)}>
                      Editar nombre
                    </button>
                    <button
                      type="button"
                      className="link-btn"
                      disabled={resetting === u.id}
                      onClick={() => handleResetPassword(u)}
                    >
                      {resetting === u.id ? "Generando…" : "Nueva clave temporal"}
                    </button>
                    <button type="button" className="link-btn" onClick={() => handleDelete(u.id)}>
                      Eliminar
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {tempPassword && (
          <p className="hint" style={{ background: "#e1eafb", padding: "10px 12px", borderRadius: 8, marginTop: -4 }}>
            Clave temporal para <strong>@{tempPassword.username}</strong>: <code>{tempPassword.password}</code>{" "}
            <button type="button" className="link-btn" onClick={handleCopyTempPassword}>
              {copied ? "¡Copiada!" : "Copiar"}
            </button>
            <br />
            Compártela con la secretaria; ella podrá cambiarla desde "Cambiar contraseña" al iniciar sesión.
          </p>
        )}

        <h3 className="history-title">Nueva cuenta de asistente</h3>
        <p className="hint" style={{ marginTop: -8, marginBottom: 10 }}>
          Puedes agregar una sola cuenta de asistente por consultorio: secretaria (agenda y datos generales) o
          enfermera (agenda, y además puede registrar signos vitales, alergias y antecedentes patológicos).
        </p>
        {hasAssistant ? (
          <p className="hint" style={{ background: "#e1eafb", padding: "10px 12px", borderRadius: 8 }}>
            Ya tienes una cuenta de asistente activa. Elimínala primero si quieres dar de alta una de otro tipo.
          </p>
        ) : (
          <form onSubmit={handleCreate} className="form-grid">
            <label className="span-2">
              Tipo de cuenta
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="secretaria">Secretaria</option>
                <option value="enfermera">Enfermera</option>
              </select>
            </label>
            <label className="span-2">
              Nombre completo
              <input
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                placeholder="Sofía López"
              />
            </label>
            <label>
              Usuario
              <input
                value={form.username}
                onChange={(e) => {
                  setUsernameTouched(true);
                  setForm({ ...form, username: e.target.value });
                }}
              />
            </label>
            <label>
              Contraseña
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="Mín. 6 caracteres"
              />
            </label>

            {error && (
              <p className="form-error span-2">
                {error}
                {suggestion && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        setForm((f) => ({ ...f, username: suggestion }));
                        setUsernameTouched(true);
                        setError(null);
                        setSuggestion(null);
                      }}
                    >
                      Usar "{suggestion}"
                    </button>
                  </>
                )}
              </p>
            )}

            <div className="modal-actions span-2">
              <button type="button" className="btn-ghost" onClick={onClose}>
                Cerrar
              </button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? "Creando…" : "Crear cuenta"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
