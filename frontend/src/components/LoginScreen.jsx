import { useState } from "react";
import { api, setToken } from "../api.js";
import Footer from "./Footer.jsx";

export default function LoginScreen({ onAuthenticated }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await api.auth.login({ username, password });
      setToken(result.token);
      onAuthenticated(result.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="folder-card auth-card">
        <div className="modal-tab" style={{ background: "#0460D3" }} />
        <div className="brand" style={{ marginBottom: 18 }}>
          <img src="/assets/logo.png" alt="MedicOs" className="brand-mark" />
          <div>
            <div className="brand-name"><span className="brand-medic">Medic</span><span className="brand-os">Os</span></div>
            <div className="brand-sub">Expediente &amp; Agenda</div>
          </div>
        </div>

        <h2 className="modal-title">Iniciar sesión</h2>
        <p className="hint" style={{ marginTop: -8, marginBottom: 14 }}>
          Si aún no tienes cuenta, pídele acceso al administrador de la plataforma.
        </p>

        <form onSubmit={handleSubmit} className="form-grid">
          <label className="span-2">
            Usuario
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </label>
          <label className="span-2">
            Contraseña
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>

          {error && <p className="form-error span-2">{error}</p>}

          <div className="modal-actions span-2" style={{ justifyContent: "stretch" }}>
            <button type="submit" className="btn-primary full" disabled={loading}>
              {loading ? "Un momento…" : "Entrar"}
            </button>
          </div>
        </form>
      </div>
      <Footer />
    </div>
  );
}
